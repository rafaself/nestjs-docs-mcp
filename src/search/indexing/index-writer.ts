import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NestJsDocumentationVersion } from '../../documentation-version.js';
import { indexDocumentationCorpus } from './index-corpus.js';
import { DOCUMENTATION_INDEX_SCHEMA } from '../index-schema.js';

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
      this.database.exec(
        DOCUMENTATION_INDEX_SCHEMA.replace(
          'CREATE VIRTUAL TABLE ',
          'CREATE VIRTUAL TABLE IF NOT EXISTS ',
        ),
      );
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
