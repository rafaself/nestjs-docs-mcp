import { DynamicModule, Module } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';
import { parseDocumentationVersion } from './documentation-version.js';
import { DocumentationTools } from './mcp/documentation.tools.js';
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
    return {
      module: AppModule,
      imports: [
        McpModule.forRoot({
          name: 'nestjs-docs-mcp',
          version: '0.0.1',
          path: false,
        }),
        DocumentationSearchModule.register(
          resolvedDatabasePath,
          documentationVersion,
        ),
      ],
      providers: [DocumentationTools],
    };
  }
}
