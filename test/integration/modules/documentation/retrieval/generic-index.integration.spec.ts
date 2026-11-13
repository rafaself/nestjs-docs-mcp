import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DocumentationCorpus,
  DocumentationSourceProvenance,
  SourceDocument,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { DocumentationCorpusSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import { parseMarkdown } from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import { normalizeAndChunkDocument } from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import { validateDocumentationIndex } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-integrity.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { TestDocumentationSearchService } from '../../../../fixtures/test-documentation-search-service.js';

describe('generic documentation indexes', () => {
  let directory: string;
  let alphaPath: string;
  let betaPath: string;
  let alpha: DocumentationCorpus;
  let beta: DocumentationCorpus;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'generic-documentation-index-'));
    alphaPath = join(directory, 'alpha.sqlite');
    betaPath = join(directory, 'beta.sqlite');
    alpha = makeCorpus('alpha', 'alpha-guide', 'snapshot-alpha', 'quartz');
    beta = makeCorpus(
      'release-candidate',
      'beta-guide',
      'source-beta',
      'cobalt',
    );
    writeIndex(alphaPath, alpha);
    writeIndex(betaPath, beta);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('indexes independent string-version corpora and isolates search and fetch', () => {
    const alphaService = new TestDocumentationSearchService(alphaPath, 'alpha');
    const betaService = new TestDocumentationSearchService(
      betaPath,
      'release-candidate',
    );
    try {
      expect(alphaService.search('quartz')).toHaveLength(2);
      expect(alphaService.search('cobalt')).toEqual([]);
      expect(betaService.search('cobalt')).toHaveLength(2);
      expect(betaService.search('quartz')).toEqual([]);

      const alphaId = alpha.documents[0]!.id;
      const betaId = beta.documents[0]!.id;
      expect(alphaService.fetchDocument(alphaId)).not.toBeNull();
      expect(betaService.fetchDocument(betaId)).not.toBeNull();
      expect(alphaService.fetchDocument(betaId)).toBeNull();
      expect(betaService.fetchDocument(alphaId)).toBeNull();
    } finally {
      alphaService.onModuleDestroy();
      betaService.onModuleDestroy();
    }
  });

  it('validates arbitrary source revisions and exact generic corpus parity', () => {
    expect(validateDocumentationIndex('alpha', alpha, alphaPath)).toEqual({
      documentCount: 1,
      chunkCount: 3,
    });
    expect(
      validateDocumentationIndex('release-candidate', beta, betaPath),
    ).toEqual({
      documentCount: 1,
      chunkCount: 3,
    });
  });

  it('rejects unsupported index formats and corpus mismatches', () => {
    const database = new DatabaseSync(alphaPath);
    database
      .prepare(
        "UPDATE documentation_index_metadata SET value = '99' WHERE key = 'index_format_version'",
      )
      .run();
    database.close();

    expect(
      () => new TestDocumentationSearchService(alphaPath, 'alpha'),
    ).toThrow(/format version/u);
    expect(() => validateDocumentationIndex('alpha', beta, alphaPath)).toThrow(
      /format version/u,
    );
  });

  it('rejects indexes whose version metadata does not match the selected dataset', () => {
    const database = new DatabaseSync(alphaPath);
    database
      .prepare(
        "UPDATE documentation_index_metadata SET value = 'release-candidate' WHERE key = 'documentation_version'",
      )
      .run();
    database.close();

    expect(
      () => new TestDocumentationSearchService(alphaPath, 'alpha'),
    ).toThrow(/documentation version/u);
  });

  it('rebuilds an incompatible index format during indexing', () => {
    const oldPath = join(directory, 'old-format.sqlite');
    const oldDatabase = new DatabaseSync(oldPath);
    oldDatabase.exec(
      'CREATE VIRTUAL TABLE documentation_search USING fts5(title, markdown)',
    );
    oldDatabase.close();

    writeIndex(oldPath, alpha);
    expect(validateDocumentationIndex('alpha', alpha, oldPath)).toEqual({
      documentCount: 1,
      chunkCount: 3,
    });
  });

  it('orders rows by document and chunk position, independent of insertion order', () => {
    const corpus = makeMultiDocumentCorpus();
    const databasePath = join(directory, 'ordered.sqlite');
    const writer = new DocumentationIndexWriter(databasePath, 'alpha');
    try {
      writer.indexCorpus({
        ...corpus,
        documents: [...corpus.documents].reverse(),
      });
    } finally {
      writer.close();
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database
        .prepare(
          'SELECT document_id AS documentId, chunk_index AS chunkIndex FROM documentation_search ORDER BY document_id COLLATE BINARY ASC, chunk_index ASC, chunk_id COLLATE BINARY ASC',
        )
        .all();
      expect(rows).toEqual(
        [...corpus.documents]
          .sort((left, right) => left.id.localeCompare(right.id))
          .flatMap((document) =>
            [...document.chunks]
              .sort((left, right) => left.index - right.index)
              .map((chunk) => ({
                documentId: document.id,
                chunkIndex: chunk.index,
              })),
          ),
      );
    } finally {
      database.close();
    }
  });
});

function writeIndex(path: string, corpus: DocumentationCorpus): void {
  const writer = new DocumentationIndexWriter(path, corpus.version);
  try {
    writer.indexCorpus(corpus);
  } finally {
    writer.close();
  }
}

function makeCorpus(
  version: string,
  documentId: string,
  revision: string,
  term: string,
): DocumentationCorpus {
  const source: DocumentationSourceProvenance = {
    kind: 'local',
    root: `/synthetic/${version}`,
    revision,
  };
  const file: SourceDocument = {
    id: `synthetic:${documentId}`,
    version,
    path: 'guide.md',
    canonicalUrl: `https://${version}.example.test/guide`,
    sourceLocation: `file:///synthetic/${version}/guide.md`,
    markdown: `# ${documentId}\n\n## Overview\n\n${term} documentation.\n\n## Details\n\nMore ${term} content.\n`,
  };
  const document = normalizeAndChunkDocument(
    file,
    source,
    parseMarkdown(file.markdown, { path: file.path }),
  );
  return DocumentationCorpusSchema.parse({
    version,
    source,
    documents: [document],
  });
}

function makeMultiDocumentCorpus(): DocumentationCorpus {
  const source: DocumentationSourceProvenance = {
    kind: 'local',
    root: '/synthetic/alpha',
    revision: 'ordered-snapshot',
  };
  const documents = ['zeta', 'alpha'].map((name) => {
    const file: SourceDocument = {
      id: `ordered:${name}`,
      version: 'alpha',
      path: `${name}.md`,
      canonicalUrl: `https://ordered.example.test/${name}`,
      sourceLocation: `file:///synthetic/alpha/${name}.md`,
      markdown: `# ${name}\n\n## First\n\nFirst ${name} block.\n\n## Second\n\nSecond ${name} block.\n`,
    };
    return normalizeAndChunkDocument(
      file,
      source,
      parseMarkdown(file.markdown, { path: file.path }),
    );
  });
  return DocumentationCorpusSchema.parse({
    version: 'alpha',
    source,
    documents,
  });
}
