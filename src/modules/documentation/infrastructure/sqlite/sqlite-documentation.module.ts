import { DynamicModule, Module } from '@nestjs/common';
import type { NestJsDocumentationVersion } from '../../domain/documentation-version.js';
import {
  DOCUMENTATION_SEARCH_STORE,
  DOCUMENTATION_VERSION,
  SEARCH_DATABASE_PATH,
} from '../../application/contracts/documentation.tokens.js';
import { SQLiteDocumentationStore } from './sqlite-documentation-store.js';

@Module({})
export class SQLiteDocumentationModule {
  static register(
    databasePath: string,
    documentationVersion: NestJsDocumentationVersion,
  ): DynamicModule {
    return {
      module: SQLiteDocumentationModule,
      providers: [
        { provide: SEARCH_DATABASE_PATH, useValue: databasePath },
        { provide: DOCUMENTATION_VERSION, useValue: documentationVersion },
        SQLiteDocumentationStore,
        {
          provide: DOCUMENTATION_SEARCH_STORE,
          useExisting: SQLiteDocumentationStore,
        },
      ],
      exports: [DOCUMENTATION_SEARCH_STORE, DOCUMENTATION_VERSION],
    };
  }
}
