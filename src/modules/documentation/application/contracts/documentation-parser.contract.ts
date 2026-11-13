import type {
  DocumentationDocument,
  DocumentationSnapshot,
  SourceDocument,
} from '../../domain/documentation.types.js';

export type DocumentationDocumentParser = (
  file: SourceDocument,
  revision: string,
  maxChunkChars: number,
  version: DocumentationSnapshot['version'],
) => DocumentationDocument;
