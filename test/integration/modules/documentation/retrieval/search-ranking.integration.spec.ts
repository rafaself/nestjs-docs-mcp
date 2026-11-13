import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ingestNestJsDocuments } from '../../../../fixtures/ingestion.fixtures.js';
import { TestDocumentationSearchService as DocumentationSearchService } from '../../../../fixtures/test-documentation-search-service.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';

type PackagedCorpus = {
  source: { revision: string };
  documents: Array<{
    source: { path: string };
    canonicalUrl: string;
    markdown: string;
  }>;
};

describe('documentation search ranking against the documentation corpora', () => {
  let directory: string;
  const databasePaths = new Map<'11' | '12', string>();

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-ranking-'));
    for (const version of ['11', '12'] as const) {
      const storedCorpus = JSON.parse(
        readFileSync(
          resolve(process.cwd(), `data/documentation-v${version}.json`),
          'utf8',
        ),
      ) as PackagedCorpus;
      const corpus = ingestNestJsDocuments(
        version,
        storedCorpus.documents.map((document) => ({
          path: document.source.path,
          canonicalUrl: document.canonicalUrl,
          markdown: document.markdown,
        })),
        storedCorpus.source.revision,
      );
      const databasePath = join(directory, `documentation-v${version}.sqlite`);
      const writer = new DocumentationIndexWriter(databasePath, version);
      writer.indexCorpus(corpus);
      writer.close();
      databasePaths.set(version, databasePath);
    }
  });

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function search(version: '11' | '12', query: string, limit?: number) {
    const service = new DocumentationSearchService(
      databasePaths.get(version)!,
      version,
    );
    try {
      return service.search(query, limit);
    } finally {
      service.onModuleDestroy();
    }
  }

  it.each(['11', '12'] as const)(
    'ranks request-scoped provider documentation first for NestJS v%s',
    (version) => {
      const result = search(version, 'request scoped providers')[0];
      expect(result?.canonicalUrl).toContain(
        version === '11'
          ? '/v11/fundamentals/injection-scopes'
          : '/fundamentals/injection-scopes',
      );
    },
  );

  it.each(['11', '12'] as const)(
    'keeps exact identifier and lifecycle queries useful for NestJS v%s',
    (version) => {
      expect(search(version, 'ExecutionContext')[0]?.canonicalUrl).toContain(
        version === '11'
          ? '/v11/fundamentals/execution-context#executioncontext-class'
          : '/fundamentals/execution-context#executioncontext-class',
      );
      expect(
        search(version, 'HTTP request lifecycle')[0]?.canonicalUrl,
      ).toContain(
        version === '11'
          ? '/v11/faq/request-lifecycle'
          : '/faq/request-lifecycle',
      );
      const streamResults = search(
        version,
        'How can I stream a file from a controller?',
        5,
      );
      expect(
        streamResults.some((result) =>
          result.canonicalUrl.includes(
            version === '11'
              ? '/v11/techniques/streaming-files'
              : '/http/file-upload',
          ),
        ),
      ).toBe(true);
    },
  );
});
