import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentationSearchService } from '../dist/search/search.service.js';

// The bundled indexes are copied because opening a search service initializes SQLite.
const cases = [
  {
    version: 11,
    query: 'ExecutionContext',
    expected: '/v11/fundamentals/execution-context#executioncontext-class',
  },
  {
    version: 11,
    query: 'streaming response StreamableFile Server Sent Events',
    expected: '/v11/techniques/streaming-files#',
  },
  {
    version: 12,
    query: 'ExecutionContext',
    expected: '/fundamentals/execution-context#executioncontext-class',
  },
  {
    version: 12,
    query: 'streaming response StreamableFile Server Sent Events',
    expected: '/http/streaming-responses#',
  },
  {
    version: 12,
    query: 'client disconnection abort upstream',
    expected: '/http/streaming-responses#client-disconnection',
  },
];
const directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-evaluation-'));
let failed = false;
try {
  for (const version of [11, 12]) {
    const source = fileURLToPath(
      new URL(`../data/documentation-v${version}.sqlite`, import.meta.url),
    );
    const destination = join(directory, `v${version}.sqlite`);
    await copyFile(source, destination);
    const service = new DocumentationSearchService(destination, version);
    try {
      for (const test of cases.filter((entry) => entry.version === version)) {
        const results = service.search(test.query, 5);
        const rank =
          results.findIndex((result) =>
            new URL(result.canonicalUrl).pathname
              .concat(new URL(result.canonicalUrl).hash)
              .startsWith(test.expected),
          ) + 1;
        console.log(
          JSON.stringify({
            version,
            query: test.query,
            expected: test.expected,
            rank: rank || null,
            revision: results[0]?.sourceRevision ?? null,
          }),
        );
        if (!rank) failed = true;
      }
    } finally {
      service.onModuleDestroy();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
