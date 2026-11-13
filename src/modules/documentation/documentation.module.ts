import { DynamicModule, Module } from '@nestjs/common';
import type { DocumentationIndexRuntimeManifest } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import { DOCUMENTATION_READER } from '@nestjs-docs/documentation-engine/application/contracts/documentation.tokens.js';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { SQLiteDocumentationModule } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation.module.js';

@Module({})
export class DocumentationModule {
  static register(
    databasePath: string,
    indexManifest: DocumentationIndexRuntimeManifest,
  ): DynamicModule {
    return {
      module: DocumentationModule,
      imports: [
        SQLiteDocumentationModule.register(databasePath, indexManifest),
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
