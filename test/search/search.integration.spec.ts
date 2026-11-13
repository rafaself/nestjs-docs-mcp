import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { DocumentationSearchModule } from '../../src/search/search.module.js';
import { DocumentationSearchService } from '../../src/search/search.service.js';
import { loadSearchCorpus } from '../fixtures/search.fixtures.js';

describe('documentation search integration', () => {
  let directory: string;
  let app: INestApplicationContext;
  let service: DocumentationSearchService;
  let corpus: Awaited<ReturnType<typeof loadSearchCorpus>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-search-'));
    corpus = await loadSearchCorpus();
    app = await NestFactory.createApplicationContext(
      DocumentationSearchModule.register(join(directory, 'search.sqlite'), 12),
      { logger: false },
    );
    service = app.get(DocumentationSearchService);
    service.indexCorpus(corpus);
  });

  afterAll(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('discovers relevant sections through the standalone Nest module', () => {
    const [top, next] = service.search('guard inspect request context');

    expect(top?.documentId).toBe(corpus.documents[0]?.id);
    expect(top?.score).toBeGreaterThan(next?.score ?? 0);
    expect(top?.canonicalUrl).toBe(
      'https://docs.nestjs.com/guards#inspecting-request-context',
    );
  });

  it.each(['ExecutionContext', '@Injectable()'])(
    'invokes search for technical identifier %s',
    (query) => {
      const results = service.search(query);

      expect(results[0]?.documentId).toBe(corpus.documents[0]?.id);
      expect(results[0]?.excerpt).toBeTruthy();
      expect(results[0]?.sourceRevision).toBe('c'.repeat(40));
    },
  );

  it('returns no results for empty queries', () => {
    expect(service.search('')).toEqual([]);
    expect(service.search('  \n ')).toEqual([]);
  });
});
