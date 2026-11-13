import { readFile } from 'node:fs/promises';
import { readSourceIndex, readContentAliases } from '../../src/modules/documentation/infrastructure/github/documentation-source.js';
import type { DocumentationSnapshot } from '../../src/modules/documentation/domain/documentation.types.js';
import type { DocumentationCorpus } from '../../src/modules/documentation/domain/documentation.types.js';
import { ingestSnapshot as runDocumentationIngestion } from '../../src/modules/documentation/application/services/documentation-ingestion.service.js';
import { parseDocument } from '../../src/modules/documentation/infrastructure/markdown/markdown-parser.js';

export const revision = 'a'.repeat(40);
export function ingestSnapshot(
  snapshot: DocumentationSnapshot,
  maxChunkChars = 4000,
): DocumentationCorpus {
  return runDocumentationIngestion(snapshot, parseDocument, maxChunkChars);
}
export const fixture = (path: string): Promise<string> => readFile(new URL(`./documentation/${path}`, import.meta.url), 'utf8');
export async function loadIngestionFixtures(): Promise<{ snapshot: DocumentationSnapshot; index: string; aliases: string }> {
  const [index, aliases] = await Promise.all([fixture('navigation.txt'), fixture('aliases.txt')]);
  const entries = readSourceIndex(index, readContentAliases(aliases));
  const documents = await Promise.all(entries.map(async (entry) => ({ ...entry, markdown: await fixture(entry.path.replace(/^content\//, '')) })));
  return { index, aliases, snapshot: { version: 12, ref: 'master', revision, documents } };
}
