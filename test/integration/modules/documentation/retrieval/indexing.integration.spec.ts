import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ingestNestJsDocuments } from '../../../../fixtures/ingestion.fixtures.js';
import { loadSearchCorpus } from '../../../../fixtures/search.fixtures.js';
import { TestSearchIndex as DocumentationSearchService } from '../../../../fixtures/test-search-index.js';

describe('DocumentationSearchService', () => {
  let service: DocumentationSearchService;
  beforeEach(() => {
    service = new DocumentationSearchService(':memory:', '12');
  });
  afterEach(() => service.onModuleDestroy());

  it('caps requested results at the maximum and replaces the previous index', () => {
    const revision = 'd'.repeat(40);
    const corpus = ingestNestJsDocuments(
      '12',
      Array.from({ length: 55 }, (_, index) => ({
        path: `content/guard-${index}.md`,
        canonicalUrl: `https://docs.nestjs.com/guard-${index}`,
        markdown: `# Guard ${index}\n\nA guard checks access.`,
      })),
      revision,
    );

    expect(service.indexCorpus(corpus)).toBe(55);
    expect(service.search('guard', 500)).toHaveLength(50);

    const smallerCorpus = ingestNestJsDocuments(
      '12',
      [
        {
          path: 'content/replacement.md',
          canonicalUrl: 'https://docs.nestjs.com/replacement',
          markdown: '# Replacement\n\nA guard checks access.',
        },
      ],
      revision,
    );
    expect(service.indexCorpus(smallerCorpus)).toBe(1);
    expect(service.search('guard', 500)).toHaveLength(1);
  });

  it('updates changed documents, removes deleted ones, and retains unchanged rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-sync-'));
    const databasePath = join(directory, 'documentation.sqlite');
    const syncService = new DocumentationSearchService(databasePath, '12');
    const database = new DatabaseSync(databasePath);
    try {
      const initial = ingestNestJsDocuments(
        '12',
        [
          {
            path: 'content/changed.md',
            canonicalUrl: 'https://docs.nestjs.com/changed',
            markdown: '# Changed\n\noldmarker appears here.',
          },
          {
            path: 'content/deleted.md',
            canonicalUrl: 'https://docs.nestjs.com/deleted',
            markdown: '# Deleted\n\nremoveMarker appears here.',
          },
          {
            path: 'content/stable.md',
            canonicalUrl: 'https://docs.nestjs.com/stable',
            markdown: '# Stable\n\nkeepMarker appears here.',
          },
        ],
        'a'.repeat(40),
      );
      syncService.indexCorpus(initial);
      const initialRowId = (documentId: string): number =>
        database
          .prepare(
            'SELECT rowid AS rowId FROM documentation_search WHERE document_id = ? AND documentation_version = ?',
          )
          .get(documentId, '12')!.rowId as number;
      const stableRowId = initialRowId(
        initial.documents.find((document) => document.title === 'Stable')!.id,
      );

      const updated = ingestNestJsDocuments(
        '12',
        [
          {
            path: 'content/changed.md',
            canonicalUrl: 'https://docs.nestjs.com/changed',
            markdown: '# Changed\n\nnewmarker appears here.',
          },
          {
            path: 'content/stable.md',
            canonicalUrl: 'https://docs.nestjs.com/stable',
            markdown: '# Stable\n\nkeepMarker appears here.',
          },
        ],
        'b'.repeat(40),
      );
      syncService.indexCorpus(updated);

      const stableId = updated.documents.find(
        (document) => document.title === 'Stable',
      )!.id;
      const changedId = updated.documents.find(
        (document) => document.title === 'Changed',
      )!.id;
      const deletedId = initial.documents.find(
        (document) => document.title === 'Deleted',
      )!.id;

      expect(initialRowId(stableId)).toBe(stableRowId);
      expect(
        database
          .prepare(
            'SELECT markdown FROM documentation_search WHERE document_id = ? AND documentation_version = ?',
          )
          .get(changedId, '12')?.markdown,
      ).toContain('newmarker');
      expect(syncService.search('keepMarker')).toHaveLength(1);
      expect(syncService.search('oldmarker')).toEqual([]);
      expect(syncService.search('newmarker')).toHaveLength(1);
      expect(syncService.search('removeMarker')).toEqual([]);
      expect(syncService.fetchDocument(deletedId)).toBeNull();
      expect(syncService.search('newmarker')[0]?.sourceRevision).toBe(
        'b'.repeat(40),
      );
    } finally {
      database.close();
      syncService.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves the previous index when a synchronization corpus is invalid', () => {
    const corpus = ingestNestJsDocuments(
      '12',
      [
        {
          path: 'content/stable.md',
          canonicalUrl: 'https://docs.nestjs.com/stable',
          markdown: '# Stable\n\npreserveMarker remains searchable.',
        },
      ],
      'c'.repeat(40),
    );
    service.indexCorpus(corpus);
    const invalidCorpus = {
      ...corpus,
      version: '11',
    };

    expect(() => service.indexCorpus(invalidCorpus)).toThrow(
      'Documentation corpus must contain documents for version "12"',
    );
    expect(service.search('preserveMarker')).toHaveLength(1);
    expect(service.fetchDocument(corpus.documents[0]!.id)).not.toBeNull();
  });

  it('rejects malformed corpus documents and chunks before changing the index', async () => {
    const corpus = await loadSearchCorpus();
    service.indexCorpus(corpus);
    const existing = service.search('ExecutionContext');
    const document = corpus.documents[0]!;
    const chunk = document.chunks[0]!;
    const invalidValues: unknown[] = [
      null,
      { ...corpus, documents: [{ ...document, title: 42 }] },
      {
        ...corpus,
        documents: [{ ...document, chunks: [{ ...chunk, markdown: null }] }],
      },
      { ...corpus, documents: [document, document] },
    ];
    for (const value of invalidValues) {
      expect(() => service.indexCorpus(value)).toThrow();
      expect(service.search('ExecutionContext')).toEqual(existing);
    }
  });

  it('rolls back a failed document update without dropping the previous content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-failed-sync-'));
    const databasePath = join(directory, 'documentation.sqlite');
    const syncService = new DocumentationSearchService(databasePath, '12');
    const database = (syncService as unknown as { database: DatabaseSync })
      .database;
    try {
      const initial = ingestNestJsDocuments(
        '12',
        [
          {
            path: 'content/stable.md',
            canonicalUrl: 'https://docs.nestjs.com/stable',
            markdown: '# Stable\n\npreviousMarker stays searchable.',
          },
        ],
        'd'.repeat(40),
      );
      syncService.indexCorpus(initial);
      const pageCount = Number(
        database.prepare('PRAGMA page_count').get()?.page_count,
      );
      database.exec(`PRAGMA max_page_count = ${pageCount}`);

      const updated = ingestNestJsDocuments(
        '12',
        [
          {
            path: 'content/stable.md',
            canonicalUrl: 'https://docs.nestjs.com/stable',
            markdown: `# Stable\n\n${'triggerFailureMarker '.repeat(50000)}`,
          },
        ],
        'e'.repeat(40),
      );

      expect(() => syncService.indexCorpus(updated)).toThrow(
        /database or disk is full/u,
      );
      expect(syncService.search('previousMarker')).toHaveLength(1);
      expect(syncService.search('triggerFailureMarker')).toEqual([]);
      expect(syncService.search('previousMarker')[0]?.sourceRevision).toBe(
        'd'.repeat(40),
      );
    } finally {
      syncService.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
