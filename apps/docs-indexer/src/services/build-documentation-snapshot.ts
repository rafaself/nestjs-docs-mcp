import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  DocumentationCorpus,
  DocumentationIdentity,
  DocumentationSnapshot,
  DocumentationSourceProvenance,
  DocumentationVersion,
  NormalizedDocument,
  SourceDocument,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import {
  DocumentationCorpusSchema,
  DocumentationSnapshotSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import type { DocumentationDocumentTransformer } from '@nestjs-docs/documentation-engine/application/contracts/documentation-transformer.contract.js';
import { ingestSnapshot } from '@nestjs-docs/documentation-engine/application/services/documentation-ingestion.service.js';
import {
  DOCUMENT_CHUNKING_ALGORITHM_VERSION,
  DOCUMENT_NORMALIZATION_ALGORITHM_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import {
  MARKDOWN_PARSER_VERSION,
  type MarkdownDiagnostic,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { validateDocumentationIndex } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-integrity.js';
import {
  DOCUMENTATION_BUILD_MANIFEST_VERSION,
  DocumentationBuildManifestSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';

const CORPUS_FILENAME = 'corpus.json';
const INDEX_FILENAME = 'index.sqlite';
const MANIFEST_FILENAME = 'manifest.json';

export type DocumentationBuildMode = 'clean' | 'incremental';

export interface DocumentationBuildChanges {
  added: number;
  modified: number;
  unchanged: number;
  removed: number;
}

interface DocumentationPipelineMetadata {
  parserVersion: number;
  transformerVersion: number;
  normalizationAlgorithmVersion: number;
  chunkingAlgorithmVersion: number;
  maxChunkChars: number;
  indexSchemaVersion: number;
  indexFormatVersion: number;
}

interface PreviousDocumentationBuild {
  directory: string;
  corpus: DocumentationCorpus;
  pipelineMatches: boolean;
}

export interface DocumentationBuildDiagnostic extends MarkdownDiagnostic {
  path: string;
}

export interface DocumentationBuildSummary {
  id: string;
  version: DocumentationVersion;
  sourceRevision: string;
  outputDirectory: string;
  documentCount: number;
  chunkCount: number;
  diagnostics: DocumentationBuildDiagnostic[];
  mode: DocumentationBuildMode;
  changes: DocumentationBuildChanges;
  cleanupWarning?: string;
}

export interface DocumentationSnapshotBuildRequest {
  identity: DocumentationIdentity;
  snapshot: DocumentationSnapshot;
  transformDocument: DocumentationDocumentTransformer;
  transformerVersion: number;
  outputDirectory: string;
  previousOutputDirectory?: string;
  mode?: DocumentationBuildMode;
  maxChunkChars?: number;
  diagnostics?: DocumentationBuildDiagnostic[];
}

/** Incrementally reuse validated prior documents and index rows, then promote. */
export async function buildDocumentationSnapshot(
  request: DocumentationSnapshotBuildRequest,
): Promise<DocumentationBuildSummary> {
  const snapshot = DocumentationSnapshotSchema.parse(request.snapshot);
  if (request.identity.version !== snapshot.version) {
    throw new Error(
      'Documentation identity version must match the source snapshot',
    );
  }
  const maxChunkChars = request.maxChunkChars ?? 4000;
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error('maxChunkChars must be a positive integer');
  }
  if (
    !Number.isSafeInteger(request.transformerVersion) ||
    request.transformerVersion < 1
  ) {
    throw new Error('transformerVersion must be a positive integer');
  }
  const mode = request.mode ?? 'incremental';
  if (mode !== 'clean' && mode !== 'incremental') {
    throw new Error('Build mode must be "clean" or "incremental"');
  }
  const outputDirectory = await prepareDocumentationOutputDirectory(
    request.outputDirectory,
    snapshot.source.kind === 'local' ? snapshot.source.root : undefined,
  );
  const pipeline: DocumentationPipelineMetadata = {
    parserVersion: MARKDOWN_PARSER_VERSION,
    transformerVersion: request.transformerVersion,
    normalizationAlgorithmVersion: DOCUMENT_NORMALIZATION_ALGORITHM_VERSION,
    chunkingAlgorithmVersion: DOCUMENT_CHUNKING_ALGORITHM_VERSION,
    maxChunkChars,
    indexSchemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
    indexFormatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
  };
  const previous =
    mode === 'incremental'
      ? await loadPreviousBuild(
          request.previousOutputDirectory ?? outputDirectory,
          request.identity,
          snapshot.source,
          pipeline,
        )
      : undefined;
  const previousByPath = new Map(
    previous?.corpus.documents.map((document) => [
      document.source.path,
      document,
    ]) ?? [],
  );
  const changes = determineBuildChanges(
    snapshot.documents,
    previousByPath,
    previous?.pipelineMatches ?? false,
  );
  const corpus = ingestSnapshot(
    snapshot,
    request.transformDocument,
    maxChunkChars,
    {
      reuseDocument: (file, source) => {
        if (!previous?.pipelineMatches) return undefined;
        const cached = previousByPath.get(file.path);
        if (
          !cached ||
          cached.version !== file.version ||
          cached.canonicalUrl !== file.canonicalUrl ||
          cached.source.contentHash !== sha256(file.markdown)
        ) {
          return undefined;
        }
        return reuseNormalizedDocument(cached, file, source);
      },
    },
  );
  const stagingDirectory = await mkdtemp(
    join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-`),
  );

  try {
    const corpusPath = join(stagingDirectory, CORPUS_FILENAME);
    const indexPath = join(stagingDirectory, INDEX_FILENAME);
    const manifestPath = join(stagingDirectory, MANIFEST_FILENAME);
    const corpusContents = `${JSON.stringify(corpus, null, 2)}\n`;
    await writeFile(corpusPath, corpusContents, 'utf8');

    if (previous?.pipelineMatches) {
      await copyFile(join(previous.directory, INDEX_FILENAME), indexPath);
    }

    const writer = new DocumentationIndexWriter(
      indexPath,
      request.identity.version,
    );
    try {
      writer.indexCorpus(corpus);
    } finally {
      writer.close();
    }

    const { documentCount, chunkCount } = validateDocumentationIndex(
      request.identity.version,
      corpus,
      indexPath,
    );
    const manifest = DocumentationBuildManifestSchema.parse({
      manifestVersion: DOCUMENTATION_BUILD_MANIFEST_VERSION,
      documentation: request.identity,
      source: corpus.source,
      pipeline,
      corpus: {
        file: CORPUS_FILENAME,
        sha256: sha256(corpusContents),
        documentCount,
        documents: [...corpus.documents]
          .sort((left, right) =>
            compareStrings(left.source.path, right.source.path),
          )
          .map((document) => ({
            id: document.id,
            path: document.source.path,
            sourceContentHash: document.source.contentHash,
            normalizedContentHash: document.contentHash,
          })),
      },
      index: {
        file: INDEX_FILENAME,
        sha256: await sha256File(indexPath),
        documentationVersion: request.identity.version,
        sourceRevision: corpus.source.revision,
        schemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
        formatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
        documentCount,
        chunkCount,
      },
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const cleanupWarning = await promoteDocumentationOutput(
      stagingDirectory,
      outputDirectory,
    );

    return {
      id: request.identity.id,
      version: request.identity.version,
      sourceRevision: corpus.source.revision,
      outputDirectory,
      documentCount,
      chunkCount,
      diagnostics: request.diagnostics ?? [],
      mode,
      changes,
      ...(cleanupWarning && { cleanupWarning }),
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function loadPreviousBuild(
  directory: string,
  identity: DocumentationIdentity,
  source: DocumentationSourceProvenance,
  pipeline: DocumentationPipelineMetadata,
): Promise<PreviousDocumentationBuild | undefined> {
  try {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return undefined;
    }
    const manifestPath = join(directory, MANIFEST_FILENAME);
    const corpusPath = join(directory, CORPUS_FILENAME);
    const indexPath = join(directory, INDEX_FILENAME);
    for (const path of [manifestPath, corpusPath, indexPath]) {
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) return undefined;
    }

    const manifest = DocumentationBuildManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
    );
    if (
      !isDeepStrictEqual(manifest.documentation, identity) ||
      !sameSourceIdentity(manifest.source, source)
    ) {
      return undefined;
    }

    const corpusBytes = await readFile(corpusPath);
    if (sha256(corpusBytes) !== manifest.corpus.sha256) return undefined;
    const corpus = DocumentationCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')) as unknown,
    );
    if (
      corpus.version !== identity.version ||
      !isDeepStrictEqual(corpus.source, manifest.source) ||
      !isDeepStrictEqual(
        [...corpus.documents]
          .sort((left, right) =>
            compareStrings(left.source.path, right.source.path),
          )
          .map((document) => ({
            id: document.id,
            path: document.source.path,
            sourceContentHash: document.source.contentHash,
            normalizedContentHash: document.contentHash,
          })),
        manifest.corpus.documents,
      )
    ) {
      return undefined;
    }
    if (
      (await sha256File(indexPath)) !== manifest.index.sha256 ||
      manifest.index.documentationVersion !== identity.version
    ) {
      return undefined;
    }

    const indexFormatMatches =
      manifest.index.schemaVersion === DOCUMENTATION_INDEX_SCHEMA_VERSION &&
      manifest.index.formatVersion === DOCUMENTATION_INDEX_FORMAT_VERSION;
    if (!indexFormatMatches) {
      return { directory, corpus, pipelineMatches: false };
    }

    const validated = validateDocumentationIndex(
      identity.version,
      corpus,
      indexPath,
    );
    if (
      validated.documentCount !== manifest.corpus.documentCount ||
      validated.documentCount !== manifest.index.documentCount ||
      validated.chunkCount !== manifest.index.chunkCount ||
      manifest.index.sourceRevision !== corpus.source.revision
    ) {
      return undefined;
    }

    return {
      directory,
      corpus,
      pipelineMatches: isDeepStrictEqual(manifest.pipeline, pipeline),
    };
  } catch {
    // An invalid or unreadable prior build is never trusted. The caller makes
    // a clean build and only replaces it after the new output validates.
    return undefined;
  }
}

function sameSourceIdentity(
  previous: DocumentationSourceProvenance,
  current: DocumentationSourceProvenance,
): boolean {
  if (previous.kind !== current.kind) return false;
  return previous.kind === 'local' && current.kind === 'local'
    ? previous.root === current.root
    : previous.kind === 'git' &&
        current.kind === 'git' &&
        previous.repository === current.repository;
}

function determineBuildChanges(
  files: SourceDocument[],
  previousByPath: ReadonlyMap<string, NormalizedDocument>,
  pipelineMatches: boolean,
): DocumentationBuildChanges {
  const changes: DocumentationBuildChanges = {
    added: 0,
    modified: 0,
    unchanged: 0,
    removed: 0,
  };
  const currentPaths = new Set<string>();
  for (const file of files) {
    currentPaths.add(file.path);
    const previous = previousByPath.get(file.path);
    if (!previous) {
      changes.added++;
    } else if (
      !pipelineMatches ||
      previous.version !== file.version ||
      previous.canonicalUrl !== file.canonicalUrl ||
      previous.source.contentHash !== sha256(file.markdown)
    ) {
      changes.modified++;
    } else {
      changes.unchanged++;
    }
  }
  changes.removed = [...previousByPath.keys()].filter(
    (path) => !currentPaths.has(path),
  ).length;
  return changes;
}

function reuseNormalizedDocument(
  cached: NormalizedDocument,
  file: SourceDocument,
  source: DocumentationSourceProvenance,
): NormalizedDocument {
  return {
    ...cached,
    source: {
      ...cached.source,
      provenance: source,
      path: file.path,
      location: file.sourceLocation,
      contentHash: sha256(file.markdown),
    },
    chunks: cached.chunks.map((chunk) => ({
      ...chunk,
      sourceRevision: source.revision,
    })),
  };
}

/** Resolve an output path and reject unsafe or source-overlapping destinations. */
export async function prepareDocumentationOutputDirectory(
  configuredPath: string,
  protectedInputRoot?: string,
): Promise<string> {
  const requestedPath = resolve(configuredPath);
  if (protectedInputRoot && pathsOverlap(protectedInputRoot, requestedPath)) {
    throw new Error(
      'The output directory must not contain or be inside the input directory',
    );
  }

  const parent = dirname(requestedPath);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const outputDirectory = resolve(realParent, basename(requestedPath));
  if (protectedInputRoot && pathsOverlap(protectedInputRoot, outputDirectory)) {
    throw new Error(
      'The output directory must not contain or be inside the input directory',
    );
  }

  try {
    const existing = await lstat(outputDirectory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(
        `Output path must be a directory and cannot be a symbolic link: "${outputDirectory}"`,
      );
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return outputDirectory;
    throw error;
  }
  return outputDirectory;
}

/** Replace an output directory and restore its previous contents on failure. */
export async function promoteDocumentationOutput(
  stagingDirectory: string,
  outputDirectory: string,
): Promise<string | undefined> {
  let backupDirectory: string | undefined;
  try {
    await lstat(outputDirectory);
    backupDirectory = join(
      dirname(outputDirectory),
      `.${basename(outputDirectory)}.backup-${randomUUID()}`,
    );
    await rename(outputDirectory, backupDirectory);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }

  try {
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    if (backupDirectory) {
      try {
        await rename(backupDirectory, outputDirectory);
        backupDirectory = undefined;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Unable to promote the validated build or restore previous output. Previous output remains at "${backupDirectory}"`,
          { cause: restoreError },
        );
      }
    }
    throw new Error(
      `Unable to promote the validated documentation build to "${outputDirectory}"`,
      { cause: error },
    );
  }

  if (backupDirectory) {
    try {
      await rm(backupDirectory, { recursive: true, force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `Unable to remove previous build backup "${backupDirectory}": ${reason}`;
    }
  }
  return undefined;
}

function pathsOverlap(root: string, candidate: string): boolean {
  return isWithin(root, candidate) || isWithin(candidate, root);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, {
    highWaterMark: 64 * 1024,
  })) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error(`Unable to hash binary index file "${path}"`);
    }
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code
  );
}
