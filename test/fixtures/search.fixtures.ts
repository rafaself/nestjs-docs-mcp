import { readFile } from 'node:fs/promises';
import { ingestSnapshot } from './ingestion.fixtures.js';
import type { DocumentationSnapshot } from '../../src/modules/documentation/domain/documentation.types.js';

const revision = 'c'.repeat(40);

export async function loadSearchCorpus() {
  const documents = await Promise.all(
    [
      {
        path: 'content/search-guards.md',
        canonicalUrl: 'https://docs.nestjs.com/guards',
      },
      {
        path: 'content/search-request-context.md',
        canonicalUrl: 'https://docs.nestjs.com/fundamentals/injection-scopes',
      },
    ].map(async (source) => ({
      ...source,
      markdown: await readFile(
        new URL(
          `./documentation/${source.path.replace('content/', '')}`,
          import.meta.url,
        ),
        'utf8',
      ),
    })),
  );
  const snapshot: DocumentationSnapshot = {
    version: 12,
    ref: 'master',
    revision,
    documents,
  };
  return ingestSnapshot(snapshot, 240);
}
