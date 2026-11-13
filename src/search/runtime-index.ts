import type { DatabaseSync } from 'node:sqlite';
import type { NestJsDocumentationVersion } from '../documentation-version.js';
import {
  DOCUMENTATION_INDEX_COLUMNS,
  DOCUMENTATION_INDEX_SCHEMA,
} from './index-schema.js';

/** Check an existing index without issuing any write or FTS control command. */
export function validateRuntimeIndex(
  database: DatabaseSync,
  version: NestJsDocumentationVersion,
): { revision: string; documentCount: number; chunkCount: number } {
  const fail = (reason: string): never => {
    throw new Error(
      `Invalid NestJS v${version} documentation index: ${reason}`,
    );
  };
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
    columns.length !== DOCUMENTATION_INDEX_COLUMNS.length ||
    columns.some(
      (column, i) =>
        column.name !== DOCUMENTATION_INDEX_COLUMNS[i]?.split(' ')[0],
    )
  ) {
    fail('FTS5 columns are missing or incompatible');
  }
  const normalizedSchema = normalizeSchema(table!.sql as string);
  if (normalizedSchema !== normalizeSchema(DOCUMENTATION_INDEX_SCHEMA)) {
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
  const documents = new Set<string>();
  let chunkCount = 0;
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
    documents.add(row.document_id as string);
    chunkCount++;
  }
  return {
    revision: metadata[0]!.revision as string,
    documentCount: documents.size,
    chunkCount,
  };
}

function normalizeSchema(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),=])\s*/gu, '$1')
    .replace(
      /^(create virtual table )["`[]documentation_search["`\]]/u,
      '$1documentation_search',
    );
}
