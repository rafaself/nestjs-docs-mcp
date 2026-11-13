import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseMarkdown } from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import { transformNestJsDocument } from '../../../../../../apps/docs-indexer/src/integrations/nestjs/nestjs-documentation-transformer.js';
import { ingestSnapshot } from '../../../../../fixtures/ingestion.fixtures.js';
import {
  REPOSITORY,
  sourceUrl,
} from '../../../../../../apps/docs-indexer/src/integrations/nestjs/github/documentation-source.js';
import type {
  DocumentationSnapshot,
  SourceDocument,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { createNestJsDocumentationIdentity } from '../../../../../../apps/docs-indexer/src/integrations/nestjs/version/documentation-version.js';
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

function makeSourceDocument(
  path: string,
  canonicalUrl: string,
  markdown: string,
  sourceRevision = revision,
): SourceDocument {
  return {
    ...createNestJsDocumentationIdentity('12', path),
    path,
    canonicalUrl,
    sourceLocation: sourceUrl(sourceRevision, path),
    markdown,
  };
}

describe('Markdown ingestion', () => {
  it('preserves titles, canonical URLs, heading hierarchy, source revision, and hashes', () => {
    const corpus = ingestSnapshot(snapshot, 180);
    const doc = corpus.documents.find(
      (document) => document.title === 'Fixture Introduction',
    )!;
    const source = snapshot.documents.find(
      (file) => file.path === 'content/introduction.md',
    )!;
    expect(corpus).toMatchObject({
      version: '12',
      source: {
        kind: 'git',
        repository: REPOSITORY,
        ref: 'master',
        revision,
      },
    });
    expect(doc.canonicalUrl).toBe('https://docs.nestjs.com');
    expect(doc.id).toBe(
      `nestjs-doc:v12:${sha256(`${REPOSITORY}\0v12\0${source.path}`)}`,
    );
    expect(new Set(corpus.documents.map((document) => document.id)).size).toBe(
      corpus.documents.length,
    );
    expect(doc.source).toEqual({
      provenance: snapshot.source,
      path: source.path,
      location: sourceUrl(revision, source.path),
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
    const doc = transformNestJsDocument(
      {
        ...makeSourceDocument(
          'content/large.md',
          'https://docs.nestjs.com/large',
          `### Large\n\n#### First\n\nShort paragraph.\n\n\`\`\`ts\n${code}\n\`\`\`\n\n#### Second\n\nAnother paragraph.\n`,
        ),
      },
      snapshot.source,
      100,
    );
    const codeChunk = doc.chunks.find((chunk) => chunk.codeExamples.length)!;
    expect(codeChunk.markdown.length).toBeGreaterThan(100);
    expect(codeChunk.codeExamples[0]?.code).toBe(code);
    expect(codeChunk.headingPath.at(-1)?.title).toBe('First');
    expect(codeChunk.markdown).not.toContain('#### Second');
    expect(doc.chunks.at(-1)?.headingPath.at(-1)?.title).toBe('Second');
    expect(() =>
      transformNestJsDocument(snapshot.documents[0]!, snapshot.source, 0),
    ).toThrow('positive');
  });

  it('is deterministic across input order, line endings, and source revisions', () => {
    const first = ingestSnapshot(snapshot);
    const reordered = ingestSnapshot({
      ...snapshot,
      documents: [...snapshot.documents].reverse(),
    });
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
    const source = snapshot.documents[0]!;
    const original = transformNestJsDocument(source, snapshot.source);
    const changedSource = { ...snapshot.source, revision: 'b'.repeat(40) };
    const changed = transformNestJsDocument(
      {
        ...source,
        sourceLocation: sourceUrl('b'.repeat(40), source.path),
        markdown: '\uFEFF' + source.markdown.replace(/\n/g, '\r\n'),
      },
      changedSource,
    );
    expect(changed.id).toBe(original.id);
    expect(changed.chunks.map((chunk) => chunk.id)).toEqual(
      original.chunks.map((chunk) => chunk.id),
    );
    expect(changed.contentHash).toBe(original.contentHash);
    expect(changed.source.contentHash).not.toBe(original.source.contentHash);
    expect(changed.source.provenance.revision).toBe('b'.repeat(40));
    const edited = transformNestJsDocument(
      { ...source, markdown: source.markdown + '\nA new paragraph.\n' },
      snapshot.source,
    );
    expect(edited.id).toBe(original.id);
    expect(edited.contentHash).not.toBe(original.contentHash);
    expect(edited.source.contentHash).not.toBe(original.source.contentHash);
  });

  it('rejects empty, untitled, and duplicate documents', () => {
    expect(() =>
      ingestSnapshot({
        ...snapshot,
        documents: [],
      }),
    ).toThrow();
    expect(() =>
      ingestSnapshot({
        ...snapshot,
        documents: [snapshot.documents[0]!, snapshot.documents[0]!],
      }),
    ).toThrow();
    expect(() =>
      transformNestJsDocument(
        { ...snapshot.documents[0]!, markdown: 'Not a titled document' },
        snapshot.source,
      ),
    ).toThrow('title');
  });
});

describe('generic Markdown and MDX parsing', () => {
  it('extracts Markdown frontmatter, headings, prose, lists, tables, links, and fenced code metadata', async () => {
    const source = await readFile(
      new URL('../../../../../fixtures/markdown/complete.md', import.meta.url),
      'utf8',
    );
    const parsed = parseMarkdown(source, { path: 'guide/complete.md' });
    expect(parsed.format).toBe('markdown');
    expect(parsed.frontmatter).toEqual({
      format: 'yaml',
      raw: '---\ntitle: Parser fixture\ndescription: Fixture metadata\n---',
      title: 'Parser fixture',
    });
    expect(
      parsed.headings.map(({ level, title }) => ({ level, title })),
    ).toEqual([
      { level: 1, title: 'Parser fixture' },
      { level: 2, title: 'Installation' },
    ]);
    expect(parsed.paragraphs).toContain(
      'Install the package and configure the application.',
    );
    expect(parsed.lists).toHaveLength(1);
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.links).toEqual([
      {
        kind: 'link',
        text: 'installation guide',
        url: 'https://example.test/install',
        title: 'Install',
      },
      { kind: 'image', text: 'logo', url: 'https://example.test/logo.png' },
    ]);
    expect(parsed.codeExamples).toEqual([
      {
        language: 'typescript',
        filename: 'example.ts',
        code: 'const value = 42;',
      },
    ]);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('keeps static MDX content and reports dynamic constructs without executing them', async () => {
    const testGlobal = globalThis as typeof globalThis & {
      __parserExecuted?: boolean;
    };
    delete testGlobal.__parserExecuted;
    const source = await readFile(
      new URL(
        '../../../../../fixtures/markdown/static-and-dynamic.mdx',
        import.meta.url,
      ),
      'utf8',
    );
    const parsed = parseMarkdown(source, {
      path: 'guide/static-and-dynamic.mdx',
    });
    expect(parsed.format).toBe('mdx');
    expect(parsed.frontmatter?.title).toBe('MDX fixture');
    expect(parsed.headings.map(({ title }) => title)).toEqual([
      'MDX fixture',
      'Nested heading',
    ]);
    expect(parsed.headings.map(({ line }) => line)).toEqual([5, 7]);
    expect(parsed.jsxElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Callout',
          attributes: [{ name: 'type', value: 'note' }],
          text: 'Static JSX content.',
          markdown: '<Callout type="note">Static JSX content.</Callout>',
          line: 9,
        }),
      ]),
    );
    expect(parsed.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'dynamic-jsx-attribute',
        'unsupported-mdx-expression',
        'unsupported-mdx-module',
      ]),
    );
    expect(parsed.blocks.map(({ markdown }) => markdown).join('\n')).toContain(
      '{dangerousExpression()}',
    );
    expect(parsed.blocks.map(({ markdown }) => markdown).join('\n')).toContain(
      "import Widget from './widget.js'",
    );
    expect(
      parsed.diagnostics.find(
        ({ code }) => code === 'unsupported-mdx-expression',
      )?.line,
    ).toBe(13);
    expect(testGlobal.__parserExecuted).toBeUndefined();
  });

  it('preserves unterminated frontmatter and reports it as a diagnostic', () => {
    const source = '---\ntitle: Still content\n\n# Visible heading';
    const parsed = parseMarkdown(source);
    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe('unterminated-frontmatter');
    expect(parsed.headings[0]?.title).toBe('Visible heading');
  });

  it('is deterministic for repeated parses and line-ending variants', async () => {
    const source = await readFile(
      new URL('../../../../../fixtures/markdown/complete.md', import.meta.url),
      'utf8',
    );
    expect(parseMarkdown(source, { path: 'complete.md' })).toEqual(
      parseMarkdown(source.replace(/\n/gu, '\r\n'), { path: 'complete.md' }),
    );
  });
});
