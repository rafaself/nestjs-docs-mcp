import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import type { NestJsDocumentationVersion } from '../documentation-version.js';
import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import type { DocumentationCorpus } from '../ingestion/types.js';
import {
  DEFAULT_SEARCH_RESULT_LIMIT,
  DOCUMENT_ID_PATTERN,
  MAX_FETCH_DOCUMENT_CHARS,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_QUERY_TERMS,
  MAX_SEARCH_RESULT_LIMIT,
} from './search.constants.js';
import { documentationVersionFromId } from '../documentation-version.js';
import {
  DOCUMENTATION_VERSION,
  SEARCH_DATABASE_PATH,
} from './search.tokens.js';

export interface DocumentationSearchResult {
  chunkId: string;
  documentId: string;
  title: string;
  canonicalUrl: string;
  sourceRevision: string;
  excerpt: string;
  score: number;
}

export interface DocumentationSectionResult {
  headingPath: string;
  canonicalUrl: string;
  markdown: string;
}

export interface FetchedDocumentation {
  documentId: string;
  title: string;
  sourceRevision: string;
  sections: DocumentationSectionResult[];
  truncated: boolean;
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

interface DocumentRow {
  title: string;
  headingPath: string;
  canonicalUrl: string;
  sourceRevision: string;
  markdown: string;
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

interface ExistingIndexRow {
  chunkId: string;
  title: string;
  headingPath: string;
  markdown: string;
  canonicalUrl: string;
  sourceRevision: string;
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
    const path =
      databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

    this.database = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.initializeSchema();
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  private initializeSchema(): void {
    const existing = this.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documentation_search'",
      )
      .get();
    if (existing) {
      const columns = this.database
        .prepare('PRAGMA table_info(documentation_search)')
        .all()
        .map((column) => column.name);
      if (!columns.includes('documentation_version')) {
        throw new Error(
          'The SQLite index predates documentation version isolation. Rebuild it with npm run search:index for each NESTJS_VERSION.',
        );
      }
    }
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documentation_search USING fts5(
        title,
        heading_path,
        markdown,
        documentation_version UNINDEXED,
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        canonical_url UNINDEXED,
        source_revision UNINDEXED,
        tokenize = 'unicode61'
      );
    `);
  }

  /** Synchronize this version's index with one ingested corpus. */
  indexCorpus(corpus: DocumentationCorpus): number {
    const chunks = validateCorpus(corpus, this.documentationVersion);
    const chunksByDocument = new Map<string, SearchChunk[]>();
    for (const chunk of chunks) {
      const documentChunks = chunksByDocument.get(chunk.documentId) ?? [];
      documentChunks.push(chunk);
      chunksByDocument.set(chunk.documentId, documentChunks);
    }
    const listExistingDocuments = this.database.prepare(
      'SELECT DISTINCT document_id AS documentId FROM documentation_search WHERE documentation_version = ?',
    );
    const existingRows = this.database.prepare(`
      SELECT chunk_id AS chunkId, title,
        heading_path AS headingPath, markdown,
        canonical_url AS canonicalUrl, source_revision AS sourceRevision
      FROM documentation_search
      WHERE document_id = ? AND documentation_version = ?
      ORDER BY rowid ASC
    `);
    const deleteDocument = this.database.prepare(
      'DELETE FROM documentation_search WHERE document_id = ? AND documentation_version = ?',
    );
    const updateRevision = this.database.prepare(
      'UPDATE documentation_search SET source_revision = ? WHERE document_id = ? AND documentation_version = ?',
    );
    const insert = this.database.prepare(`
      INSERT INTO documentation_search (
        title, heading_path, markdown, documentation_version, chunk_id,
        document_id, canonical_url, source_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let transactionStarted = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const existingDocumentIds = listExistingDocuments
        .all(this.documentationVersion)
        .map((row) => row.documentId);
      const incomingDocumentIds = new Set(chunksByDocument.keys());
      for (const documentId of existingDocumentIds) {
        if (
          typeof documentId === 'string' &&
          !incomingDocumentIds.has(documentId)
        ) {
          deleteDocument.run(documentId, this.documentationVersion);
        }
      }

      for (const [documentId, documentChunks] of chunksByDocument) {
        const current = existingRows
          .all(documentId, this.documentationVersion)
          .map(toExistingIndexRow);
        if (sameIndexedContent(current, documentChunks)) {
          updateRevision.run(
            documentChunks[0]!.sourceRevision,
            documentId,
            this.documentationVersion,
          );
          continue;
        }

        deleteDocument.run(documentId, this.documentationVersion);
        for (const chunk of documentChunks) {
          insert.run(
            chunk.title,
            chunk.headingPath.map((heading) => heading.title).join(' > '),
            chunk.markdown,
            this.documentationVersion,
            chunk.id,
            chunk.documentId,
            chunk.canonicalUrl,
            chunk.sourceRevision,
          );
        }
      }
      this.database.exec('COMMIT');
      transactionStarted = false;
      return chunks.length;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
          // SQLite can roll back a transaction automatically on disk-full errors.
        }
      }
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
  fetchDocument(documentId: unknown): FetchedDocumentation | null {
    if (
      typeof documentId !== 'string' ||
      !DOCUMENT_ID_PATTERN.test(documentId)
    ) {
      throw new BadRequestException(
        'Document ID must be a deterministic NestJS document ID',
      );
    }
    const idVersion = documentationVersionFromId(documentId);
    if (idVersion !== this.documentationVersion) {
      throw new BadRequestException(
        `Document ID belongs to NestJS v${idVersion}; this server is configured for v${this.documentationVersion}`,
      );
    }

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
      .all(documentId, this.documentationVersion)
      .map(toDocumentRow);
    const first = rows[0];
    if (!first) return null;

    const grouped: DocumentRow[] = [];
    for (const row of rows) {
      const previous = grouped.at(-1);
      if (
        previous?.canonicalUrl === row.canonicalUrl &&
        previous.headingPath === row.headingPath
      ) {
        previous.markdown += `\n\n${row.markdown}`;
      } else {
        grouped.push({ ...row });
      }
    }

    let remaining = MAX_FETCH_DOCUMENT_CHARS;
    let truncated = false;
    const sections: DocumentationSectionResult[] = [];
    for (const section of grouped) {
      const headingPath = section.headingPath || first.title;
      const framing = `\n\n## ${headingPath}\nSource: ${section.canonicalUrl}\n\n`;
      const available = remaining - framing.length;
      if (available <= 0) {
        truncated = true;
        break;
      }

      const clipped = truncate(section.markdown, available);
      sections.push({
        headingPath,
        canonicalUrl: section.canonicalUrl,
        markdown: clipped.text,
      });
      remaining -= framing.length + clipped.text.length;
      if (clipped.truncated) {
        truncated = true;
        break;
      }
    }
    if (sections.length < grouped.length) truncated = true;

    return {
      documentId,
      title: first.title,
      sourceRevision: first.sourceRevision,
      sections,
      truncated,
    };
  }

  onModuleDestroy(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

function validateCorpus(
  corpus: DocumentationCorpus,
  expectedVersion: NestJsDocumentationVersion,
): SearchChunk[] {
  if (
    !corpus ||
    typeof corpus !== 'object' ||
    !corpus.source ||
    corpus.source.version !== expectedVersion ||
    typeof corpus.source.ref !== 'string' ||
    !corpus.source.ref.trim() ||
    typeof corpus.source.revision !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(corpus.source.revision) ||
    !Array.isArray(corpus.documents) ||
    corpus.documents.length === 0
  ) {
    throw new Error(
      `Documentation corpus must contain documents for NestJS v${expectedVersion}`,
    );
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
      !document.source ||
      document.source.revision !== corpus.source.revision ||
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
        chunk.sourceRevision !== corpus.source.revision ||
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
      row.headingPath ===
        chunk.headingPath.map((heading) => heading.title).join(' > ') &&
      row.markdown === chunk.markdown &&
      row.canonicalUrl === chunk.canonicalUrl
    );
  });
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

function truncate(
  value: string,
  maxLength: number,
): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxLength) return { text: value, truncated: false };
  let end = maxLength;
  const before = value.charCodeAt(end - 1);
  const after = value.charCodeAt(end);
  if (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  ) {
    end -= 1;
  }
  return { text: value.slice(0, end), truncated: true };
}
