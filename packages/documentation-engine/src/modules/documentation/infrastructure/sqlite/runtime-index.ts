import type { DatabaseSync } from 'node:sqlite';
import type { DocumentationVersion } from '../../domain/documentation.types.js';
import {
  DOCUMENTATION_INDEX_COLUMNS,
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_METADATA_SCHEMA,
  DOCUMENTATION_INDEX_SCHEMA,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
  normalizeIndexSchema,
} from './index-schema.js';

/** Check an existing index without issuing any write or FTS control command. */
export function validateRuntimeIndex(
  database: DatabaseSync,
  version: DocumentationVersion,
): { revision: string; documentCount: number; chunkCount: number } {
  const fail = (reason: string): never => {
    throw new Error(`Invalid documentation v${version} index: ${reason}`);
  };
  const tables = database
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('documentation_search', 'documentation_index_metadata')",
    )
    .all();
  const tableSql = new Map(tables.map((table) => [table.name, table.sql]));
  const searchSql = tableSql.get('documentation_search');
  const metadataSql = tableSql.get('documentation_index_metadata');
  if (
    typeof searchSql !== 'string' ||
    !/^CREATE\s+VIRTUAL\s+TABLE\s+(?:["`[]?documentation_search["`\]]?)\s+USING\s+fts5\s*\(/iu.test(
      searchSql,
    )
  ) {
    fail('expected FTS5 table is missing or incompatible');
  }
  const ftsSql =
    typeof searchSql === 'string' ? searchSql : fail('FTS5 table is missing');
  const metadataTableSql =
    typeof metadataSql === 'string'
      ? metadataSql
      : fail('index metadata table is missing');
  if (
    typeof metadataSql !== 'string' ||
    normalizeIndexSchema(metadataTableSql) !==
      normalizeIndexSchema(DOCUMENTATION_INDEX_METADATA_SCHEMA)
  ) {
    fail('index metadata schema is missing or incompatible');
  }

  const columns = database
    .prepare('PRAGMA table_info(documentation_search)')
    .all();
  if (
    columns.length !== DOCUMENTATION_INDEX_COLUMNS.length ||
    columns.some(
      (column, index) =>
        column.name !== DOCUMENTATION_INDEX_COLUMNS[index]?.split(' ')[0],
    )
  ) {
    fail('FTS5 columns are missing or incompatible');
  }
  if (
    normalizeIndexSchema(ftsSql) !==
    normalizeIndexSchema(DOCUMENTATION_INDEX_SCHEMA)
  ) {
    fail('FTS5 configuration is incompatible');
  }

  const metadataRows = database
    .prepare(
      'SELECT key, value FROM documentation_index_metadata ORDER BY key COLLATE BINARY ASC',
    )
    .all();
  if (metadataRows.length !== 4)
    fail('index metadata is incomplete or unexpected');
  const metadata = new Map<string, string>();
  for (const row of metadataRows) {
    const key = row.key;
    const value = row.value;
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      metadata.has(String(key))
    ) {
      fail('index metadata is invalid');
    }
    metadata.set(String(key), String(value));
  }
  if (
    metadata.get('schema_version') !==
      String(DOCUMENTATION_INDEX_SCHEMA_VERSION) ||
    metadata.get('index_format_version') !==
      String(DOCUMENTATION_INDEX_FORMAT_VERSION)
  ) {
    fail('index schema or format version is unsupported');
  }
  if (metadata.get('documentation_version') !== version) {
    fail('selected documentation version does not match index metadata');
  }
  const revisionValue = metadata.get('source_revision');
  const revision =
    typeof revisionValue === 'string' && revisionValue.trim()
      ? revisionValue
      : fail('source revision metadata is invalid');

  const rows = database
    .prepare(
      `SELECT documentation_version AS version,
          source_revision AS revision, document_id AS documentId,
          chunk_id AS chunkId, chunk_index AS chunkIndex,
          canonical_url AS canonicalUrl, title
        FROM documentation_search
        ORDER BY document_id COLLATE BINARY ASC,
          chunk_index ASC, chunk_id COLLATE BINARY ASC`,
    )
    .iterate();
  const documents = new Set<string>();
  const chunkIds = new Set<string>();
  const nextChunkIndex = new Map<string, number>();
  let chunkCount = 0;
  for (const row of rows) {
    if (row.version !== version) {
      fail('index contains an unexpected documentation version');
    }
    if (row.revision !== revision) {
      fail('indexed rows contain inconsistent source revisions');
    }
    const documentId =
      typeof row.documentId === 'string'
        ? row.documentId
        : fail('indexed row has invalid document identity');
    const chunkId =
      typeof row.chunkId === 'string'
        ? row.chunkId
        : fail('indexed row has invalid chunk identity');
    const chunkIndex =
      typeof row.chunkIndex === 'number'
        ? row.chunkIndex
        : fail('indexed row has invalid chunk ordering');
    if (
      !documentId.trim() ||
      !chunkId.trim() ||
      !Number.isSafeInteger(chunkIndex) ||
      typeof row.title !== 'string' ||
      !row.title.trim() ||
      typeof row.canonicalUrl !== 'string' ||
      !URL.canParse(row.canonicalUrl)
    ) {
      fail('indexed row has invalid identity, version, or revision metadata');
    }
    if (chunkIds.has(chunkId))
      fail('index contains duplicate chunk identifiers');
    const expectedIndex = nextChunkIndex.get(documentId) ?? 0;
    if (chunkIndex !== expectedIndex) {
      fail('chunk ordering is incomplete or inconsistent');
    }
    nextChunkIndex.set(documentId, expectedIndex + 1);
    documents.add(documentId);
    chunkIds.add(chunkId);
    chunkCount++;
  }
  if (chunkCount === 0) fail('index contains no documentation chunks');

  return {
    revision,
    documentCount: documents.size,
    chunkCount,
  };
}
