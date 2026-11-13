import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NestJsDocumentationVersion } from '../../documentation-version.js';
import { indexDocumentationCorpus } from './index-corpus.js';

/** Writable index connection used exclusively by indexing commands. */
export class DocumentationIndexWriter {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly version: NestJsDocumentationVersion,
  ) {
    if (!databasePath) throw new Error('A SQLite database path is required');
    const path =
      databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documentation_search USING fts5(
          title, heading_path, markdown,
          documentation_version UNINDEXED, chunk_id UNINDEXED,
          document_id UNINDEXED, canonical_url UNINDEXED,
          source_revision UNINDEXED, tokenize = 'unicode61'
        );
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  indexCorpus(corpus: unknown): number {
    return indexDocumentationCorpus(this.database, this.version, corpus);
  }

  close(): void {
    this.database.close();
  }
}
