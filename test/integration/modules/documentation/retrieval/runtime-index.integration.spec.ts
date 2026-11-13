import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { McpServerModule } from '../../../../../src/apps/mcp-server/mcp-server.module.js';
import { ingestNestJsDocuments } from '../../../../fixtures/ingestion.fixtures.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_METADATA_SCHEMA,
  DOCUMENTATION_INDEX_SCHEMA,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { TestDocumentationSearchService } from '../../../../fixtures/test-documentation-search-service.js';

describe('read-only documentation index startup', () => {
  let directory: string;
  let path: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-startup-'));
    path = join(directory, 'nested', 'index.sqlite');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function createIndex(version: '11' | '12'): void {
    const writer = new DocumentationIndexWriter(path, version);
    try {
      writer.indexCorpus(
        ingestNestJsDocuments(
          version,
          [
            {
              path: 'content/page.md',
              canonicalUrl:
                version === '11'
                  ? 'https://docs.nestjs.com/v11/page'
                  : 'https://docs.nestjs.com/page',
              markdown: '# Page\n\nsearchable documentation',
            },
          ],
          'a'.repeat(40),
        ),
      );
    } finally {
      writer.close();
    }
  }

  it('prevents MCP startup without creating a missing file or directory', () => {
    expect(() => McpServerModule.register(path)).toThrow(
      /missing or unreadable/u,
    );
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(directory, 'nested'))).toBe(false);
  });

  it('rejects an empty SQLite database and a corrupt file', () => {
    path = join(directory, 'index.sqlite');
    new DatabaseSync(path).close();
    expect(() => new TestDocumentationSearchService(path, '12')).toThrow(
      /FTS5/u,
    );
    writeFileSync(path, 'not a database');
    expect(() => new TestDocumentationSearchService(path, '12')).toThrow();
  });

  it.each([
    'CREATE TABLE documentation_search (title TEXT)',
    'CREATE VIRTUAL TABLE documentation_search USING fts5(title, markdown)',
  ])('rejects an incompatible schema: %s', (schema) => {
    path = join(directory, 'index.sqlite');
    const db = new DatabaseSync(path);
    db.exec(schema);
    db.close();
    expect(() => new TestDocumentationSearchService(path, '12')).toThrow(
      /FTS5|metadata/u,
    );
  });

  it('rejects a valid schema with no documents', () => {
    path = join(directory, 'empty-index.sqlite');
    const database = new DatabaseSync(path);
    database.exec(DOCUMENTATION_INDEX_METADATA_SCHEMA);
    database.exec(DOCUMENTATION_INDEX_SCHEMA);
    const metadata = database.prepare(
      'INSERT INTO documentation_index_metadata (key, value) VALUES (?, ?)',
    );
    metadata.run('schema_version', String(DOCUMENTATION_INDEX_SCHEMA_VERSION));
    metadata.run(
      'index_format_version',
      String(DOCUMENTATION_INDEX_FORMAT_VERSION),
    );
    metadata.run('documentation_version', '12');
    metadata.run('source_revision', 'empty-index-revision');
    database.close();
    expect(() => new TestDocumentationSearchService(path, '12')).toThrow(
      /no documentation chunks/u,
    );
  });

  it('rejects a database containing only another version', () => {
    createIndex('11');
    expect(() => new TestDocumentationSearchService(path, '12')).toThrow(
      /selected documentation version/u,
    );
  });

  it('rebuilds a dedicated index when indexing another version', () => {
    createIndex('11');
    const writer = new DocumentationIndexWriter(path, '12');
    writer.indexCorpus(
      ingestNestJsDocuments(
        '12',
        [
          {
            path: 'content/other.md',
            canonicalUrl: 'https://docs.nestjs.com/other',
            markdown: '# Other\n\ncontent',
          },
        ],
        'b'.repeat(40),
      ),
    );
    writer.close();
    const service = new TestDocumentationSearchService(path, '12');
    expect(service.search('content')).toHaveLength(1);
    service.onModuleDestroy();
    expect(() => new TestDocumentationSearchService(path, '11')).toThrow(
      /selected documentation version/u,
    );
  });

  it.each(['', 'x'.repeat(40), 'a'.repeat(39)])(
    'rejects invalid revision %s',
    (revision) => {
      createIndex('12');
      const db = new DatabaseSync(path);
      db.prepare('UPDATE documentation_search SET source_revision = ?').run(
        revision,
      );
      db.close();
      expect(() => new TestDocumentationSearchService(path, '12')).toThrow(
        /revision/u,
      );
    },
  );

  it('rejects empty document IDs', () => {
    createIndex('12');
    const db = new DatabaseSync(path);
    db.prepare('UPDATE documentation_search SET document_id = ?').run('');
    db.close();
    expect(() => new TestDocumentationSearchService(path, '12')).toThrow(
      /identity/u,
    );
  });

  it('rejects inconsistent revisions within an index', () => {
    createIndex('12');
    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO documentation_search
      (title, heading_path, markdown, documentation_version, chunk_index, chunk_id, document_id, canonical_url, source_revision)
      SELECT title, heading_path, markdown, documentation_version, chunk_index + 1, chunk_id || ':extra', document_id, canonical_url, ?
      FROM documentation_search LIMIT 1`,
    ).run('b'.repeat(40));
    db.close();
    expect(() => new TestDocumentationSearchService(path, '12')).toThrow(
      /revision/u,
    );
  });

  it.each(['11', '12'] as const)(
    'opens a valid v%s index and forbids writes',
    (version) => {
      createIndex(version);
      const service = new TestDocumentationSearchService(path, version);
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
      new URL('../../../../../apps/docs-indexer/dist/cli.js', import.meta.url),
    );
    const corpus = (word: string, revision: string) =>
      ingestNestJsDocuments(
        '12',
        [
          {
            path: 'content/page.md',
            canonicalUrl: 'https://docs.nestjs.com/page',
            markdown: `# Page\n\n${word}`,
          },
        ],
        revision,
      );
    for (const [word, revision] of [
      ['firstmarker', 'a'.repeat(40)],
      ['secondmarker', 'b'.repeat(40)],
    ]) {
      writeFileSync(corpusPath, JSON.stringify(corpus(word!, revision!)));
      execFileSync(
        process.execPath,
        [cli, 'index', '--input', corpusPath, '--database', path],
        {
          env: { ...process.env, NESTJS_VERSION: '12' },
        },
      );
      const service = new TestDocumentationSearchService(path, '12');
      try {
        expect(service.search(word!)).toHaveLength(1);
      } finally {
        service.onModuleDestroy();
      }
    }
    const service = new TestDocumentationSearchService(path, '12');
    try {
      expect(service.search('firstmarker')).toEqual([]);
    } finally {
      service.onModuleDestroy();
    }
  });
});
