import { createHash } from 'node:crypto';
import { parseDocument } from '../../../../../../src/modules/documentation/infrastructure/markdown/markdown-parser.js';
import { ingestSnapshot } from '../../../../../fixtures/ingestion.fixtures.js';
import {
  REPOSITORY,
  sourceUrl,
} from '../../../../../../src/modules/documentation/infrastructure/github/documentation-source.js';
import type { DocumentationSnapshot } from '../../../../../../src/modules/documentation/domain/documentation.types.js';
import {
  revision,
  loadIngestionFixtures,
} from '../../../../../fixtures/ingestion.fixtures.js';
let snapshot: DocumentationSnapshot;
beforeAll(async () => {
  ({ snapshot } = await loadIngestionFixtures());
});
const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

describe('Markdown ingestion', () => {
  it('preserves titles, canonical URLs, heading hierarchy, source revision, and hashes', () => {
    const corpus = ingestSnapshot(snapshot, 180);
    const doc = corpus.documents.find(
      (document) => document.title === 'Fixture Introduction',
    )!;
    const source = snapshot.documents.find(
      (file) => file.path === 'content/introduction.md',
    )!;
    expect(corpus.source).toEqual({
      repository: REPOSITORY,
      version: 12,
      ref: 'master',
      revision,
    });
    expect(doc.canonicalUrl).toBe('https://docs.nestjs.com');
    expect(doc.id).toBe(
      `nestjs-doc:v12:${sha256(`${REPOSITORY}\0v12\0${source.path}`)}`,
    );
    expect(new Set(corpus.documents.map((document) => document.id)).size).toBe(
      corpus.documents.length,
    );
    expect(doc.source).toEqual({
      repository: REPOSITORY,
      revision,
      path: source.path,
      url: sourceUrl(revision, source.path),
      contentHash: sha256(source.markdown),
    });
    expect(doc.contentHash).toBe(sha256(doc.markdown));
    expect(doc.headings.map((heading) => heading.slug)).toEqual([
      'fixture-introduction',
      'setup',
      'examples',
      'nested-section',
      'setup-1',
      'setup-1-1',
    ]);
    const nested = doc.chunks.find(
      (chunk) => chunk.headingPath.at(-1)?.slug === 'nested-section',
    )!;
    expect(nested.headingPath.map((heading) => heading.title)).toEqual([
      'Fixture Introduction',
      'Examples',
      'Nested section',
    ]);
    expect(nested.canonicalUrl).toBe('https://docs.nestjs.com#nested-section');
    for (const chunk of doc.chunks) {
      expect(chunk.documentId).toBe(doc.id);
      expect(chunk.sourceRevision).toBe(revision);
      expect(chunk.contentHash).toBe(sha256(chunk.markdown));
    }
    expect(new Set(doc.chunks.map((chunk) => chunk.id)).size).toBe(
      doc.chunks.length,
    );
  });

  it('normalizes authoring syntax while retaining both code variants and their filename', () => {
    const doc = ingestSnapshot(snapshot).documents.find(
      (file) => file.source.path === 'content/introduction.md',
    )!;
    expect(doc.markdown).toContain('`{ ready: true }`');
    expect(doc.markdown).not.toContain('@@filename');
    expect(doc.markdown).not.toContain('@@switch');
    expect(doc.markdown).not.toContain('<app-banner-courses>');
    expect(doc.markdown).toContain('> info **Hint**');
    expect(doc.markdown).toContain('| fixture | example |');
    const examples = doc.chunks.flatMap((chunk) => chunk.codeExamples);
    expect(
      examples.map(({ language, filename }) => ({ language, filename })),
    ).toEqual([
      { language: 'typescript', filename: 'example.service' },
      { language: 'javascript', filename: 'example.service' },
    ]);
    expect(examples[0]?.code).toContain('console.log("{{ \'{\' }}");');
    expect(examples[0]?.code).toContain('// # This is code, not a heading.');
    expect(examples[1]?.code).toContain("value = 'javascript'");
    for (const example of examples)
      expect(doc.markdown).toContain(example.code);
  });

  it('handles setext headings, nested/indented code, and tilde fences', () => {
    const docs = ingestSnapshot(snapshot).documents;
    const mcp = docs.find(
      (doc) => doc.source.path === 'content/mcp/overview.md',
    )!;
    expect(mcp.title).toBe('Fixture MCP');
    expect(mcp.headings.map((heading) => heading.level)).toEqual([1, 2]);
    const providers = docs.find(
      (doc) => doc.source.path === 'content/components.md',
    )!;
    expect(
      providers.chunks
        .flatMap((chunk) => chunk.codeExamples)
        .map((code) => code.code),
    ).toEqual([
      'const nested = true;',
      'const indented = true;',
      '#### This is not a section\n<app-banner-courses></app-banner-courses>',
    ]);
    expect(providers.headings).toHaveLength(4);
  });

  it('keeps oversized code intact and separates sections at the soft chunk target', () => {
    const code = 'const longExample = true;\n'.repeat(30).trimEnd();
    const doc = parseDocument(
      {
        path: 'content/large.md',
        canonicalUrl: 'https://docs.nestjs.com/large',
        markdown: `### Large\n\n#### First\n\nShort paragraph.\n\n\`\`\`ts\n${code}\n\`\`\`\n\n#### Second\n\nAnother paragraph.\n`,
      },
      revision,
      100,
    );
    const codeChunk = doc.chunks.find((chunk) => chunk.codeExamples.length)!;
    expect(codeChunk.markdown.length).toBeGreaterThan(100);
    expect(codeChunk.codeExamples[0]?.code).toBe(code);
    expect(codeChunk.headingPath.at(-1)?.title).toBe('First');
    expect(codeChunk.markdown).not.toContain('#### Second');
    expect(doc.chunks.at(-1)?.headingPath.at(-1)?.title).toBe('Second');
    expect(() => parseDocument(snapshot.documents[0]!, revision, 0)).toThrow(
      'positive',
    );
  });

  it('is deterministic across input order, line endings, and source revisions', () => {
    const first = ingestSnapshot(snapshot);
    const reordered = ingestSnapshot({
      ...snapshot,
      documents: [...snapshot.documents].reverse(),
    });
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
    const source = snapshot.documents[0]!;
    const original = parseDocument(source, revision);
    const changed = parseDocument(
      {
        ...source,
        markdown: '\uFEFF' + source.markdown.replace(/\n/g, '\r\n'),
      },
      'b'.repeat(40),
    );
    expect(changed.id).toBe(original.id);
    expect(changed.chunks.map((chunk) => chunk.id)).toEqual(
      original.chunks.map((chunk) => chunk.id),
    );
    expect(changed.contentHash).toBe(original.contentHash);
    expect(changed.source.contentHash).not.toBe(original.source.contentHash);
    expect(changed.source.revision).toBe('b'.repeat(40));
    const edited = parseDocument(
      { ...source, markdown: source.markdown + '\nA new paragraph.\n' },
      revision,
    );
    expect(edited.id).toBe(original.id);
    expect(edited.contentHash).not.toBe(original.contentHash);
    expect(edited.source.contentHash).not.toBe(original.source.contentHash);
  });

  it('rejects empty, untitled, and duplicate documents', () => {
    expect(() =>
      ingestSnapshot({ version: 12, ref: 'master', revision, documents: [] }),
    ).toThrow('empty');
    expect(() =>
      ingestSnapshot({
        version: 12,
        ref: 'master',
        revision,
        documents: [snapshot.documents[0]!, snapshot.documents[0]!],
      }),
    ).toThrow('Duplicate');
    expect(() =>
      parseDocument(
        { ...snapshot.documents[0]!, markdown: 'Not a titled document' },
        revision,
      ),
    ).toThrow('title');
  });
});
