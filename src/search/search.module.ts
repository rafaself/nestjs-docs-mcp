import { DynamicModule, Module } from '@nestjs/common';
import type { NestJsDocumentationVersion } from '../documentation-version.js';
import { DocumentationSearchService } from './search.service.js';
import {
  DOCUMENTATION_READER,
  DOCUMENTATION_VERSION,
  SEARCH_DATABASE_PATH,
} from './search.tokens.js';

@Module({})
export class DocumentationSearchModule {
  static register(
    databasePath: string,
    documentationVersion: NestJsDocumentationVersion,
  ): DynamicModule {
    return {
      module: DocumentationSearchModule,
      providers: [
        { provide: SEARCH_DATABASE_PATH, useValue: databasePath },
        {
          provide: DOCUMENTATION_VERSION,
          useValue: documentationVersion,
        },
        DocumentationSearchService,
        {
          provide: DOCUMENTATION_READER,
          useExisting: DocumentationSearchService,
        },
      ],
      exports: [DocumentationSearchService, DOCUMENTATION_READER],
    };
  }
}
