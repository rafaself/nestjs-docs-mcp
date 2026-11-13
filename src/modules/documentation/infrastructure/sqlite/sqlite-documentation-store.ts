import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { NestJsDocumentationVersion } from '../../domain/documentation-version.js';
import type {
  DocumentationRow,
  DocumentationSearchStore,
  DocumentationSectionReference,
} from '../../application/contracts/documentation-search-store.contract.js';
import type { DocumentationSearchResult } from '../../application/contracts/documentation-reader.contract.js';
import {
  DOCUMENTATION_VERSION,
  SEARCH_DATABASE_PATH,
} from '../../application/contracts/documentation.tokens.js';
import { MAX_SEARCH_RESULT_LIMIT } from '../../retrieval/search.constants.js';
import { validateRuntimeIndex } from './runtime-index.js';

@Injectable()
export class SQLiteDocumentationStore
  implements DocumentationSearchStore, OnModuleDestroy
{
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(
    @Inject(SEARCH_DATABASE_PATH) databasePath: string,
    @Inject(DOCUMENTATION_VERSION)
    readonly documentationVersion: NestJsDocumentationVersion,
  ) {
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

  search(expression: string, limit: number): DocumentationSearchResult[] {
    return this.database
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
        expression,
        this.documentationVersion,
        Math.min(limit, MAX_SEARCH_RESULT_LIMIT),
      )
      .map(toSearchResult);
  }

  fetchRows(documentId: string): DocumentationRow[] {
    return this.database
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
      .all(documentId, this.documentationVersion)
      .map(toDocumentationRow);
  }

  findSection(
    documentId: string,
    sectionId: string,
  ): DocumentationSectionReference | null {
    const row = this.database
      .prepare(
        `
        SELECT canonical_url AS canonicalUrl, heading_path AS headingPath
        FROM documentation_search
        WHERE document_id = ? AND documentation_version = ? AND chunk_id = ?
      `,
      )
      .get(documentId, this.documentationVersion, sectionId);
    if (!row) return null;
    const reference = row as Record<string, unknown>;
    if (
      typeof reference.canonicalUrl !== 'string' ||
      typeof reference.headingPath !== 'string'
    ) {
      throw new Error('SQLite returned an invalid documentation section row');
    }
    return {
      canonicalUrl: reference.canonicalUrl,
      headingPath: reference.headingPath,
    };
  }

  onModuleDestroy(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

function toSearchResult(
  row: Record<string, unknown>,
): DocumentationSearchResult {
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
    score: -rank,
  };
}

function toDocumentationRow(row: Record<string, unknown>): DocumentationRow {
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
