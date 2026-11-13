import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BadRequestException } from '@nestjs/common';
import { ingestSnapshot } from '../src/ingestion/pipeline.js';
import { MAX_FETCH_DOCUMENT_CHARS } from '../src/search/search.constants.js';
import { DocumentationSearchService } from '../src/search/search.service.js';
import { loadSearchCorpus } from './search.fixtures.js';

describe('DocumentationSearchService', () => {
  let service: DocumentationSearchService;

  beforeEach(() => {
    service = new DocumentationSearchService(':memory:', 12);
  });

  afterEach(() => service.onModuleDestroy());

  it('ranks the section matching a natural-language query first', async () => {
    const corpus = await loadSearchCorpus();
    service.indexCorpus(corpus);

    const results = service.search('guard inspect request context');

    expect(results.length).toBeGreaterThan(1);
    expect(results[0]).toMatchObject({
      documentId: corpus.documents[0]?.id,
      title: 'Authorization guards',
      canonicalUrl: 'https://docs.nestjs.com/guards#inspecting-request-context',
    });
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.excerpt).toContain('request');
  });

  it.each(['ExecutionContext', '@Injectable()'])(
    'finds the exact technical identifier %s',
    async (query) => {
      const corpus = await loadSearchCorpus();
      service.indexCorpus(corpus);

      const results = service.search(query);

      expect(results[0]?.documentId).toBe(corpus.documents[0]?.id);
      expect(results[0]?.canonicalUrl).toContain('/guards#');
      expect(results[0]?.sourceRevision).toBe('c'.repeat(40));
    },
  );

  it('returns no matches for an empty query', () => {
    expect(service.search('')).toEqual([]);
    expect(service.search('   ')).toEqual([]);
  });

  it('bounds fetched documentation content and marks truncation', () => {
    const corpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: 'e'.repeat(40),
      documents: [
        {
          path: 'content/large.md',
          canonicalUrl: 'https://docs.nestjs.com/large',
          markdown: `# Large document\n\n## Long section\n\n${'authorization '.repeat(3000)}`,
        },
      ],
    });
    service.indexCorpus(corpus);

    const document = service.fetchDocument(corpus.documents[0]!.id);
    const sectionCharacters = document!.sections.reduce(
      (sum, section) =>
        sum +
        `\n\n## ${section.headingPath}\nSource: ${section.canonicalUrl}\n\n`
          .length +
        section.markdown.length,
      0,
    );

    expect(document?.truncated).toBe(true);
    expect(sectionCharacters).toBeLessThanOrEqual(MAX_FETCH_DOCUMENT_CHARS);
  });

  it('retrieves a matched section and continues without losing text', () => {
    const text = 'hello 🌍 authorization '.repeat(2500);
    const corpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: 'e'.repeat(40),
      documents: [
        {
          path: 'content/large.md',
          canonicalUrl: 'https://docs.nestjs.com/large',
          markdown: `# Large document\n\n## Target\n\n${text}\n\n## Later\n\nunique-later-marker`,
        },
      ],
    });
    service.indexCorpus(corpus);
    const docId = corpus.documents[0]!.id;
    const hit = service.search('unique-later-marker')[0]!;
    const target = service.fetchDocument(docId, hit.chunkId)!;
    expect(
      target.sections.map((section) => section.markdown).join(''),
    ).toContain('unique-later-marker');
    expect(
      target.sections.map((section) => section.markdown).join(''),
    ).not.toContain('authorization');
    let cursor: string | undefined;
    let complete = '';
    do {
      const page = service.fetchDocument(docId, undefined, cursor)!;
      complete += page.sections.map((section) => section.markdown).join('');
      cursor = page.nextCursor;
    } while (cursor);
    expect(complete).toContain(text.trim());
    expect(complete).toContain('unique-later-marker');
    expect(() => service.fetchDocument(docId, undefined, '999:0')).toThrow(
      BadRequestException,
    );
    expect(service.fetchDocument(docId, 'missing')).toBeNull();
    const firstPage = service.fetchDocument(docId)!;
    expect(firstPage.nextCursor).toBeDefined();
    expect(() =>
      service.fetchDocument(docId, hit.chunkId, firstPage.nextCursor),
    ).toThrow(/cursor/u);
    const updated = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: 'f'.repeat(40),
      documents: [
        {
          path: 'content/large.md',
          canonicalUrl: 'https://docs.nestjs.com/large',
          markdown: `# Large document\n\n## Target\n\n${text} changed`,
        },
      ],
    });
    service.indexCorpus(updated);
    expect(() =>
      service.fetchDocument(docId, undefined, firstPage.nextCursor),
    ).toThrow(/cursor/u);
  });

  it('reassembles all chunks belonging to the matched section', () => {
    const corpus = ingestSnapshot(
      {
        version: 12,
        ref: 'master',
        revision: 'a'.repeat(40),
        documents: [
          {
            path: 'content/sections.md',
            canonicalUrl: 'https://docs.nestjs.com/sections',
            markdown:
              '# Sections\n\n## Target\n\nFirst paragraph contains the beginning.\n\nSecond paragraph contains targetneedle.\n\nThird paragraph contains the end.\n\n## Other\n\nUnrelated text.',
          },
        ],
      },
      45,
    );
    service.indexCorpus(corpus);
    const hit = service.search('targetneedle')[0]!;
    const section = service.fetchDocument(hit.documentId, hit.chunkId)!;
    expect(section.sections).toHaveLength(1);
    expect(section.sections[0]!.markdown).toContain('First paragraph');
    expect(section.sections[0]!.markdown).toContain('targetneedle');
    expect(section.sections[0]!.markdown).toContain('Third paragraph');
    expect(section.sections[0]!.markdown).not.toContain('Unrelated text');
    expect(section.truncated).toBe(false);
  });

  it('continues a long section without losing text or splitting Unicode characters', () => {
    const corpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: 'b'.repeat(40),
      documents: [
        {
          path: 'content/unicode.md',
          canonicalUrl: 'https://docs.nestjs.com/unicode',
          markdown: `# Unicode\n\n## Stream\n\n${'🌍'.repeat(20000)} endmarker`,
        },
      ],
    });
    service.indexCorpus(corpus);
    const hit = service.search('endmarker')[0]!;
    const expected = corpus.documents[0]!.chunks.filter(
      (chunk) => chunk.canonicalUrl === hit.canonicalUrl,
    )
      .map((chunk) => chunk.markdown)
      .join('\n\n');
    let cursor: string | undefined;
    let reconstructed = '';
    let pageCount = 0;
    do {
      const page = service.fetchDocument(hit.documentId, hit.chunkId, cursor)!;
      expect(page.sections).toHaveLength(1);
      const text = page.sections[0]!.markdown;
      expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
      reconstructed += text;
      cursor = page.nextCursor;
      pageCount++;
      expect(pageCount).toBeLessThan(10);
      expect(page.truncated).toBe(cursor !== undefined);
    } while (cursor);
    expect(pageCount).toBeGreaterThan(1);
    expect(reconstructed).toBe(expected);
  });

  it('rejects stale cursors when content changes without a revision change', () => {
    const makeCorpus = (text: string) =>
      ingestSnapshot({
        version: 12,
        ref: 'master',
        revision: 'c'.repeat(40),
        documents: [
          {
            path: 'content/page.md',
            canonicalUrl: 'https://docs.nestjs.com/page',
            markdown: `# Page\n\n${text}`,
          },
        ],
      });
    const first = makeCorpus('original '.repeat(3000));
    service.indexCorpus(first);
    const docId = first.documents[0]!.id;
    const cursor = service.fetchDocument(docId)!.nextCursor!;
    expect(cursor).toBeTruthy();
    service.indexCorpus(makeCorpus('updated '.repeat(3000)));
    expect(() => service.fetchDocument(docId, undefined, cursor)).toThrow(
      /stale continuation cursor/u,
    );
  });

  it('treats FTS operators as search text and rejects control characters', async () => {
    service.indexCorpus(await loadSearchCorpus());
    expect(
      service.search('ExecutionContext OR nonexistentidentifier')[0]?.excerpt,
    ).toContain('ExecutionContext');
    expect(() => service.search('guard\0request')).toThrow(
      'control characters',
    );
    expect(service.search('guard\nrequest').length).toBeGreaterThan(0);
    expect(() =>
      service.search(
        Array.from({ length: 33 }, (_, index) => `word${index}`).join(' '),
      ),
    ).toThrow('at most 32 terms');
  });

  it('validates query input and bounds the result limit', () => {
    expect(() => service.search(42)).toThrow(BadRequestException);
    expect(() => service.search('x'.repeat(257))).toThrow(BadRequestException);
    expect(() => service.search('guard', 0)).toThrow(BadRequestException);
  });

  it('caps requested results at the maximum and replaces the previous index', () => {
    const revision = 'd'.repeat(40);
    const corpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision,
      documents: Array.from({ length: 55 }, (_, index) => ({
        path: `content/guard-${index}.md`,
        canonicalUrl: `https://docs.nestjs.com/guard-${index}`,
        markdown: `# Guard ${index}\n\nA guard checks access.`,
      })),
    });

    expect(service.indexCorpus(corpus)).toBe(55);
    expect(service.search('guard', 500)).toHaveLength(50);

    const smallerCorpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision,
      documents: [
        {
          path: 'content/replacement.md',
          canonicalUrl: 'https://docs.nestjs.com/replacement',
          markdown: '# Replacement\n\nA guard checks access.',
        },
      ],
    });
    expect(service.indexCorpus(smallerCorpus)).toBe(1);
    expect(service.search('guard', 500)).toHaveLength(1);
  });

  it('updates changed documents, removes deleted ones, and retains unchanged rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-sync-'));
    const databasePath = join(directory, 'documentation.sqlite');
    const syncService = new DocumentationSearchService(databasePath, 12);
    const database = new DatabaseSync(databasePath);
    try {
      const initial = ingestSnapshot({
        version: 12,
        ref: 'master',
        revision: 'a'.repeat(40),
        documents: [
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
      });
      syncService.indexCorpus(initial);
      const initialRowId = (documentId: string): number =>
        database
          .prepare(
            'SELECT rowid AS rowId FROM documentation_search WHERE document_id = ? AND documentation_version = ?',
          )
          .get(documentId, 12)!.rowId as number;
      const stableRowId = initialRowId(
        initial.documents.find((document) => document.title === 'Stable')!.id,
      );
      const changedRowId = initialRowId(
        initial.documents.find((document) => document.title === 'Changed')!.id,
      );

      const updated = ingestSnapshot({
        version: 12,
        ref: 'master',
        revision: 'b'.repeat(40),
        documents: [
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
      });
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
      expect(initialRowId(changedId)).not.toBe(changedRowId);
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
    const corpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: 'c'.repeat(40),
      documents: [
        {
          path: 'content/stable.md',
          canonicalUrl: 'https://docs.nestjs.com/stable',
          markdown: '# Stable\n\npreserveMarker remains searchable.',
        },
      ],
    });
    service.indexCorpus(corpus);
    const invalidCorpus = {
      ...corpus,
      source: { ...corpus.source, version: 11 as const },
    };

    expect(() => service.indexCorpus(invalidCorpus)).toThrow(
      'Documentation corpus must contain documents for NestJS v12',
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
    const syncService = new DocumentationSearchService(databasePath, 12);
    const database = (syncService as unknown as { database: DatabaseSync })
      .database;
    try {
      const initial = ingestSnapshot({
        version: 12,
        ref: 'master',
        revision: 'd'.repeat(40),
        documents: [
          {
            path: 'content/stable.md',
            canonicalUrl: 'https://docs.nestjs.com/stable',
            markdown: '# Stable\n\npreviousMarker stays searchable.',
          },
        ],
      });
      syncService.indexCorpus(initial);
      const pageCount = Number(
        database.prepare('PRAGMA page_count').get()?.page_count,
      );
      database.exec(`PRAGMA max_page_count = ${pageCount}`);

      const updated = ingestSnapshot({
        version: 12,
        ref: 'master',
        revision: 'e'.repeat(40),
        documents: [
          {
            path: 'content/stable.md',
            canonicalUrl: 'https://docs.nestjs.com/stable',
            markdown: `# Stable\n\n${'triggerFailureMarker '.repeat(50000)}`,
          },
        ],
      });

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
