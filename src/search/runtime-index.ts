import type { DatabaseSync } from 'node:sqlite';
import type { NestJsDocumentationVersion } from '../documentation-version.js';

const COLUMNS = [
  'title',
  'heading_path',
  'markdown',
  'documentation_version',
  'chunk_id',
  'document_id',
  'canonical_url',
  'source_revision',
];

/** Check an existing index without issuing any write or FTS control command. */
export function validateRuntimeIndex(
  database: DatabaseSync,
  version: NestJsDocumentationVersion,
): void {
  const fail = (reason: string): never => {
    throw new Error(
      `Invalid NestJS v${version} documentation index: ${reason}`,
    );
  };
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    fail('SQLite integrity check failed');
  }
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'documentation_search'",
    )
    .get();
  if (
    typeof table?.sql !== 'string' ||
    !/^CREATE\s+VIRTUAL\s+TABLE\s+(?:["`[]?documentation_search["`\]]?)\s+USING\s+fts5\s*\(/iu.test(
      table.sql,
    )
  ) {
    fail('expected FTS5 table is missing or incompatible');
  }
  const columns = database
    .prepare('PRAGMA table_info(documentation_search)')
    .all();
  if (
    columns.length !== COLUMNS.length ||
    columns.some((column, i) => column.name !== COLUMNS[i])
  ) {
    fail('FTS5 columns are missing or incompatible');
  }
  const normalizedSchema = (table!.sql as string)
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),=])\s*/gu, '$1');
  if (
    !/^create virtual table ["`[]?documentation_search["`\]]? using fts5\(title,heading_path,markdown,documentation_version unindexed,chunk_id unindexed,document_id unindexed,canonical_url unindexed,source_revision unindexed,tokenize='unicode61'\)$/u.test(
      normalizedSchema,
    )
  ) {
    fail('FTS5 configuration is incompatible');
  }
  const metadata = database
    .prepare(
      'SELECT DISTINCT documentation_version AS version, source_revision AS revision FROM documentation_search',
    )
    .all();
  if (
    metadata.length === 0 ||
    metadata.some((row) => row.version !== version)
  ) {
    fail('index is empty or contains unexpected documentation versions');
  }
  if (
    metadata.length !== 1 ||
    typeof metadata[0]?.revision !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(metadata[0].revision)
  ) {
    fail('source revision is invalid or inconsistent');
  }
  const invalidDocument = database
    .prepare('SELECT document_id FROM documentation_search')
    .iterate();
  const idPattern = new RegExp(`^nestjs-doc:v${version}:[a-f0-9]{64}$`, 'u');
  for (const row of invalidDocument) {
    if (
      typeof row.document_id !== 'string' ||
      !idPattern.test(row.document_id)
    ) {
      fail('document version metadata is invalid');
    }
  }
}
