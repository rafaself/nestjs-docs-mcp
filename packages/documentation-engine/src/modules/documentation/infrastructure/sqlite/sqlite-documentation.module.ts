import { DynamicModule, Module } from '@nestjs/common';
import type { DocumentationIndexRuntimeManifest } from '../../domain/documentation-index-manifest.schemas.js';
import {
  DOCUMENTATION_SEARCH_STORE,
  DOCUMENTATION_INDEX_MANIFEST,
  SEARCH_DATABASE_PATH,
} from '../../application/contracts/documentation.tokens.js';
import { SQLiteDocumentationStore } from './sqlite-documentation-store.js';

@Module({})
export class SQLiteDocumentationModule {
  static register(
    databasePath: string,
    indexManifest: DocumentationIndexRuntimeManifest,
  ): DynamicModule {
    return {
      module: SQLiteDocumentationModule,
      providers: [
        { provide: SEARCH_DATABASE_PATH, useValue: databasePath },
        { provide: DOCUMENTATION_INDEX_MANIFEST, useValue: indexManifest },
        SQLiteDocumentationStore,
        {
          provide: DOCUMENTATION_SEARCH_STORE,
          useExisting: SQLiteDocumentationStore,
        },
      ],
      exports: [DOCUMENTATION_SEARCH_STORE, DOCUMENTATION_INDEX_MANIFEST],
    };
  }
}
