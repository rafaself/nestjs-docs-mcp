import type {
  DocumentationCorpus,
  DocumentationSnapshot,
} from '../../domain/documentation.types.js';
import type { DocumentationDocumentParser } from '../contracts/documentation-parser.contract.js';
import { DOCUMENTATION_REPOSITORY } from '../../domain/documentation-version.js';

export function ingestSnapshot(
  snapshot: DocumentationSnapshot,
  parseDocument: DocumentationDocumentParser,
  maxChunkChars = 4000,
): DocumentationCorpus {
  const paths = new Set<string>();
  const urls = new Set<string>();
  const documents = [...snapshot.documents]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      if (paths.has(file.path) || urls.has(file.canonicalUrl)) {
        throw new Error(`Duplicate documentation source: ${file.path}`);
      }
      paths.add(file.path);
      urls.add(file.canonicalUrl);
      return parseDocument(
        file,
        snapshot.revision,
        maxChunkChars,
        snapshot.version,
      );
    });
  if (!documents.length) throw new Error('Documentation snapshot is empty');
  return {
    source: {
      repository: DOCUMENTATION_REPOSITORY,
      version: snapshot.version,
      ref: snapshot.ref,
      revision: snapshot.revision,
    },
    documents,
  };
}
