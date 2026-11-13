import { DynamicModule, Module, type Provider } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { parseDocumentationVersion } from './documentation-version.js';
import { DocumentationTools } from './mcp/documentation.tools.js';
import { McpTimingInterceptor } from './mcp/timing.interceptor.js';
import { searchDatabasePath } from './search/search.constants.js';
import { DocumentationSearchModule } from './search/search.module.js';

@Module({})
export class AppModule {
  static register(databasePath?: string): DynamicModule {
    const documentationVersion = parseDocumentationVersion(
      process.env.NESTJS_VERSION,
    );

    const resolvedDatabasePath =
      databasePath ??
      process.env.NESTJS_DOCS_SEARCH_DB ??
      searchDatabasePath(documentationVersion);
    const providers: Provider[] = [DocumentationTools];

    if (process.env.DEBUG === '1') {
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: McpTimingInterceptor,
      });
    }

    return {
      module: AppModule,
      imports: [
        McpModule.forRoot({
          name: 'nestjs-docs-mcp',
          version: '0.0.1',
          instructions:
            'Search the documentation version selected for this server; the version is fixed at startup. Use search_docs first, then fetch_docs with the returned IDs for more detail. Continue truncated results with the same IDs and returned cursor. Ground answers in the returned content and cite its URL and source revision; these indexes are snapshots, not live documentation.',
          http: {
            allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
          },
        }),
        DocumentationSearchModule.register(
          resolvedDatabasePath,
          documentationVersion,
        ),
      ],
      providers,
    };
  }
}
