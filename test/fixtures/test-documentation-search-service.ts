import type { NestJsDocumentationVersion } from '../../src/modules/documentation/domain/documentation-version.js';
import type { DatabaseSync } from 'node:sqlite';
import { DocumentationSearchService } from '../../src/modules/documentation/application/services/documentation-search.service.js';
import { SQLiteDocumentationStore } from '../../src/modules/documentation/infrastructure/sqlite/sqlite-documentation-store.js';

/** Test-only convenience for direct calls without a Nest application context. */
export class TestDocumentationSearchService extends DocumentationSearchService {
  private readonly sqliteStore: SQLiteDocumentationStore;
  readonly database: DatabaseSync;

  constructor(databasePath: string, version: NestJsDocumentationVersion) {
    const store = new SQLiteDocumentationStore(databasePath, version);
    super(store, version);
    this.sqliteStore = store;
    this.database = (store as unknown as { database: DatabaseSync }).database;
  }

  onModuleDestroy(): void {
    this.sqliteStore.onModuleDestroy();
  }
}
