import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ingestSnapshot, makeNestJsSnapshot } from './ingestion.fixtures.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { TestDocumentationSearchService as DocumentationSearchService } from './test-documentation-search-service.js';

/** Test fixture that creates a real index before opening the read-only reader. */
export class TestSearchIndex {
  private readonly directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-test-'));
  private readonly path: string;
  private readonly writer: DocumentationIndexWriter;
  private reader: DocumentationSearchService;
  readonly database: DatabaseSync;

  constructor(path: string, private readonly version: '11' | '12') {
    this.path = path === ':memory:' ? join(this.directory, 'index.sqlite') : path;
    this.writer = new DocumentationIndexWriter(this.path, version);
    this.database = (this.writer as unknown as { database: DatabaseSync }).database;
    this.writer.indexCorpus(
      ingestSnapshot(
        makeNestJsSnapshot(version, [
          {
            path: 'content/seed.md',
            canonicalUrl: 'https://docs.nestjs.com/seed',
            markdown: '# Seed\n\ninitial placeholder',
          },
        ]),
      ),
    );
    this.reader = new DocumentationSearchService(this.path, version);
  }

  indexCorpus(corpus: unknown): number {
    const result = this.writer.indexCorpus(corpus);
    this.reader.onModuleDestroy();
    this.reader = new DocumentationSearchService(this.path, this.version);
    return result;
  }

  search(...args: Parameters<DocumentationSearchService['search']>) {
    return this.reader.search(...args);
  }

  fetchDocument(...args: Parameters<DocumentationSearchService['fetchDocument']>) {
    return this.reader.fetchDocument(...args);
  }

  onModuleDestroy(): void {
    this.reader.onModuleDestroy();
    this.writer.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
