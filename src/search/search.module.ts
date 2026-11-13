import { DynamicModule, Module } from '@nestjs/common';
import { DEFAULT_SEARCH_DATABASE_PATH } from './search.constants.js';
import { DocumentationSearchService } from './search.service.js';
import { SEARCH_DATABASE_PATH } from './search.tokens.js';

@Module({})
export class DocumentationSearchModule {
  static register(databasePath = DEFAULT_SEARCH_DATABASE_PATH): DynamicModule {
    return {
      module: DocumentationSearchModule,
      providers: [
        { provide: SEARCH_DATABASE_PATH, useValue: databasePath },
        DocumentationSearchService,
      ],
      exports: [DocumentationSearchService],
    };
  }
}
