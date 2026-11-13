import { DynamicModule, Module } from '@nestjs/common';
import type { NestJsDocumentationVersion } from './domain/documentation-version.js';
import { DOCUMENTATION_READER } from './application/contracts/documentation.tokens.js';
import { DocumentationSearchService } from './application/services/documentation-search.service.js';
import { SQLiteDocumentationModule } from './infrastructure/sqlite/sqlite-documentation.module.js';

@Module({})
export class DocumentationModule {
  static register(
    databasePath: string,
    documentationVersion: NestJsDocumentationVersion,
  ): DynamicModule {
    return {
      module: DocumentationModule,
      imports: [
        SQLiteDocumentationModule.register(databasePath, documentationVersion),
      ],
      providers: [
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
