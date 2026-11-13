import type { NestJsDocumentationVersion } from '../../domain/documentation-version.js';

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
  nextCursor?: string;
}

export interface DocumentationReader {
  readonly documentationVersion: NestJsDocumentationVersion;
  search(query: unknown, limit?: number): DocumentationSearchResult[];
  fetchDocument(
    documentId: unknown,
    sectionId?: string,
    cursor?: string,
  ): FetchedDocumentation | null;
}
