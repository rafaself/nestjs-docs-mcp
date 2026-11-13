import type {
  DocumentationCorpus,
  DocumentationSnapshot,
  NormalizedDocument,
  SourceDocument,
} from '../../domain/documentation.types.js';
import {
  DocumentationCorpusSchema,
  DocumentationSnapshotSchema,
} from '../../domain/documentation.schemas.js';
import type { DocumentationDocumentTransformer } from '../contracts/documentation-transformer.contract.js';

export interface DocumentationSnapshotIngestionOptions {
  reuseDocument?: (
    file: SourceDocument,
    source: DocumentationSnapshot['source'],
  ) => NormalizedDocument | undefined;
}

export function ingestSnapshot(
  snapshot: DocumentationSnapshot,
  transformDocument: DocumentationDocumentTransformer,
  maxChunkChars = 4000,
  options: DocumentationSnapshotIngestionOptions = {},
): DocumentationCorpus {
  const validatedSnapshot = DocumentationSnapshotSchema.parse(snapshot);
  const paths = new Set<string>();
  const urls = new Set<string>();
  const ids = new Set<string>();
  const documents = [...validatedSnapshot.documents]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      if (
        paths.has(file.path) ||
        urls.has(file.canonicalUrl) ||
        ids.has(file.id)
      ) {
        throw new Error(`Duplicate documentation source: ${file.path}`);
      }
      paths.add(file.path);
      urls.add(file.canonicalUrl);
      ids.add(file.id);
      return (
        options.reuseDocument?.(file, validatedSnapshot.source) ??
        transformDocument(file, validatedSnapshot.source, maxChunkChars)
      );
    });
  if (!documents.length) throw new Error('Documentation snapshot is empty');
  return DocumentationCorpusSchema.parse({
    version: validatedSnapshot.version,
    source: validatedSnapshot.source,
    documents,
  });
}
