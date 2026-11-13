import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { validateDocumentationIndex } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-integrity.js';
import { SUPPORTED_DOCUMENTATION_VERSIONS } from '../../apps/docs-indexer/dist/integrations/nestjs/version/documentation-version.js';
import { ingestNestJsDocumentation } from '../../apps/docs-indexer/dist/integrations/nestjs/documentation.integration.js';
import {
  resolveDocumentationSource,
  REPOSITORY,
} from '../../apps/docs-indexer/dist/integrations/nestjs/github/documentation-source.js';
import { writeDocumentationCorpus } from '@nestjs-docs/documentation-engine/infrastructure/filesystem/documentation-corpus-store.js';
import {
  DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
  DocumentationIndexRuntimeManifestSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';

const INDEX_PIPELINE_VERSION = 2;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  const outputDirectory = resolve(argument('--output', 'data/index-sync'));
  const previousDirectoryValue = argument('--previous', undefined);
  const resultFileValue = argument('--result-file', undefined);

  if (await pathExists(outputDirectory)) {
    throw new Error(`Output directory already exists: ${outputDirectory}`);
  }
  await mkdir(outputDirectory, { recursive: true });

  const previous = previousDirectoryValue
    ? await loadPreviousBundle(resolve(previousDirectoryValue))
    : undefined;
  const versionEntries = {};
  let changed = !previous || !previous.isReusable;

  for (const version of SUPPORTED_DOCUMENTATION_VERSIONS) {
    const key = String(version);
    const prefix = `documentation-v${version}`;
    const corpusPath = join(outputDirectory, `${prefix}.json`);
    const databasePath = join(outputDirectory, `${prefix}.sqlite`);
    const source = await resolveDocumentationSource(version);
    const previousVersion = previous?.manifest.versions[key];
    const previousFiles = previousDirectoryValue
      ? [
          join(resolve(previousDirectoryValue), `${prefix}.json`),
          join(resolve(previousDirectoryValue), `${prefix}.sqlite`),
        ]
      : [];
    const canReuse =
      previous?.isReusable === true &&
      previousVersion?.revision === source.revision &&
      previousVersion?.ref === source.ref &&
      (await Promise.all(previousFiles.map(pathExists))).every(Boolean);

    if (canReuse) {
      await Promise.all([
        copyFile(previousFiles[0], corpusPath),
        copyFile(previousFiles[1], databasePath),
      ]);
      console.error(`NestJS v${version}: source unchanged; reusing index`);
    } else {
      changed = true;
      if (
        previous?.isReusable &&
        previousFiles.length === 2 &&
        (await pathExists(previousFiles[1]))
      ) {
        await copyFile(previousFiles[1], databasePath);
      }

      const { snapshot, corpus } = await ingestNestJsDocumentation(version);
      await writeDocumentationCorpus(corpus, corpusPath);

      const index = new DocumentationIndexWriter(databasePath, version);
      try {
        index.indexCorpus(corpus);
      } finally {
        index.close();
      }
      console.error(
        `NestJS v${version}: synchronized source revision ${snapshot.source.revision}`,
      );
    }

    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    const validated = validateDocumentationIndex(version, corpus, databasePath);
    versionEntries[key] = {
      version,
      ref: corpus.source.ref,
      revision: corpus.source.revision,
      documentCount: validated.documentCount,
      chunkCount: validated.chunkCount,
      sourceContentHashes: Object.fromEntries(
        corpus.documents.map((document) => [
          document.id,
          document.source.contentHash,
        ]),
      ),
      normalizedContentHashes: Object.fromEntries(
        corpus.documents.map((document) => [document.id, document.contentHash]),
      ),
      corpusSha256: await hashFile(corpusPath),
      indexSha256: await hashFile(databasePath),
    };
    const runtimeManifest = DocumentationIndexRuntimeManifestSchema.parse({
      manifestVersion: DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
      documentation: { id: REPOSITORY, version: key },
      source: {
        kind: 'git',
        repository: REPOSITORY,
        ref: corpus.source.ref,
        revision: corpus.source.revision,
      },
      index: {
        file: `${prefix}.sqlite`,
        sha256: versionEntries[key].indexSha256,
        documentationVersion: key,
        sourceRevision: corpus.source.revision,
        schemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
        formatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
        documentCount: validated.documentCount,
        chunkCount: validated.chunkCount,
      },
    });
    await writeFile(
      join(outputDirectory, `${prefix}.manifest.json`),
      `${JSON.stringify(runtimeManifest, null, 2)}\n`,
      'utf8',
    );
  }

  const manifest = {
    formatVersion: 1,
    indexPipelineVersion: INDEX_PIPELINE_VERSION,
    repository: REPOSITORY,
    versions: versionEntries,
  };
  await writeFile(
    join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const result = {
    changed,
    outputDirectory,
    versions: Object.fromEntries(
      SUPPORTED_DOCUMENTATION_VERSIONS.map((version) => [
        version,
        {
          ref: versionEntries[String(version)].ref,
          revision: versionEntries[String(version)].revision,
        },
      ]),
    ),
  };
  if (resultFileValue) {
    await writeFile(
      resolve(resultFileValue),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
  }
  console.log(JSON.stringify(result));
}

async function loadPreviousBundle(directory) {
  const manifestPath = join(directory, 'manifest.json');
  if (!(await pathExists(manifestPath))) return undefined;

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const isReusable =
    manifest.formatVersion === 1 &&
    manifest.indexPipelineVersion === INDEX_PIPELINE_VERSION &&
    manifest.repository === REPOSITORY;
  if (!isReusable) return { manifest, isReusable: false };

  for (const version of SUPPORTED_DOCUMENTATION_VERSIONS) {
    const key = String(version);
    const entry = manifest.versions?.[key];
    const prefix = `documentation-v${version}`;
    const corpusPath = join(directory, `${prefix}.json`);
    const databasePath = join(directory, `${prefix}.sqlite`);
    if (
      !entry ||
      entry.version !== version ||
      !(await pathExists(corpusPath)) ||
      !(await pathExists(databasePath)) ||
      (await hashFile(corpusPath)) !== entry.corpusSha256 ||
      (await hashFile(databasePath)) !== entry.indexSha256
    ) {
      throw new Error(
        `Previous NestJS v${version} index bundle failed validation`,
      );
    }
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    validateDocumentationIndex(version, corpus, databasePath);
  }
  return { manifest, isReusable: true };
}

async function hashFile(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
