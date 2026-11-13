import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DocumentationVersion } from '../../../domain/documentation.types.js';
import { indexDocumentationCorpus } from './index-corpus.js';

/** Writable index connection used exclusively by indexing commands. */
export class DocumentationIndexWriter {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly version: DocumentationVersion,
  ) {
    if (!databasePath) throw new Error('A SQLite database path is required');
    const path =
      databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { timeout: 5000 });
  }

  indexCorpus(corpus: unknown): number {
    return indexDocumentationCorpus(this.database, this.version, corpus);
  }

  close(): void {
    this.database.close();
  }
}
