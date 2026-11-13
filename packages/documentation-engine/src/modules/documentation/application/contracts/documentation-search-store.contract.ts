import type { DocumentationSearchResult } from './documentation-reader.contract.js';

export interface DocumentationRow {
  title: string;
  headingPath: string;
  canonicalUrl: string;
  sourceRevision: string;
  markdown: string;
}

export interface DocumentationSectionReference {
  canonicalUrl: string;
  headingPath: string;
}

export interface DocumentationSearchStore {
  search(expression: string, limit: number): DocumentationSearchResult[];
  fetchRows(documentId: string): DocumentationRow[];
  findSection(
    documentId: string,
    sectionId: string,
  ): DocumentationSectionReference | null;
}
