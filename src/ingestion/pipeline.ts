import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from './markdown.js';
import { REPOSITORY } from './source.js';
import type { DocumentationCorpus, DocumentationSnapshot } from './types.js';

export function ingestSnapshot(
  snapshot: DocumentationSnapshot,
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
      repository: REPOSITORY,
      version: snapshot.version,
      ref: snapshot.ref,
      revision: snapshot.revision,
    },
    documents,
  };
}

/** Replace the output only after the entire snapshot has been processed. */
export async function writeCorpus(
  corpus: DocumentationCorpus,
  output: string,
): Promise<void> {
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.ingestion-'));
  try {
    const temporary = join(staging, 'documentation.json');
    await writeFile(temporary, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
    await rename(temporary, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
