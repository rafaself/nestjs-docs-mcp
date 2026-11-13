import type { DatabaseSync } from 'node:sqlite';
import type { NestJsDocumentationVersion } from '../../../domain/documentation-version.js';
import { z } from 'zod';

export function indexDocumentationCorpus(
  database: DatabaseSync,
  documentationVersion: NestJsDocumentationVersion,
  corpus: unknown,
): number {
  const chunks = validateCorpus(corpus, documentationVersion);
  const chunksByDocument = new Map<string, SearchChunk[]>();
  for (const chunk of chunks) {
    const documentChunks = chunksByDocument.get(chunk.documentId) ?? [];
    documentChunks.push(chunk);
    chunksByDocument.set(chunk.documentId, documentChunks);
  }
  const listExistingDocuments = database.prepare(
    'SELECT DISTINCT document_id AS documentId FROM documentation_search WHERE documentation_version = ?',
  );
  const existingRows = database.prepare(`
      SELECT chunk_id AS chunkId, title,
        heading_path AS headingPath, markdown,
        canonical_url AS canonicalUrl, source_revision AS sourceRevision
      FROM documentation_search
      WHERE document_id = ? AND documentation_version = ?
      ORDER BY rowid ASC
    `);
  const deleteDocument = database.prepare(
    'DELETE FROM documentation_search WHERE document_id = ? AND documentation_version = ?',
  );
  const updateRevision = database.prepare(
    'UPDATE documentation_search SET source_revision = ? WHERE document_id = ? AND documentation_version = ?',
  );
  const insert = database.prepare(`
      INSERT INTO documentation_search (
        title, heading_path, markdown, documentation_version, chunk_id,
        document_id, canonical_url, source_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
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
        updateRevision.run(
          documentChunks[0]!.sourceRevision,
          documentId,
          documentationVersion,
        );
        continue;
      }

      deleteDocument.run(documentId, documentationVersion);
      for (const chunk of documentChunks) {
        insert.run(
          chunk.title,
          formatHeadingPath(chunk.headingPath),
          chunk.markdown,
          documentationVersion,
          chunk.id,
          chunk.documentId,
          chunk.canonicalUrl,
          chunk.sourceRevision,
        );
      }
    }
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
  title: string;
  headingPath: string;
  markdown: string;
  canonicalUrl: string;
  sourceRevision: string;
}

interface SearchChunk {
  id: string;
  documentId: string;
  title: string;
  canonicalUrl: string;
  sourceRevision: string;
  headingPath: { title: string }[];
  markdown: string;
}

const nonEmptyString = z.string().refine((value) => value.trim().length > 0);
const corpusEnvelopeSchema = z.object({
  source: z.object({
    version: z.number(),
    ref: nonEmptyString,
    revision: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
  documents: z.array(z.unknown()).min(1),
});
const documentSchema = z.object({
  id: nonEmptyString,
  title: nonEmptyString,
  source: z.object({ revision: z.string() }),
  chunks: z.array(z.unknown()).min(1),
});
const chunkSchema = z.object({
  id: nonEmptyString,
  documentId: z.string(),
  canonicalUrl: nonEmptyString,
  sourceRevision: z.string(),
  markdown: z.string(),
  headingPath: z.array(z.object({ title: z.string() })),
});

function validateCorpus(
  corpus: unknown,
  expectedVersion: NestJsDocumentationVersion,
): SearchChunk[] {
  const parsedCorpus = corpusEnvelopeSchema.safeParse(corpus);
  if (
    !parsedCorpus.success ||
    parsedCorpus.data.source.version !== expectedVersion
  ) {
    throw new Error(
      `Documentation corpus must contain documents for NestJS v${expectedVersion}`,
    );
  }
  const { source, documents } = parsedCorpus.data;
  const documentIds = new Set<string>();
  const chunkIds = new Set<string>();
  const chunks: SearchChunk[] = [];
  for (const value of documents) {
    const parsed = documentSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.source.revision !== source.revision ||
      documentIds.has(parsed.data.id)
    ) {
      throw new Error(
        'Documentation corpus contains an invalid or duplicate document',
      );
    }
    const document = parsed.data;
    documentIds.add(document.id);
    for (const value of document.chunks) {
      const parsedChunk = chunkSchema.safeParse(value);
      if (
        !parsedChunk.success ||
        chunkIds.has(parsedChunk.data.id) ||
        parsedChunk.data.documentId !== document.id ||
        parsedChunk.data.sourceRevision !== source.revision
      ) {
        throw new Error(
          'Documentation corpus contains an invalid or duplicate chunk',
        );
      }
      const chunk = parsedChunk.data;
      chunkIds.add(chunk.id);
      chunks.push({ ...chunk, title: document.title });
    }
  }
  return chunks;
}

function toExistingIndexRow(row: Record<string, unknown>): ExistingIndexRow {
  const {
    chunkId,
    title,
    headingPath,
    markdown,
    canonicalUrl,
    sourceRevision,
  } = row;
  if (
    typeof chunkId !== 'string' ||
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
    title,
    headingPath,
    markdown,
    canonicalUrl,
    sourceRevision,
  };
}

function sameIndexedContent(
  existing: ExistingIndexRow[],
  incoming: SearchChunk[],
): boolean {
  if (existing.length !== incoming.length) return false;
  return existing.every((row, index) => {
    const chunk = incoming[index];
    return (
      chunk !== undefined &&
      row.chunkId === chunk.id &&
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
