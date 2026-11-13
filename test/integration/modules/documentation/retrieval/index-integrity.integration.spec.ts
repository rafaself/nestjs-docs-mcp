import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ingestSnapshot } from '../../../../fixtures/ingestion.fixtures.js';
import { validateDocumentationIndex } from '../../../../../src/modules/documentation/infrastructure/sqlite/indexing/index-integrity.js';
import { DocumentationIndexWriter } from '../../../../../src/modules/documentation/infrastructure/sqlite/indexing/index-writer.js';

describe('documentation index integrity validation', () => {
  it('requires exact content parity between the corpus and SQLite index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-integrity-'));
    const databasePath = join(directory, 'documentation.sqlite');
    const index = new DocumentationIndexWriter(databasePath, 12);
    const database = new DatabaseSync(databasePath);
    const corpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: 'f'.repeat(40),
      documents: [
        {
          path: 'content/providers.md',
          canonicalUrl: 'https://docs.nestjs.com/providers',
          markdown: '# Providers\n\nProviders can be injected.',
        },
      ],
    });

    try {
      index.indexCorpus(corpus);

      expect(validateDocumentationIndex(12, corpus, databasePath)).toEqual({
        documentCount: 1,
        chunkCount: 1,
      });

      database
        .prepare(
          'UPDATE documentation_search SET markdown = ? WHERE documentation_version = ?',
        )
        .run('tampered content', 12);
      expect(() =>
        validateDocumentationIndex(12, corpus, databasePath),
      ).toThrow('SQLite content does not match corpus');
    } finally {
      database.close();
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a supported-major corpus containing another major canonical URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-major-url-'));
    const databasePath = join(directory, 'documentation.sqlite');
    const index = new DocumentationIndexWriter(databasePath, 12);
    const corpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: 'a'.repeat(40),
      documents: [
        {
          path: 'content/providers.md',
          canonicalUrl: 'https://docs.nestjs.com/providers',
          markdown: '# Providers\n\nProviders can be injected.',
        },
      ],
    });
    const v11Corpus = {
      ...corpus,
      documents: corpus.documents.map((document) => ({
        ...document,
        canonicalUrl: 'https://docs.nestjs.com/v11/providers',
        chunks: document.chunks.map((chunk) => ({
          ...chunk,
          canonicalUrl: 'https://docs.nestjs.com/v11/providers',
        })),
      })),
    };

    try {
      index.indexCorpus(v11Corpus);
      expect(() =>
        validateDocumentationIndex(12, v11Corpus, databasePath),
      ).toThrow('document failed integrity checks');
    } finally {
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts section URLs anchored to the v11 documentation root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-v11-root-'));
    const databasePath = join(directory, 'documentation.sqlite');
    const index = new DocumentationIndexWriter(databasePath, 11);
    const corpus = ingestSnapshot({
      version: 11,
      ref: '11.0.0',
      revision: 'b'.repeat(40),
      documents: [
        {
          path: 'content/introduction.md',
          canonicalUrl: 'https://docs.nestjs.com/v11',
          markdown: '# Introduction\n\n## Philosophy\n\nNestJS is a framework.',
        },
      ],
    });

    try {
      index.indexCorpus(corpus);
      expect(validateDocumentationIndex(11, corpus, databasePath)).toEqual({
        documentCount: 1,
        chunkCount: 2,
      });
    } finally {
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects unexpected majors in a corpus-matching index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-mixed-'));
    const databasePath = join(directory, 'documentation.sqlite');
    const corpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: 'a'.repeat(40),
      documents: [
        {
          path: 'content/page.md',
          canonicalUrl: 'https://docs.nestjs.com/page',
          markdown: '# Page\n\nContent.',
        },
      ],
    });
    const writer = new DocumentationIndexWriter(databasePath, 12);
    try {
      writer.indexCorpus(corpus);
      const db = new DatabaseSync(databasePath);
      db.prepare(
        `INSERT INTO documentation_search
        (title, heading_path, markdown, documentation_version, chunk_id, document_id, canonical_url, source_revision)
        SELECT title, heading_path, markdown, 11, chunk_id, document_id, canonical_url, source_revision
        FROM documentation_search LIMIT 1`,
      ).run();
      db.close();
      expect(() =>
        validateDocumentationIndex(12, corpus, databasePath),
      ).toThrow(/versions/u);
    } finally {
      writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
