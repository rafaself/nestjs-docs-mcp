import { BadRequestException } from '@nestjs/common';
import { ingestSnapshot } from '../../src/ingestion/pipeline.js';
import { MAX_FETCH_DOCUMENT_CHARS } from '../../src/search/search.constants.js';
import { TestSearchIndex as DocumentationSearchService } from '../fixtures/test-search-index.js';

describe('DocumentationSearchService', () => {
  let service: DocumentationSearchService;
  beforeEach(() => {
    service = new DocumentationSearchService(':memory:', 12);
  });
  afterEach(() => service.onModuleDestroy());

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
});
