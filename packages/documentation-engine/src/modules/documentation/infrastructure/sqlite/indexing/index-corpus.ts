import type { DatabaseSync } from 'node:sqlite';
import { DocumentationCorpusSchema } from '../../../domain/documentation.schemas.js';
import type {
  DocumentationChunk,
  DocumentationVersion,
} from '../../../domain/documentation.types.js';
import { validateRuntimeIndex } from '../runtime-index.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_METADATA_SCHEMA,
  DOCUMENTATION_INDEX_SCHEMA,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
  normalizeIndexSchema,
} from '../index-schema.js';

export function indexDocumentationCorpus(
  database: DatabaseSync,
  documentationVersion: DocumentationVersion,
  corpus: unknown,
): number {
  const chunks = validateCorpus(corpus, documentationVersion);
  const chunksByDocument = new Map<string, DocumentationChunk[]>();
  for (const chunk of chunks) {
    const documentChunks = chunksByDocument.get(chunk.documentId) ?? [];
    documentChunks.push(chunk);
    chunksByDocument.set(chunk.documentId, documentChunks);
  }

  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    if (hasCompatibleIndex(database, documentationVersion)) {
      validateRuntimeIndex(database, documentationVersion);
    } else {
      rebuildIndexSchema(database);
      writeMetadata(database, {
        schema_version: String(DOCUMENTATION_INDEX_SCHEMA_VERSION),
        index_format_version: String(DOCUMENTATION_INDEX_FORMAT_VERSION),
        documentation_version: documentationVersion,
        source_revision: chunks[0]!.sourceRevision,
      });
    }

    const listExistingDocuments = database.prepare(
      'SELECT DISTINCT document_id AS documentId FROM documentation_search WHERE documentation_version = ? ORDER BY document_id COLLATE BINARY ASC',
    );
    const existingRows = database.prepare(`
        SELECT chunk_id AS chunkId, chunk_index AS chunkIndex, title,
          heading_path AS headingPath, markdown,
          canonical_url AS canonicalUrl, source_revision AS sourceRevision
        FROM documentation_search
        WHERE document_id = ? AND documentation_version = ?
        ORDER BY chunk_index ASC, chunk_id COLLATE BINARY ASC
      `);
    const deleteDocument = database.prepare(
      'DELETE FROM documentation_search WHERE document_id = ? AND documentation_version = ?',
    );
    const updateRevision = database.prepare(
      'UPDATE documentation_search SET source_revision = ? WHERE document_id = ? AND documentation_version = ?',
    );
    const insert = database.prepare(`
        INSERT INTO documentation_search (
          title, heading_path, markdown, documentation_version, chunk_index,
          chunk_id, document_id, canonical_url, source_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

    const existingDocumentIds = listExistingDocuments
      .all(documentationVersion)
      .map((row) => row.documentId);
    const incomingDocumentIds = new Set(chunksByDocument.keys());
    for (const documentId of existingDocumentIds) {
      if (
        typeof documentId === 'string' &&
        !incomingDocumentIds.has(documentId)
      ) {
        deleteDocument.run(documentId, documentationVersion);
      }
    }

    for (const [documentId, documentChunks] of chunksByDocument) {
      const current = existingRows
        .all(documentId, documentationVersion)
        .map(toExistingIndexRow);
      if (sameIndexedContent(current, documentChunks)) {
        if (
          current.some(
            (row) => row.sourceRevision !== documentChunks[0]!.sourceRevision,
          )
        ) {
          updateRevision.run(
            documentChunks[0]!.sourceRevision,
            documentId,
            documentationVersion,
          );
        }
        continue;
      }

      deleteDocument.run(documentId, documentationVersion);
      for (const chunk of documentChunks) {
        insert.run(
          chunk.title,
          formatHeadingPath(chunk.headingPath),
          chunk.markdown,
          documentationVersion,
          chunk.index,
          chunk.id,
          chunk.documentId,
          chunk.canonicalUrl,
          chunk.sourceRevision,
        );
      }
    }

    writeMetadata(database, {
      schema_version: String(DOCUMENTATION_INDEX_SCHEMA_VERSION),
      index_format_version: String(DOCUMENTATION_INDEX_FORMAT_VERSION),
      documentation_version: documentationVersion,
      source_revision: chunks[0]!.sourceRevision,
    });
    database.exec('COMMIT');
    transactionStarted = false;
    return chunks.length;
  } catch (error) {
    if (transactionStarted && database.isTransaction) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Index synchronization and rollback both failed',
          { cause: rollbackError },
        );
      }
    }
    throw error;
  }
}

interface ExistingIndexRow {
  chunkId: string;
  chunkIndex: number;
  title: string;
  headingPath: string;
  markdown: string;
  canonicalUrl: string;
  sourceRevision: string;
}

function validateCorpus(
  corpus: unknown,
  expectedVersion: DocumentationVersion,
): DocumentationChunk[] {
  const parsedCorpus = DocumentationCorpusSchema.safeParse(corpus);
  if (!parsedCorpus.success || parsedCorpus.data.version !== expectedVersion) {
    throw new Error(
      `Documentation corpus must contain documents for version "${expectedVersion}"`,
    );
  }
  const documents = [...parsedCorpus.data.documents].sort(compareDocumentIds);
  const chunks: DocumentationChunk[] = [];
  for (const document of documents) {
    const documentChunks = [...document.chunks].sort(
      (left, right) =>
        left.index - right.index || compareStrings(left.id, right.id),
    );
    if (documentChunks.some((chunk, index) => chunk.index !== index)) {
      throw new Error(
        `Documentation chunks for "${document.id}" must have sequential indexes`,
      );
    }
    chunks.push(...documentChunks);
  }
  return chunks;
}

function compareDocumentIds(
  left: { id: string },
  right: { id: string },
): number {
  return compareStrings(left.id, right.id);
}

function toExistingIndexRow(row: Record<string, unknown>): ExistingIndexRow {
  const {
    chunkId,
    chunkIndex,
    title,
    headingPath,
    markdown,
    canonicalUrl,
    sourceRevision,
  } = row;
  if (
    typeof chunkId !== 'string' ||
    typeof chunkIndex !== 'number' ||
    typeof title !== 'string' ||
    typeof headingPath !== 'string' ||
    typeof markdown !== 'string' ||
    typeof canonicalUrl !== 'string' ||
    typeof sourceRevision !== 'string'
  ) {
    throw new Error('SQLite returned an invalid documentation index row');
  }
  return {
    chunkId,
    chunkIndex,
    title,
    headingPath,
    markdown,
    canonicalUrl,
    sourceRevision,
  };
}

function sameIndexedContent(
  existing: ExistingIndexRow[],
  incoming: DocumentationChunk[],
): boolean {
  if (existing.length !== incoming.length) return false;
  return existing.every((row, index) => {
    const chunk = incoming[index];
    return (
      chunk !== undefined &&
      row.chunkId === chunk.id &&
      row.chunkIndex === chunk.index &&
      row.title === chunk.title &&
      row.headingPath === formatHeadingPath(chunk.headingPath) &&
      row.markdown === chunk.markdown &&
      row.canonicalUrl === chunk.canonicalUrl
    );
  });
}

function formatHeadingPath(headings: { title: string }[]): string {
  return headings.map((heading) => heading.title).join(' > ');
}

function hasCompatibleIndex(
  database: DatabaseSync,
  version: DocumentationVersion,
): boolean {
  const tables = database
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('documentation_search', 'documentation_index_metadata')",
    )
    .all();
  const tableSql = new Map(tables.map((table) => [table.name, table.sql]));
  if (
    typeof tableSql.get('documentation_search') !== 'string' ||
    typeof tableSql.get('documentation_index_metadata') !== 'string' ||
    normalizeIndexSchema(tableSql.get('documentation_search') as string) !==
      normalizeIndexSchema(DOCUMENTATION_INDEX_SCHEMA) ||
    normalizeIndexSchema(
      tableSql.get('documentation_index_metadata') as string,
    ) !== normalizeIndexSchema(DOCUMENTATION_INDEX_METADATA_SCHEMA)
  ) {
    return false;
  }
  const metadata = new Map<string, string>();
  for (const row of database
    .prepare('SELECT key, value FROM documentation_index_metadata ORDER BY key')
    .all()) {
    if (typeof row.key !== 'string' || typeof row.value !== 'string') {
      return false;
    }
    metadata.set(row.key, row.value);
  }
  return (
    metadata.size === 4 &&
    metadata.get('schema_version') ===
      String(DOCUMENTATION_INDEX_SCHEMA_VERSION) &&
    metadata.get('index_format_version') ===
      String(DOCUMENTATION_INDEX_FORMAT_VERSION) &&
    metadata.get('documentation_version') === version &&
    Boolean(metadata.get('source_revision'))
  );
}

function rebuildIndexSchema(database: DatabaseSync): void {
  database.exec('DROP TABLE IF EXISTS documentation_search');
  database.exec('DROP TABLE IF EXISTS documentation_index_metadata');
  database.exec(DOCUMENTATION_INDEX_METADATA_SCHEMA);
  database.exec(DOCUMENTATION_INDEX_SCHEMA);
}

function writeMetadata(
  database: DatabaseSync,
  values: Record<string, string>,
): void {
  const current = new Map<string, string>();
  for (const row of database
    .prepare('SELECT key, value FROM documentation_index_metadata ORDER BY key')
    .all()) {
    if (typeof row.key === 'string' && typeof row.value === 'string') {
      current.set(row.key, row.value);
    }
  }
  const insert = database.prepare(`
    INSERT INTO documentation_index_metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [key, value] of Object.entries(values)) {
    if (current.get(key) !== value) insert.run(key, value);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
