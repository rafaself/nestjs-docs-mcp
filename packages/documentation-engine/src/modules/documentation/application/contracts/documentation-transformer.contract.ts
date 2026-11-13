import type {
  DocumentationSourceProvenance,
  NormalizedDocument,
  SourceDocument,
} from '../../domain/documentation.types.js';

export type DocumentationDocumentTransformer = (
  file: SourceDocument,
  source: DocumentationSourceProvenance,
  maxChunkChars: number,
) => NormalizedDocument;
