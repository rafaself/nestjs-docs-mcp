import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import type { DocumentationCorpus } from '../ingestion/types.js';
import {
  DEFAULT_SEARCH_RESULT_LIMIT,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_QUERY_TERMS,
  MAX_SEARCH_RESULT_LIMIT,
} from './search.constants.js';
import { SEARCH_DATABASE_PATH } from './search.tokens.js';

export interface DocumentationSearchResult {
  chunkId: string;
  documentId: string;
  title: string;
  canonicalUrl: string;
  sourceRevision: string;
  excerpt: string;
  score: number;
}

interface SearchRow {
  chunkId: string;
  documentId: string;
  title: string;
  canonicalUrl: string;
  sourceRevision: string;
  excerpt: string;
  rank: number;
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

@Injectable()
export class DocumentationSearchService implements OnModuleDestroy {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(@Inject(SEARCH_DATABASE_PATH) databasePath: string) {
    if (!databasePath) throw new Error('A SQLite database path is required');
    const path =
      databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documentation_search USING fts5(
        title,
        heading_path,
        markdown,
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        canonical_url UNINDEXED,
        source_revision UNINDEXED,
        tokenize = 'unicode61'
      );
    `);
  }

  /** Replace the full-text index with chunks from one ingested corpus. */
  indexCorpus(corpus: DocumentationCorpus): number {
    const chunks = validateCorpus(corpus);
    const clear = this.database.prepare('DELETE FROM documentation_search');
    const insert = this.database.prepare(`
      INSERT INTO documentation_search (
        title, heading_path, markdown, chunk_id, document_id,
        canonical_url, source_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let transactionStarted = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      clear.run();
      for (const chunk of chunks) {
        insert.run(
          chunk.title,
          chunk.headingPath.map((heading) => heading.title).join(' > '),
          chunk.markdown,
          chunk.id,
          chunk.documentId,
          chunk.canonicalUrl,
          chunk.sourceRevision,
        );
      }
      this.database.exec('COMMIT');
      transactionStarted = false;
      return chunks.length;
    } catch (error) {
      if (transactionStarted) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Search indexed sections. FTS operators are not accepted from user input. */
  search(
    query: unknown,
    limit = DEFAULT_SEARCH_RESULT_LIMIT,
  ): DocumentationSearchResult[] {
    if (typeof query !== 'string') {
      throw new BadRequestException('Search query must be a string');
    }
    if (query.length > MAX_SEARCH_QUERY_LENGTH) {
      throw new BadRequestException(
        `Search query must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`,
      );
    }
    if (containsForbiddenControlCharacters(query)) {
      throw new BadRequestException('Search query contains control characters');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new BadRequestException(
        'Search result limit must be a positive integer',
      );
    }

    const normalized = query.trim();
    if (!normalized) return [];

    const terms = [...new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? [])];
    if (!terms.length) return [];
    if (terms.length > MAX_SEARCH_QUERY_TERMS) {
      throw new BadRequestException(
        `Search query must contain at most ${MAX_SEARCH_QUERY_TERMS} terms`,
      );
    }

    // Quoted terms keep FTS5 operators and punctuation out of the query language.
    const matchExpression = terms
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' OR ');
    const rows = this.database
      .prepare(
        `
        SELECT
          chunk_id AS chunkId,
          document_id AS documentId,
          title,
          canonical_url AS canonicalUrl,
          source_revision AS sourceRevision,
          snippet(documentation_search, 2, '[', ']', ' … ', 32) AS excerpt,
          bm25(documentation_search, 8.0, 4.0, 1.0) AS rank
        FROM documentation_search
        WHERE documentation_search MATCH ?
        ORDER BY rank ASC, document_id ASC, chunk_id ASC
        LIMIT ?
      `,
      )
      .all(matchExpression, Math.min(limit, MAX_SEARCH_RESULT_LIMIT))
      .map(toSearchRow);

    return rows.map(({ rank, ...row }) => ({ ...row, score: -rank }));
  }

  onModuleDestroy(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

function validateCorpus(corpus: DocumentationCorpus): SearchChunk[] {
  if (
    !corpus ||
    typeof corpus !== 'object' ||
    !Array.isArray(corpus.documents) ||
    corpus.documents.length === 0
  ) {
    throw new Error('Documentation corpus must contain at least one document');
  }

  const documentIds = new Set<string>();
  const chunkIds = new Set<string>();
  const chunks: SearchChunk[] = [];
  for (const document of corpus.documents) {
    if (
      !document ||
      typeof document.id !== 'string' ||
      !document.id.trim() ||
      typeof document.title !== 'string' ||
      !document.title.trim() ||
      !Array.isArray(document.chunks) ||
      document.chunks.length === 0 ||
      documentIds.has(document.id)
    ) {
      throw new Error(
        'Documentation corpus contains an invalid or duplicate document',
      );
    }
    documentIds.add(document.id);

    for (const chunk of document.chunks) {
      if (
        !chunk ||
        typeof chunk.id !== 'string' ||
        !chunk.id.trim() ||
        chunkIds.has(chunk.id) ||
        chunk.documentId !== document.id ||
        typeof chunk.canonicalUrl !== 'string' ||
        !chunk.canonicalUrl.trim() ||
        typeof chunk.sourceRevision !== 'string' ||
        !chunk.sourceRevision.trim() ||
        typeof chunk.markdown !== 'string' ||
        !Array.isArray(chunk.headingPath) ||
        chunk.headingPath.some(
          (heading) => !heading || typeof heading.title !== 'string',
        )
      ) {
        throw new Error(
          'Documentation corpus contains an invalid or duplicate chunk',
        );
      }
      chunkIds.add(chunk.id);
      chunks.push({
        id: chunk.id,
        documentId: document.id,
        title: document.title,
        canonicalUrl: chunk.canonicalUrl,
        sourceRevision: chunk.sourceRevision,
        headingPath: chunk.headingPath,
        markdown: chunk.markdown,
      });
    }
  }
  return chunks;
}

function toSearchRow(row: Record<string, unknown>): SearchRow {
  const {
    chunkId,
    documentId,
    title,
    canonicalUrl,
    sourceRevision,
    excerpt,
    rank,
  } = row;
  if (
    typeof chunkId !== 'string' ||
    typeof documentId !== 'string' ||
    typeof title !== 'string' ||
    typeof canonicalUrl !== 'string' ||
    typeof sourceRevision !== 'string' ||
    typeof excerpt !== 'string' ||
    typeof rank !== 'number'
  ) {
    throw new Error('SQLite returned an invalid documentation search row');
  }
  return {
    chunkId,
    documentId,
    title,
    canonicalUrl,
    sourceRevision,
    excerpt,
    rank,
  };
}

function containsForbiddenControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 8 ||
      (code >= 11 && code <= 12) ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      return true;
    }
  }
  return false;
}
