import { BadRequestException } from '@nestjs/common';
import {
  buildSearchExpression,
  validateDocumentId,
} from '@nestjs-docs/documentation-engine/retrieval/search-input.js';
import { loadSearchCorpus } from '../../../../fixtures/search.fixtures.js';
import { TestSearchIndex as DocumentationSearchService } from '../../../../fixtures/test-search-index.js';

describe('DocumentationSearchService', () => {
  let service: DocumentationSearchService;
  beforeEach(() => {
    service = new DocumentationSearchService(':memory:', '12');
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

  it('treats FTS operators as search text and rejects control characters', async () => {
    service.indexCorpus(await loadSearchCorpus());
    expect(
      service.search('ExecutionContext OR nonexistentidentifier')[0]?.excerpt,
    ).toContain('ExecutionContext');
    expect(() => service.search('guard\0request')).toThrow(
      'control characters',
    );
    expect(service.search('guard\nrequest').length).toBeGreaterThan(0);
    expect(() =>
      service.search(
        Array.from({ length: 33 }, (_, index) => `word${index}`).join(' '),
      ),
    ).toThrow('at most 32 terms');
  });

  it('adds a quoted phrase while keeping query terms out of the FTS language', () => {
    expect(buildSearchExpression('request scoped providers', 10)).toBe(
      '"request scoped providers" OR "request" OR "scoped" OR "providers"',
    );
    expect(buildSearchExpression('one OR title:*', 10)).toBe(
      '"one OR title" OR "one" OR "OR" OR "title"',
    );
  });

  it('validates query input and bounds the result limit', () => {
    expect(() => service.search(42)).toThrow(BadRequestException);
    expect(() => service.search('x'.repeat(257))).toThrow(BadRequestException);
    expect(() => service.search('guard', 0)).toThrow(BadRequestException);
  });

  it('accepts opaque generic document IDs and rejects invalid identifiers', () => {
    expect(validateDocumentId('article:release-candidate/1')).toBe(
      'article:release-candidate/1',
    );
    expect(() => validateDocumentId('')).toThrow('non-empty string');
    expect(() => validateDocumentId('bad\0id')).toThrow('non-empty string');
    expect(() => validateDocumentId('x'.repeat(513))).toThrow(
      'non-empty string',
    );
  });
});
