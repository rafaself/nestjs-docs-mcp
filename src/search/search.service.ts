import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { NestJsDocumentationVersion } from '../documentation-version.js';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  DEFAULT_SEARCH_RESULT_LIMIT,
  MAX_SEARCH_RESULT_LIMIT,
} from './search.constants.js';
import { validateRuntimeIndex } from './runtime-index.js';
import { buildSearchExpression, validateDocumentId } from './search-input.js';
import { paginateDocumentation, type DocumentRow } from './document-page.js';
import {
  DOCUMENTATION_VERSION,
  SEARCH_DATABASE_PATH,
} from './search.tokens.js';

import type {
  DocumentationSearchResult,
  FetchedDocumentation,
} from './documentation-search.types.js';
export type {
  DocumentationSearchResult,
  DocumentationSectionResult,
  FetchedDocumentation,
} from './documentation-search.types.js';

interface SearchRow {
  chunkId: string;
  documentId: string;
  title: string;
  canonicalUrl: string;
  sourceRevision: string;
  excerpt: string;
  rank: number;
}

@Injectable()
export class DocumentationSearchService implements OnModuleDestroy {
  private readonly database: DatabaseSync;
  readonly #documentationVersion: NestJsDocumentationVersion;
  private closed = false;

  get documentationVersion(): NestJsDocumentationVersion {
    return this.#documentationVersion;
  }

  constructor(
    @Inject(SEARCH_DATABASE_PATH) databasePath: string,
    @Inject(DOCUMENTATION_VERSION)
    documentationVersion: NestJsDocumentationVersion,
  ) {
    this.#documentationVersion = documentationVersion;
    if (!databasePath) throw new Error('A SQLite database path is required');
    if (databasePath === ':memory:') {
      throw new Error('A pre-existing SQLite index file is required');
    }
    this.database = new DatabaseSync(resolve(databasePath), {
      readOnly: true,
      timeout: 5000,
    });
    try {
      validateRuntimeIndex(this.database, documentationVersion);
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  /** Search indexed sections. FTS operators are not accepted from user input. */
  search(
    query: unknown,
    limit = DEFAULT_SEARCH_RESULT_LIMIT,
  ): DocumentationSearchResult[] {
    const matchExpression = buildSearchExpression(query, limit);
    if (!matchExpression) return [];
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
          AND documentation_version = ?
        ORDER BY rank ASC, document_id ASC, chunk_id ASC
        LIMIT ?
      `,
      )
      .all(
        matchExpression,
        this.documentationVersion,
        Math.min(limit, MAX_SEARCH_RESULT_LIMIT),
      )
      .map(toSearchRow);

    return rows.map(({ rank, ...row }) => ({ ...row, score: -rank }));
  }

  /** Fetch one document by its deterministic ingestion identifier. */
  fetchDocument(
    documentId: unknown,
    sectionId?: string,
    cursor?: string,
  ): FetchedDocumentation | null {
    const validatedDocumentId = validateDocumentId(
      documentId,
      this.documentationVersion,
    );

    const rows = this.database
      .prepare(
        `
        SELECT title, heading_path AS headingPath,
          canonical_url AS canonicalUrl,
          source_revision AS sourceRevision, markdown
        FROM documentation_search
        WHERE document_id = ? AND documentation_version = ?
        ORDER BY rowid ASC
      `,
      )
      .all(validatedDocumentId, this.documentationVersion)
      .map(toDocumentRow);
    const first = rows[0];
    if (!first) return null;

    let selectedRows = rows;
    if (sectionId) {
      const match = this.database
        .prepare(
          `SELECT canonical_url AS canonicalUrl, heading_path AS headingPath
         FROM documentation_search WHERE document_id = ? AND documentation_version = ? AND chunk_id = ?`,
        )
        .get(validatedDocumentId, this.documentationVersion, sectionId);
      if (!match) return null;
      selectedRows = rows.filter(
        (row) =>
          row.canonicalUrl === match.canonicalUrl &&
          row.headingPath === match.headingPath,
      );
    }

    return paginateDocumentation(
      validatedDocumentId,
      selectedRows,
      sectionId,
      cursor,
    );
  }

  onModuleDestroy(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
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

function toDocumentRow(row: Record<string, unknown>): DocumentRow {
  const { title, headingPath, canonicalUrl, sourceRevision, markdown } = row;
  if (
    typeof title !== 'string' ||
    typeof headingPath !== 'string' ||
    typeof canonicalUrl !== 'string' ||
    typeof sourceRevision !== 'string' ||
    typeof markdown !== 'string'
  ) {
    throw new Error('SQLite returned an invalid documentation row');
  }
  return { title, headingPath, canonicalUrl, sourceRevision, markdown };
}
