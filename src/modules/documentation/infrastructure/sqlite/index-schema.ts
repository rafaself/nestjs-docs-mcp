export const DOCUMENTATION_INDEX_COLUMNS = [
  'title',
  'heading_path',
  'markdown',
  'documentation_version UNINDEXED',
  'chunk_id UNINDEXED',
  'document_id UNINDEXED',
  'canonical_url UNINDEXED',
  'source_revision UNINDEXED',
] as const;

export const DOCUMENTATION_INDEX_SCHEMA = `CREATE VIRTUAL TABLE documentation_search USING fts5(
  ${DOCUMENTATION_INDEX_COLUMNS.join(', ')}, tokenize = 'unicode61'
)`;
