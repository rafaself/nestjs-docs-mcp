import { BadRequestException } from '@nestjs/common';
import { ingestSnapshot } from '../src/ingestion/pipeline.js';
import { DocumentationSearchService } from '../src/search/search.service.js';
import { loadSearchCorpus } from './search.fixtures.js';

describe('DocumentationSearchService', () => {
  let service: DocumentationSearchService;

  beforeEach(() => {
    service = new DocumentationSearchService(':memory:');
  });

  afterEach(() => service.onModuleDestroy());

  it('ranks the section matching a natural-language query first', async () => {
    const corpus = await loadSearchCorpus();
    service.indexCorpus(corpus);

    const results = service.search('guard inspect request context');

    expect(results.length).toBeGreaterThan(1);
    expect(results[0]).toMatchObject({
      documentId: corpus.documents[0]?.id,
      title: 'Authorization guards',
      canonicalUrl: 'https://docs.nestjs.com/guards#inspecting-request-context',
    });
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.excerpt).toContain('request');
  });

  it.each(['ExecutionContext', '@Injectable()'])(
    'finds the exact technical identifier %s',
    async (query) => {
      const corpus = await loadSearchCorpus();
      service.indexCorpus(corpus);

      const results = service.search(query);

      expect(results[0]?.documentId).toBe(corpus.documents[0]?.id);
      expect(results[0]?.canonicalUrl).toContain('/guards#');
      expect(results[0]?.sourceRevision).toBe('c'.repeat(40));
    },
  );

  it('returns no matches for an empty query', () => {
    expect(service.search('')).toEqual([]);
    expect(service.search('   ')).toEqual([]);
  });

  it('validates query input and bounds the result limit', () => {
    expect(() => service.search(42)).toThrow(BadRequestException);
    expect(() => service.search('x'.repeat(257))).toThrow(BadRequestException);
    expect(() => service.search('guard', 0)).toThrow(BadRequestException);
  });

  it('caps requested results at the maximum and replaces the previous index', () => {
    const revision = 'd'.repeat(40);
    const corpus = ingestSnapshot({
      revision,
      documents: Array.from({ length: 55 }, (_, index) => ({
        path: `content/guard-${index}.md`,
        canonicalUrl: `https://docs.nestjs.com/guard-${index}`,
        markdown: `# Guard ${index}\n\nA guard checks access.`,
      })),
    });

    expect(service.indexCorpus(corpus)).toBe(55);
    expect(service.search('guard', 500)).toHaveLength(50);

    const smallerCorpus = ingestSnapshot({
      revision,
      documents: [
        {
          path: 'content/replacement.md',
          canonicalUrl: 'https://docs.nestjs.com/replacement',
          markdown: '# Replacement\n\nA guard checks access.',
        },
      ],
    });
    expect(service.indexCorpus(smallerCorpus)).toBe(1);
    expect(service.search('guard', 500)).toHaveLength(1);
  });
});
