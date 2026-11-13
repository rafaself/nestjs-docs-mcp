import { DynamicModule, Module } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';
import { DocumentationTools } from './documentation.tools.js';
import { DEFAULT_SEARCH_DATABASE_PATH } from './search/search.constants.js';
import { DocumentationSearchModule } from './search/search.module.js';

@Module({})
export class AppModule {
  static register(
    databasePath = process.env.NESTJS_DOCS_SEARCH_DB ??
      DEFAULT_SEARCH_DATABASE_PATH,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        McpModule.forRoot({
          name: 'nestjs-docs-mcp',
          version: '0.0.1',
          path: false,
        }),
        DocumentationSearchModule.register(databasePath),
      ],
      providers: [DocumentationTools],
    };
  }
}
