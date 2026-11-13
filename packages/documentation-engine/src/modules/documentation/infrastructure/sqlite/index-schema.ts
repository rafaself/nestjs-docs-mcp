export const DOCUMENTATION_INDEX_SCHEMA_VERSION = 1;
export const DOCUMENTATION_INDEX_FORMAT_VERSION = 1;
export const DOCUMENTATION_INDEX_METADATA_TABLE =
  'documentation_index_metadata';
export const DOCUMENTATION_INDEX_TABLE = 'documentation_search';

export const DOCUMENTATION_INDEX_COLUMNS = [
  'title',
  'heading_path',
  'markdown',
  'documentation_version UNINDEXED',
  'chunk_index UNINDEXED',
  'chunk_id UNINDEXED',
  'document_id UNINDEXED',
  'canonical_url UNINDEXED',
  'source_revision UNINDEXED',
] as const;

export const DOCUMENTATION_INDEX_METADATA_SCHEMA = `CREATE TABLE ${DOCUMENTATION_INDEX_METADATA_TABLE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK(length(value) > 0)
) STRICT`;

export const DOCUMENTATION_INDEX_SCHEMA = `CREATE VIRTUAL TABLE ${DOCUMENTATION_INDEX_TABLE} USING fts5(
  ${DOCUMENTATION_INDEX_COLUMNS.join(', ')}, tokenize = 'unicode61'
)`;

export const DOCUMENTATION_INDEX_METADATA_KEYS = [
  'schema_version',
  'index_format_version',
  'documentation_version',
  'source_revision',
] as const;

export function normalizeIndexSchema(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),=])\s*/gu, '$1')
    .replace(
      /^(create virtual table )[`"[]documentation_search[`"\]]/u,
      '$1documentation_search',
    );
}
