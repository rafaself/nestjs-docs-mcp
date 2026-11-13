import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from '../src/ingestion/markdown.js';
import { ingestSnapshot, writeCorpus } from '../src/ingestion/pipeline.js';
import {
  DOCUMENTATION_SOURCES,
  downloadDocumentation,
  readContentAliases,
  readHistoricalSourceIndex,
  readSourceIndex,
  REPOSITORY,
  sourceUrl,
} from '../src/ingestion/source.js';
import type { DocumentationSnapshot } from '../src/ingestion/types.js';

const revision = 'a'.repeat(40);
const fixture = (path: string): Promise<string> =>
  readFile(
    new URL(`./fixtures/documentation/${path}`, import.meta.url),
    'utf8',
  );
const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

let snapshot: DocumentationSnapshot;
let index: string;
let aliases: string;

beforeAll(async () => {
  [index, aliases] = await Promise.all([
    fixture('navigation.txt'),
    fixture('aliases.txt'),
  ]);
  const entries = readSourceIndex(index, readContentAliases(aliases));
  snapshot = {
    version: 12,
    ref: 'master',
    revision,
    documents: await Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        markdown: await fixture(entry.path.replace(/^content\//, '')),
      })),
    ),
  };
});

describe('source download', () => {
  it('pins all source downloads to one resolved commit and honors URL aliases', async () => {
    const requests: string[] = [];
    const bodies = new Map([
      ['src/app/shared/nav/nav-items.ts', index],
      ['tools/generate-llms-txt.ts', aliases],
      ...snapshot.documents.map((file): [string, string] => [
        file.path,
        file.markdown,
      ]),
    ]);
    const fetcher: typeof fetch = (input, options) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push(url);
      expect(options?.redirect).toBe('error');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith('/commits/master')) {
        return Promise.resolve(Response.json({ sha: revision }));
      }
      const prefix = sourceUrl(revision, '');
      expect(url.startsWith(prefix)).toBe(true);
      const body = bodies.get(url.slice(prefix.length));
      return Promise.resolve(
        new Response(body ?? 'Missing fixture', {
          status: body ? 200 : 404,
        }),
      );
    };

    await expect(downloadDocumentation(12, fetcher)).resolves.toEqual(snapshot);
    expect(
      requests.filter((url) => url.endsWith('/commits/master')),
    ).toHaveLength(1);
    expect(snapshot.documents.map((file) => file.canonicalUrl)).toEqual([
      'https://docs.nestjs.com/providers',
      'https://docs.nestjs.com',
      'https://docs.nestjs.com/mcp/overview',
    ]);
  });

  it('preserves failures from concurrent documentation downloads', async () => {
    const failures = [
      new Error('first failure'),
      new Error('second failure'),
      new Error('third failure'),
    ];
    let failedDocuments = 0;
    const fetcher: typeof fetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/commits/master'))
        return Promise.resolve(Response.json({ sha: revision }));
      if (url.endsWith('/src/app/shared/nav/nav-items.ts'))
        return Promise.resolve(new Response(index));
      if (url.endsWith('/tools/generate-llms-txt.ts'))
        return Promise.resolve(new Response(aliases));
      return Promise.reject(failures[failedDocuments++]!);
    };
    try {
      await downloadDocumentation(12, fetcher);
      throw new Error('Expected download to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual(failures);
    }
  });

  it('preserves the original cause of a non-Error download failure', async () => {
    const failure = { reason: 'network interrupted' };
    let failed = false;
    const fetcher: typeof fetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/commits/master'))
        return Promise.resolve(Response.json({ sha: revision }));
      if (url.endsWith('/src/app/shared/nav/nav-items.ts'))
        return Promise.resolve(new Response(index));
      if (url.endsWith('/tools/generate-llms-txt.ts'))
        return Promise.resolve(new Response(aliases));
      if (!failed) {
        failed = true;
        // The fetch contract can be violated by an external implementation.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(failure);
      }
      return Promise.resolve(new Response('# Documentation'));
    };
    await expect(downloadDocumentation(12, fetcher)).rejects.toMatchObject({
      message: 'Download failed',
      cause: failure,
    });
  });

  it('downloads v11 Markdown from the pinned official source tree', async () => {
    const revision11 = 'd'.repeat(40);
    const treeRevision = 'e'.repeat(40);
    const paths = ['content/introduction.md', 'content/components.md'];
    const tree = JSON.stringify({
      tree: paths.map((path) => ({ path, type: 'blob' })),
    });
    const bodies = new Map([
      ...snapshot.documents
        .filter((file) => paths.includes(file.path))
        .map((file): [string, string] => [file.path, file.markdown]),
    ]);
    const requests: string[] = [];
    const fetcher: typeof fetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push(url);
      if (url.endsWith('/commits/11.0.0')) {
        return Promise.resolve(Response.json({ sha: revision11 }));
      }
      if (url.endsWith(`/commits/${revision11}`)) {
        return Promise.resolve(
          Response.json({ commit: { tree: { sha: treeRevision } } }),
        );
      }
      if (url.endsWith(`/git/trees/${treeRevision}?recursive=1`)) {
        return Promise.resolve(new Response(tree));
      }
      const prefix = sourceUrl(revision11, '');
      const body = bodies.get(url.slice(prefix.length));
      return Promise.resolve(
        new Response(body ?? 'Missing fixture', { status: body ? 200 : 404 }),
      );
    };

    const result = await downloadDocumentation(11, fetcher);

    expect(result).toMatchObject({
      version: 11,
      ref: '11.0.0',
      revision: revision11,
    });
    expect(result.documents.map((document) => document.canonicalUrl)).toEqual([
      'https://docs.nestjs.com/v11/providers',
      'https://docs.nestjs.com/v11',
    ]);
    expect(requests.some((url) => url.includes('/commits/master'))).toBe(false);
    expect(DOCUMENTATION_SOURCES[11].ref).toBe('11.0.0');
    expect(
      requests.filter((url) => url.startsWith(sourceUrl(revision11, ''))),
    ).toHaveLength(2);
  });

  it.each([404, 429, 500])(
    'reports HTTP %i without ingesting an incomplete snapshot',
    async (status) => {
      const fetcher: typeof fetch = () =>
        Promise.resolve(new Response('Unavailable', { status }));
      await expect(downloadDocumentation(12, fetcher)).rejects.toThrow(
        `(${status})`,
      );
    },
  );

  it('rejects invalid revisions before constructing raw source URLs', async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(Response.json({ sha: '../master' }));
    await expect(downloadDocumentation(12, fetcher)).rejects.toThrow();
  });

  it('rejects a snapshot when a chapter download fails after valid metadata', async () => {
    const fetcher: typeof fetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/commits/master'))
        return Promise.resolve(Response.json({ sha: revision }));
      if (url.endsWith('/nav-items.ts'))
        return Promise.resolve(new Response(index));
      if (url.endsWith('/generate-llms-txt.ts'))
        return Promise.resolve(new Response(aliases));
      return Promise.resolve(new Response('Missing chapter', { status: 404 }));
    };
    await expect(downloadDocumentation(12, fetcher)).rejects.toThrow(
      'Download failed (404)',
    );
  });

  it('bounds individual download sizes', async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    await expect(downloadDocumentation(12, fetcher)).rejects.toThrow('exceeds');
  });

  it('fails closed when upstream alias syntax changes or contains path traversal', () => {
    expect(() => readContentAliases('export const changed = {};')).toThrow(
      'not found',
    );
    expect(() =>
      readContentAliases(aliases.replace("'components'", 'compute()')),
    ).toThrow('syntax');
    expect(() =>
      readContentAliases(aliases.replace("'components'", "'../secret'")),
    ).toThrow('Unsafe');
    expect(() => readSourceIndex('', new Map())).toThrow('empty');
    expect(() =>
      readSourceIndex('export const NAV_ITEMS = [compute()];', new Map()),
    ).toThrow();
    expect(() =>
      readSourceIndex(
        "export const NAV_ITEMS = [{path: '/../file'}];",
        new Map(),
      ),
    ).toThrow();
  });

  it('maps the historical official Markdown tree to versioned canonical URLs', () => {
    const entries = readHistoricalSourceIndex(
      JSON.stringify({
        tree: [
          { path: 'content/introduction.md', type: 'blob' },
          { path: 'content/fundamentals/async-components.md', type: 'blob' },
          { path: 'content/techniques/sql.md', type: 'blob' },
          { path: 'content/ignored.txt', type: 'blob' },
        ],
      }),
    );
    expect(entries.map((entry) => entry.canonicalUrl)).toEqual([
      'https://docs.nestjs.com/v11/fundamentals/async-providers',
      'https://docs.nestjs.com/v11',
      'https://docs.nestjs.com/v11/techniques/database',
    ]);
    expect(() =>
      readHistoricalSourceIndex(
        JSON.stringify({
          tree: [{ path: 'content/../escape.md', type: 'blob' }],
        }),
      ),
    ).toThrow('Unsafe');
  });
});

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

describe('corpus output', () => {
  it('writes reproducible JSON and cleans staging files if replacement fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-ingestion-test-'));
    try {
      const corpus = ingestSnapshot(snapshot);
      const output = join(directory, 'nested', 'documentation.json');
      await writeCorpus(corpus, output);
      const first = await readFile(output, 'utf8');
      await writeCorpus(corpus, output);
      expect(await readFile(output, 'utf8')).toBe(first);
      const parsed: unknown = JSON.parse(first);
      expect(parsed).toEqual(corpus);

      const occupied = join(directory, 'occupied');
      await mkdir(occupied);
      await writeFile(join(occupied, 'keep.txt'), 'keep');
      await expect(writeCorpus(corpus, occupied)).rejects.toThrow();
      expect(await readFile(join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
      expect((await readdir(directory)).sort()).toEqual(['nested', 'occupied']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
