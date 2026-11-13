import {
  DOCUMENTATION_SOURCES,
  downloadDocumentation,
  readContentAliases,
  readHistoricalSourceIndex,
  readSourceIndex,
  sourceUrl,
} from '../../../../../../src/modules/documentation/infrastructure/github/documentation-source.js';
import type { DocumentationSnapshot } from '../../../../../../src/modules/documentation/domain/documentation.types.js';
import {
  revision,
  loadIngestionFixtures,
} from '../../../../../fixtures/ingestion.fixtures.js';
let snapshot: DocumentationSnapshot;
let index: string;
let aliases: string;
beforeAll(async () => {
  ({ snapshot, index, aliases } = await loadIngestionFixtures());
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
