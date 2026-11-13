import { TestDocumentationSearchService as DocumentationSearchService } from '../../../../fixtures/test-documentation-search-service.js';
import { searchDatabasePath } from '../../../../../src/modules/documentation/infrastructure/sqlite/index-paths.js';

describe('documentation search ranking against bundled indexes', () => {
  it.each([11, 12] as const)(
    'ranks request-scoped provider documentation first for NestJS v%i',
    (version) => {
      const service = new DocumentationSearchService(
        searchDatabasePath(version),
        version,
      );
      try {
        const result = service.search('request scoped providers')[0];
        expect(result?.canonicalUrl).toContain(
          version === 11
            ? '/v11/fundamentals/injection-scopes'
            : '/fundamentals/injection-scopes',
        );
      } finally {
        service.onModuleDestroy();
      }
    },
  );

  it.each([11, 12] as const)(
    'keeps exact identifier and lifecycle queries useful for NestJS v%i',
    (version) => {
      const service = new DocumentationSearchService(
        searchDatabasePath(version),
        version,
      );
      try {
        expect(service.search('ExecutionContext')[0]?.canonicalUrl).toContain(
          version === 11
            ? '/v11/fundamentals/execution-context#executioncontext-class'
            : '/fundamentals/execution-context#executioncontext-class',
        );
        expect(
          service.search('HTTP request lifecycle')[0]?.canonicalUrl,
        ).toContain(
          version === 11
            ? '/v11/faq/request-lifecycle'
            : '/faq/request-lifecycle',
        );
        const streamResults = service.search(
          'How can I stream a file from a controller?',
          5,
        );
        expect(
          streamResults.some((result) =>
            result.canonicalUrl.includes(
              version === 11
                ? '/v11/techniques/streaming-files'
                : '/http/file-upload',
            ),
          ),
        ).toBe(true);
      } finally {
        service.onModuleDestroy();
      }
    },
  );
});
