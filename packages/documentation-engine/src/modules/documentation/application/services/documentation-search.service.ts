import { Inject, Injectable } from '@nestjs/common';
import type { DocumentationIdentity } from '../../domain/documentation.types.js';
import type { DocumentationIndexRuntimeManifest } from '../../domain/documentation-index-manifest.schemas.js';
import type {
  DocumentationReader,
  DocumentationSearchResult,
  FetchedDocumentation,
} from '../contracts/documentation-reader.contract.js';
import type { DocumentationSearchStore } from '../contracts/documentation-search-store.contract.js';
import {
  DOCUMENTATION_SEARCH_STORE,
  DOCUMENTATION_INDEX_MANIFEST,
} from '../contracts/documentation.tokens.js';
import {
  DEFAULT_SEARCH_RESULT_LIMIT,
  MAX_SEARCH_RESULT_LIMIT,
} from '../../retrieval/search.constants.js';
import {
  buildSearchExpression,
  validateDocumentId,
} from '../../retrieval/search-input.js';
import { paginateDocumentation } from '../../retrieval/document-page.js';

@Injectable()
export class DocumentationSearchService implements DocumentationReader {
  constructor(
    @Inject(DOCUMENTATION_SEARCH_STORE)
    private readonly store: DocumentationSearchStore,
    @Inject(DOCUMENTATION_INDEX_MANIFEST)
    private readonly indexManifest: DocumentationIndexRuntimeManifest,
  ) {}

  get documentation(): DocumentationIdentity {
    return this.indexManifest.documentation;
  }

  /** Search indexed sections. FTS operators are not accepted from user input. */
  search(
    query: unknown,
    limit = DEFAULT_SEARCH_RESULT_LIMIT,
  ): DocumentationSearchResult[] {
    const matchExpression = buildSearchExpression(query, limit);
    if (!matchExpression) return [];
    return this.store.search(
      matchExpression,
      Math.min(limit, MAX_SEARCH_RESULT_LIMIT),
    );
  }

  /** Fetch one document by its deterministic ingestion identifier. */
  fetchDocument(
    documentId: unknown,
    sectionId?: string,
    cursor?: string,
  ): FetchedDocumentation | null {
    const validatedDocumentId = validateDocumentId(documentId);
    const rows = this.store.fetchRows(validatedDocumentId);
    const first = rows[0];
    if (!first) return null;

    let selectedRows = rows;
    if (sectionId) {
      const match = this.store.findSection(validatedDocumentId, sectionId);
      if (!match) return null;
      selectedRows = rows.filter(
        (row) =>
          row.canonicalUrl === match.canonicalUrl &&
          row.headingPath === match.headingPath,
      );
    }

    return paginateDocumentation(
      this.documentation,
      validatedDocumentId,
      selectedRows,
      sectionId,
      cursor,
    );
  }
}
