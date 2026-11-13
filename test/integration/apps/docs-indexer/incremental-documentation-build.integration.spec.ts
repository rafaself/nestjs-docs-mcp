import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildDocumentationSnapshot } from '@nestjs-docs/docs-indexer/services/build-documentation-snapshot.js';
import type {
  DocumentationIdentity,
  DocumentationSnapshot,
  NormalizedDocument,
  SourceDocument,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { DocumentationBuildManifestSchema } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import {
  createStableDocumentId,
  normalizeAndChunkDocument,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import { parseMarkdown } from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';

describe('incremental documentation build', () => {
  let workspace: string;
  let incrementalDirectory: string;
  let cleanDirectory: string;
  const identity: DocumentationIdentity = {
    id: 'incremental-guide',
    version: 'preview-7',
  };
  type InputDocument = Pick<
    SourceDocument,
    'id' | 'path' | 'canonicalUrl' | 'sourceLocation' | 'markdown'
  >;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'incremental-doc-build-'));
    incrementalDirectory = join(workspace, 'incremental');
    cleanDirectory = join(workspace, 'clean');
  });

  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('reuses unchanged documents on no-op builds and matches a clean build', async () => {
    const snapshot = makeSnapshot('source-a', [
      document('alpha.md', '# Alpha\n\nalpha ember marker.'),
      document('beta.md', '# Beta\n\nbeta velvet marker.'),
    ]);
    const firstTransformCalls: string[] = [];
    const first = await build(
      incrementalDirectory,
      snapshot,
      firstTransformCalls,
    );
    expect(first.changes).toEqual({
      added: 2,
      modified: 0,
      unchanged: 0,
      removed: 0,
    });
    expect(firstTransformCalls).toEqual(['alpha.md', 'beta.md']);
    const firstCorpus = await readFile(
      join(incrementalDirectory, 'corpus.json'),
      'utf8',
    );
    const firstSearch = searchResults(incrementalDirectory, [
      'ember',
      'velvet',
    ]);

    const noOpTransformCalls: string[] = [];
    const noOp = await build(
      incrementalDirectory,
      snapshot,
      noOpTransformCalls,
    );
    expect(noOp.changes).toEqual({
      added: 0,
      modified: 0,
      unchanged: 2,
      removed: 0,
    });
    expect(noOpTransformCalls).toEqual([]);
    expect(
      await readFile(join(incrementalDirectory, 'corpus.json'), 'utf8'),
    ).toBe(firstCorpus);
    expect(searchResults(incrementalDirectory, ['ember', 'velvet'])).toEqual(
      firstSearch,
    );

    const cleanTransformCalls: string[] = [];
    await build(cleanDirectory, snapshot, cleanTransformCalls, {
      mode: 'clean',
    });
    expect(cleanTransformCalls).toEqual(['alpha.md', 'beta.md']);
    expect(await readCorpus(incrementalDirectory)).toEqual(
      await readCorpus(cleanDirectory),
    );
    expect(searchResults(incrementalDirectory, ['ember', 'velvet'])).toEqual(
      searchResults(cleanDirectory, ['ember', 'velvet']),
    );
  });

  it('detects additions, modifications, unchanged files, and deletions', async () => {
    await build(
      incrementalDirectory,
      makeSnapshot('source-a', [
        document('alpha.md', '# Alpha\n\nalpha unchangedneedle.'),
        document('beta.md', '# Beta\n\nbeta oldneedle.'),
        document('gamma.md', '# Gamma\n\ngamma removedneedle.'),
      ]),
      [],
    );
    const previousAlphaRowIds = indexedRowIds(
      incrementalDirectory,
      documentIdFor('alpha.md'),
    );

    const nextSnapshot = makeSnapshot('source-b', [
      document('alpha.md', '# Alpha\n\nalpha unchangedneedle.'),
      document('beta.md', '# Beta\n\nbeta changedneedle.'),
      document('delta.md', '# Delta\n\ndelta addedneedle.'),
    ]);
    const transformCalls: string[] = [];
    const incremental = await build(
      incrementalDirectory,
      nextSnapshot,
      transformCalls,
    );
    expect(incremental.changes).toEqual({
      added: 1,
      modified: 1,
      unchanged: 1,
      removed: 1,
    });
    expect(transformCalls).toEqual(['beta.md', 'delta.md']);
    expect(
      indexedRowIds(incrementalDirectory, documentIdFor('alpha.md')),
    ).toEqual(previousAlphaRowIds);
    expect(
      searchResults(incrementalDirectory, ['changedneedle'])[0],
    ).toHaveLength(1);
    expect(
      searchResults(incrementalDirectory, ['addedneedle'])[0],
    ).toHaveLength(1);
    expect(
      searchResults(incrementalDirectory, ['removedneedle'])[0],
    ).toHaveLength(0);

    await build(cleanDirectory, nextSnapshot, [], { mode: 'clean' });
    expect(await readCorpus(incrementalDirectory)).toEqual(
      await readCorpus(cleanDirectory),
    );
    expect(
      searchResults(incrementalDirectory, [
        'unchangedneedle',
        'changedneedle',
        'addedneedle',
        'removedneedle',
      ]),
    ).toEqual(
      searchResults(cleanDirectory, [
        'unchangedneedle',
        'changedneedle',
        'addedneedle',
        'removedneedle',
      ]),
    );
  });

  it.each([
    'parserVersion',
    'transformerVersion',
    'normalizationAlgorithmVersion',
    'chunkingAlgorithmVersion',
    'maxChunkChars',
    'indexSchemaVersion',
    'indexFormatVersion',
  ] as const)('reprocesses every document when %s changes', async (field) => {
    const snapshot = makeSnapshot('source-a', [
      document('alpha.md', '# Alpha\n\nalpha pipeline.'),
      document('beta.md', '# Beta\n\nbeta pipeline.'),
    ]);
    await build(incrementalDirectory, snapshot, []);

    const manifestPath = join(incrementalDirectory, 'manifest.json');
    const manifest = DocumentationBuildManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    );
    const index = { ...manifest.index };
    if (field === 'indexSchemaVersion') index.schemaVersion++;
    if (field === 'indexFormatVersion') index.formatVersion++;
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          index,
          pipeline: {
            ...manifest.pipeline,
            [field]: manifest.pipeline[field] + 1,
          },
        },
        null,
        2,
      )}\n`,
    );

    const transformCalls: string[] = [];
    const rebuilt = await build(incrementalDirectory, snapshot, transformCalls);
    expect(transformCalls).toEqual(['alpha.md', 'beta.md']);
    expect(rebuilt.changes).toEqual({
      added: 0,
      modified: 2,
      unchanged: 0,
      removed: 0,
    });
    const updatedManifest = DocumentationBuildManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    );
    expect(updatedManifest.pipeline[field]).toBe(manifest.pipeline[field]);
  });

  it('rejects a corrupt prior index and rebuilds without reusing it', async () => {
    const snapshot = makeSnapshot('source-a', [
      document('alpha.md', '# Alpha\n\nalpha integrity marker.'),
    ]);
    await build(incrementalDirectory, snapshot, []);
    await appendFile(
      join(incrementalDirectory, 'index.sqlite'),
      Buffer.from([1, 2, 3]),
    );

    const transformCalls: string[] = [];
    const rebuilt = await build(incrementalDirectory, snapshot, transformCalls);
    expect(transformCalls).toEqual(['alpha.md']);
    expect(rebuilt.changes).toEqual({
      added: 1,
      modified: 0,
      unchanged: 0,
      removed: 0,
    });
    expect(searchResults(incrementalDirectory, ['integrity'])[0]).toHaveLength(
      1,
    );
  });

  it('leaves the previous output untouched when transformation fails', async () => {
    const original = makeSnapshot('source-a', [
      document('alpha.md', '# Alpha\n\nalpha original marker.'),
    ]);
    await build(incrementalDirectory, original, []);
    const previousFiles = await readBuildFiles(incrementalDirectory);
    const changed = makeSnapshot('source-b', [
      document('alpha.md', '# Alpha\n\nalpha broken marker.'),
    ]);

    await expect(
      build(incrementalDirectory, changed, [], {
        transformDocument: () => {
          throw new Error('synthetic transform failure');
        },
      }),
    ).rejects.toThrow('synthetic transform failure');
    expect(await readBuildFiles(incrementalDirectory)).toEqual(previousFiles);
  });

  async function build(
    outputDirectory: string,
    snapshot: DocumentationSnapshot,
    transformCalls: string[],
    options: {
      mode?: 'clean' | 'incremental';
      transformDocument?: (
        file: SourceDocument,
        source: DocumentationSnapshot['source'],
        maxChunkChars: number,
      ) => NormalizedDocument;
    } = {},
  ) {
    return buildDocumentationSnapshot({
      identity,
      snapshot,
      transformerVersion: 1,
      transformDocument:
        options.transformDocument ??
        ((file, source, maxChunkChars) => {
          transformCalls.push(file.path);
          return normalizeAndChunkDocument(
            file,
            source,
            parseMarkdown(file.markdown, { path: file.path }),
            { identity, maxChunkChars },
          );
        }),
      outputDirectory,
      mode: options.mode,
      maxChunkChars: 4000,
    });
  }

  async function readCorpus(directory: string): Promise<unknown> {
    return JSON.parse(await readFile(join(directory, 'corpus.json'), 'utf8'));
  }

  async function readBuildFiles(directory: string): Promise<Buffer[]> {
    return Promise.all(
      ['corpus.json', 'index.sqlite', 'manifest.json'].map((filename) =>
        readFile(join(directory, filename)),
      ),
    );
  }

  function searchResults(directory: string, queries: string[]) {
    const service = new TestDocumentationSearchService(
      join(directory, 'index.sqlite'),
      identity.version,
    );
    try {
      return queries.map((query) => service.search(query, 10));
    } finally {
      service.onModuleDestroy();
    }
  }

  function indexedRowIds(directory: string, documentId: string): unknown[] {
    const database = new DatabaseSync(join(directory, 'index.sqlite'), {
      readOnly: true,
    });
    try {
      return database
        .prepare(
          'SELECT rowid FROM documentation_search WHERE document_id = ? ORDER BY chunk_index ASC',
        )
        .all(documentId)
        .map((row) => row.rowid);
    } finally {
      database.close();
    }
  }

  function document(path: string, markdown: string): InputDocument {
    const route = path.replace(/\.(?:md|mdx)$/u, '');
    const sourceLocation = `file:///incremental-guide/${path}`;
    return {
      id: path,
      path,
      canonicalUrl: `https://manual.example.test/${route}`,
      sourceLocation,
      markdown,
    };
  }

  function makeSnapshot(
    revision: string,
    documents: InputDocument[],
  ): DocumentationSnapshot {
    return {
      version: identity.version,
      source: {
        kind: 'local',
        root: '/synthetic/incremental-guide',
        revision,
      },
      documents: documents.map((entry) => ({
        ...entry,
        version: identity.version,
      })),
    };
  }

  function documentIdFor(path: string): string {
    return createStableDocumentId(identity, path);
  }
});
