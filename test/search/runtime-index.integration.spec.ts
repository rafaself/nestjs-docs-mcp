import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module.js';
import { ingestSnapshot } from '../../src/ingestion/pipeline.js';
import { DocumentationIndexWriter } from '../../src/search/indexing/index-writer.js';
import { DocumentationSearchService } from '../../src/search/search.service.js';

describe('read-only documentation index startup', () => {
  let directory: string;
  let path: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-startup-'));
    path = join(directory, 'nested', 'index.sqlite');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function createIndex(version: 11 | 12): void {
    const writer = new DocumentationIndexWriter(path, version);
    try {
      writer.indexCorpus(
        ingestSnapshot({
          version,
          ref: version === 11 ? '11.0.0' : 'master',
          revision: 'a'.repeat(40),
          documents: [
            {
              path: 'content/page.md',
              canonicalUrl:
                version === 11
                  ? 'https://docs.nestjs.com/v11/page'
                  : 'https://docs.nestjs.com/page',
              markdown: '# Page\n\nsearchable documentation',
            },
          ],
        }),
      );
    } finally {
      writer.close();
    }
  }

  it('prevents MCP startup without creating a missing file or directory', async () => {
    await expect(
      NestFactory.createApplicationContext(AppModule.register(path), {
        logger: false,
        abortOnError: false,
      }),
    ).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(directory, 'nested'))).toBe(false);
  });

  it('rejects an empty SQLite database and a corrupt file', () => {
    path = join(directory, 'index.sqlite');
    new DatabaseSync(path).close();
    expect(() => new DocumentationSearchService(path, 12)).toThrow(/FTS5/u);
    writeFileSync(path, 'not a database');
    expect(() => new DocumentationSearchService(path, 12)).toThrow();
  });

  it.each([
    'CREATE TABLE documentation_search (title TEXT)',
    'CREATE VIRTUAL TABLE documentation_search USING fts5(title, markdown)',
  ])('rejects an incompatible schema: %s', (schema) => {
    path = join(directory, 'index.sqlite');
    const db = new DatabaseSync(path);
    db.exec(schema);
    db.close();
    expect(() => new DocumentationSearchService(path, 12)).toThrow(/FTS5/u);
  });

  it('rejects a valid schema with no documents', () => {
    const writer = new DocumentationIndexWriter(path, 12);
    writer.close();
    expect(() => new DocumentationSearchService(path, 12)).toThrow(/empty/u);
  });

  it('rejects a database containing only another major or mixed majors', () => {
    createIndex(11);
    expect(() => new DocumentationSearchService(path, 12)).toThrow(/versions/u);
    const writer = new DocumentationIndexWriter(path, 12);
    writer.indexCorpus(
      ingestSnapshot({
        version: 12,
        ref: 'master',
        revision: 'b'.repeat(40),
        documents: [
          {
            path: 'content/other.md',
            canonicalUrl: 'https://docs.nestjs.com/other',
            markdown: '# Other\n\ncontent',
          },
        ],
      }),
    );
    writer.close();
    expect(() => new DocumentationSearchService(path, 12)).toThrow(/versions/u);
    expect(() => new DocumentationSearchService(path, 11)).toThrow(/versions/u);
  });

  it.each(['', 'x'.repeat(40), 'a'.repeat(39)])(
    'rejects invalid revision %s',
    (revision) => {
      createIndex(12);
      const db = new DatabaseSync(path);
      db.prepare('UPDATE documentation_search SET source_revision = ?').run(
        revision,
      );
      db.close();
      expect(() => new DocumentationSearchService(path, 12)).toThrow(
        /revision/u,
      );
    },
  );

  it('rejects document IDs with the wrong version', () => {
    createIndex(12);
    const db = new DatabaseSync(path);
    db.prepare('UPDATE documentation_search SET document_id = ?').run(
      `nestjs-doc:v11:${'a'.repeat(64)}`,
    );
    db.close();
    expect(() => new DocumentationSearchService(path, 12)).toThrow(
      /version metadata/u,
    );
  });

  it('rejects inconsistent revisions within an index', () => {
    createIndex(12);
    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO documentation_search
      (title, heading_path, markdown, documentation_version, chunk_id, document_id, canonical_url, source_revision)
      SELECT title, heading_path, markdown, documentation_version, chunk_id, document_id, canonical_url, ?
      FROM documentation_search LIMIT 1`,
    ).run('b'.repeat(40));
    db.close();
    expect(() => new DocumentationSearchService(path, 12)).toThrow(/revision/u);
  });

  it.each([11, 12] as const)(
    'opens a valid v%i index and forbids writes',
    (version) => {
      createIndex(version);
      const service = new DocumentationSearchService(path, version);
      try {
        expect(service.search('searchable')).toHaveLength(1);
        const db = (service as unknown as { database: DatabaseSync }).database;
        expect(() =>
          db.exec("UPDATE documentation_search SET markdown = 'changed'"),
        ).toThrow(/readonly/u);
        expect(() => db.exec('CREATE TABLE unexpected (value TEXT)')).toThrow(
          /readonly/u,
        );
        expect(service.search('searchable')).toHaveLength(1);
      } finally {
        service.onModuleDestroy();
      }
    },
  );

  it('creates and updates an index through the indexing CLI', () => {
    const corpusPath = join(directory, 'corpus.json');
    const cli = fileURLToPath(
      new URL('../../dist/search/indexing/index.cli.js', import.meta.url),
    );
    const corpus = (word: string, revision: string) =>
      ingestSnapshot({
        version: 12,
        ref: 'master',
        revision,
        documents: [
          {
            path: 'content/page.md',
            canonicalUrl: 'https://docs.nestjs.com/page',
            markdown: `# Page\n\n${word}`,
          },
        ],
      });
    for (const [word, revision] of [
      ['firstmarker', 'a'.repeat(40)],
      ['secondmarker', 'b'.repeat(40)],
    ]) {
      writeFileSync(corpusPath, JSON.stringify(corpus(word!, revision!)));
      execFileSync(
        process.execPath,
        [cli, '--input', corpusPath, '--database', path],
        {
          env: { ...process.env, NESTJS_VERSION: '12' },
        },
      );
      const service = new DocumentationSearchService(path, 12);
      try {
        expect(service.search(word!)).toHaveLength(1);
      } finally {
        service.onModuleDestroy();
      }
    }
    const service = new DocumentationSearchService(path, 12);
    try {
      expect(service.search('firstmarker')).toEqual([]);
    } finally {
      service.onModuleDestroy();
    }
  });
});
