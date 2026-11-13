import type { NestJsDocumentationVersion } from './documentation-version.js';

export interface SourceDocument {
  path: string;
  canonicalUrl: string;
  markdown: string;
}

export interface DocumentationSnapshot {
  version: NestJsDocumentationVersion;
  ref: string;
  revision: string;
  documents: SourceDocument[];
}

export interface Heading {
  level: number;
  title: string;
  slug: string;
}

export interface CodeExample {
  language: string;
  filename?: string;
  code: string;
}

export interface DocumentationChunk {
  id: string;
  documentId: string;
  index: number;
  title: string;
  canonicalUrl: string;
  sourceRevision: string;
  headingPath: Heading[];
  markdown: string;
  contentHash: string;
  codeExamples: CodeExample[];
}

export interface DocumentationDocument {
  id: string;
  title: string;
  canonicalUrl: string;
  source: {
    repository: string;
    revision: string;
    path: string;
    url: string;
    contentHash: string;
  };
  markdown: string;
  contentHash: string;
  headings: Heading[];
  chunks: DocumentationChunk[];
}

export interface DocumentationCorpus {
  source: {
    repository: string;
    version: NestJsDocumentationVersion;
    ref: string;
    revision: string;
  };
  documents: DocumentationDocument[];
}
