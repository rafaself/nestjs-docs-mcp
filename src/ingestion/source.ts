import { z } from 'zod';
import JSON5 from 'json5';
import type { NestJsDocumentationVersion } from '../documentation-version.js';
import type { DocumentationSnapshot, SourceDocument } from './types.js';

export const REPOSITORY = 'https://github.com/nestjs/docs.nestjs.com';
const API = 'https://api.github.com/repos/nestjs/docs.nestjs.com';
const RAW = 'https://raw.githubusercontent.com/nestjs/docs.nestjs.com';
const SITE = 'https://docs.nestjs.com';
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENTS = 512;
const routeSchema = z.string().regex(/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/);

interface DocumentationSourceConfig {
  ref: string;
  canonicalRoot: string;
}

/**
 * The official site serves v11 from the 11.0.0 branch and v12 from master.
 */
export const DOCUMENTATION_SOURCES: Record<
  NestJsDocumentationVersion,
  DocumentationSourceConfig
> = {
  11: {
    ref: '11.0.0',
    canonicalRoot: `${SITE}/v11`,
  },
  12: { ref: 'master', canonicalRoot: SITE },
};

// The historical branch predates the current generated content alias manifest.
const V11_CANONICAL_ROUTES: ReadonlyMap<string, string> = new Map([
  ['content/introduction.md', '/'],
  ['content/components.md', '/providers'],
  ['content/middlewares.md', '/middleware'],
  ['content/application-context.md', '/standalone-applications'],
  ['content/migration.md', '/migration-guide'],
  [
    'content/fundamentals/dependency-injection.md',
    '/fundamentals/custom-providers',
  ],
  ['content/fundamentals/async-components.md', '/fundamentals/async-providers'],
  ['content/fundamentals/provider-scopes.md', '/fundamentals/injection-scopes'],
  ['content/fundamentals/module-reference.md', '/fundamentals/module-ref'],
  ['content/fundamentals/unit-testing.md', '/fundamentals/testing'],
  ['content/graphql/resolvers-map.md', '/graphql/resolvers'],
  ['content/graphql/schema-generator.md', '/graphql/generating-sdl'],
  ['content/graphql/guards-interceptors.md', '/graphql/other-features'],
  ['content/graphql/migration.md', '/graphql/migration-guide'],
  ['content/cli/workspaces.md', '/cli/monorepo'],
  ['content/faq/errors.md', '/faq/common-errors'],
  ['content/devtools/ci-cd.md', '/devtools/ci-cd-integration'],
  ['content/discover/who-uses.md', '/discover/companies'],
  [
    'content/security/encryption-hashing.md',
    '/security/encryption-and-hashing',
  ],
  ['content/techniques/mongo.md', '/techniques/mongodb'],
  ['content/techniques/sessions.md', '/techniques/session'],
  ['content/techniques/sql.md', '/techniques/database'],
]);

interface NavigationItem {
  path?: string;
  externalUrl?: string;
  isPending?: boolean;
  children?: NavigationItem[];
}

const navigationItemSchema: z.ZodType<NavigationItem> = z.lazy(() =>
  z.object({
    path: routeSchema.optional(),
    externalUrl: z.string().optional(),
    isPending: z.boolean().optional(),
    children: z.array(navigationItemSchema).optional(),
  }),
);

export function sourceUrl(revision: string, path: string): string {
  return `${RAW}/${revision}/${path}`;
}

async function downloadText(
  url: string,
  fetcher: typeof fetch,
): Promise<string> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
    headers: { 'user-agent': 'nestjs-docs-mcp-ingestion', accept: '*/*' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel();
        throw new Error(`Unexpected download body: ${url}`);
      }
      size += value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
      }
      buffers.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Retain a BOM for the raw source hash; normalization removes it later.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(buffers),
  );
}

/** Read static alias data, without importing or executing upstream TypeScript. */
export function readContentAliases(source: string): Map<string, string> {
  const block = source.match(/const CONTENT_ALIASES[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block?.[1]) throw new Error('Upstream CONTENT_ALIASES was not found');
  const aliases = new Map<string, string>();
  for (const line of block[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('//')) continue;
    const pair = line.match(/^\s*'([^']+)'\s*:\s*'([^']+)',?\s*$/);
    if (!pair?.[1] || !pair[2]) {
      throw new Error('Unsupported upstream CONTENT_ALIASES syntax');
    }
    if (
      !/^\/(?:[a-z0-9-]+\/?)*$/.test(pair[1]) ||
      !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(pair[2])
    ) {
      throw new Error('Unsafe upstream content alias');
    }
    if (aliases.has(pair[1]))
      throw new Error('Duplicate upstream content alias');
    aliases.set(pair[1], pair[2]);
  }
  return aliases;
}

/** Read the site's tracked navigation as static data, never as executable code. */
export function readSourceIndex(
  navigation: string,
  aliases: Map<string, string>,
  canonicalRoot = SITE,
): Omit<SourceDocument, 'markdown'>[] {
  const block = navigation.match(
    /export const NAV_ITEMS[^=]*=\s*(\[[\s\S]*\]);?\s*$/,
  );
  if (!block?.[1])
    throw new Error(
      'Upstream documentation navigation is empty or unsupported',
    );
  const data: unknown = JSON5.parse(block[1]);
  const items = z.array(navigationItemSchema).parse(data);
  const documents = new Map<string, Omit<SourceDocument, 'markdown'>>();
  const visit = (items: NavigationItem[]): void => {
    for (const item of items) {
      if (item.externalUrl || item.isPending) continue;
      if (item.path !== undefined) {
        const route = item.path;
        const name = aliases.get(route) ?? route.slice(1);
        if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(name)) {
          throw new Error(`Unsafe content path for route: ${route}`);
        }
        const path = `content/${name}.md`;
        if (documents.has(path))
          throw new Error(`Duplicate source document: ${path}`);
        documents.set(path, {
          path,
          canonicalUrl: `${canonicalRoot}${route === '/' ? '' : route}`,
        });
      }
      if (item.children) visit(item.children);
    }
  };
  visit(items);
  if (documents.size === 0)
    throw new Error('Upstream documentation index is empty');
  return [...documents.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** Use only tracked Markdown files in the official v11 source tree. */
export function readHistoricalSourceIndex(
  treeSource: string,
  canonicalRoot = `${SITE}/v11`,
): Omit<SourceDocument, 'markdown'>[] {
  const parsed: unknown = JSON.parse(treeSource);
  const tree = z
    .object({
      tree: z.array(z.object({ path: z.string(), type: z.string() })),
    })
    .parse(parsed).tree;
  const markdownPaths = tree
    .filter(
      ({ path, type }) =>
        type === 'blob' && path.startsWith('content/') && path.endsWith('.md'),
    )
    .map(({ path }) => path)
    .sort();
  if (markdownPaths.length === 0 || markdownPaths.length > MAX_DOCUMENTS) {
    throw new Error('Historical documentation tree is empty or too large');
  }

  const documents = new Map<string, Omit<SourceDocument, 'markdown'>>();
  for (const path of markdownPaths) {
    if (!/^content\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/u.test(path)) {
      throw new Error(`Unsafe historical content path: ${path}`);
    }
    const fileRoute = `/${path.slice('content/'.length, -'.md'.length)}`;
    const route = V11_CANONICAL_ROUTES.get(path) ?? fileRoute;
    const safeRoute = routeSchema.parse(route);
    if (documents.has(path)) {
      throw new Error(`Duplicate historical source document: ${path}`);
    }
    documents.set(path, {
      path,
      canonicalUrl: `${canonicalRoot}${safeRoute === '/' ? '' : safeRoute}`,
    });
  }
  return [...documents.values()];
}

export async function resolveDocumentationSource(
  version: NestJsDocumentationVersion,
  fetcher: typeof fetch = fetch,
): Promise<Pick<DocumentationSnapshot, 'version' | 'ref' | 'revision'>> {
  const source = DOCUMENTATION_SOURCES[version];
  const revision = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) })
    .parse(
      JSON.parse(await downloadText(`${API}/commits/${source.ref}`, fetcher)),
    ).sha;
  return { version, ref: source.ref, revision };
}

async function resolveTreeRevision(
  revision: string,
  fetcher: typeof fetch,
): Promise<string> {
  const commit: unknown = JSON.parse(
    await downloadText(`${API}/commits/${revision}`, fetcher),
  );
  return z
    .object({
      commit: z.object({
        tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) }),
      }),
    })
    .parse(commit).commit.tree.sha;
}

export async function downloadDocumentation(
  version: NestJsDocumentationVersion = 12,
  fetcher: typeof fetch = fetch,
): Promise<DocumentationSnapshot> {
  const source = DOCUMENTATION_SOURCES[version];
  const { revision } = await resolveDocumentationSource(version, fetcher);
  let entries: Omit<SourceDocument, 'markdown'>[];
  if (version === 11) {
    const treeRevision = await resolveTreeRevision(revision, fetcher);
    const tree = await downloadText(
      `${API}/git/trees/${treeRevision}?recursive=1`,
      fetcher,
    );
    entries = readHistoricalSourceIndex(tree, source.canonicalRoot);
  } else {
    const [index, generator] = await Promise.all([
      downloadText(
        sourceUrl(revision, 'src/app/shared/nav/nav-items.ts'),
        fetcher,
      ),
      downloadText(sourceUrl(revision, 'tools/generate-llms-txt.ts'), fetcher),
    ]);
    entries = readSourceIndex(
      index,
      readContentAliases(generator),
      source.canonicalRoot,
    );
  }
  const documents = new Array<SourceDocument>(entries.length);
  let next = 0;
  const failures: Error[] = [];
  const worker = async (): Promise<void> => {
    while (failures.length === 0 && next < entries.length) {
      const index = next++;
      const entry = entries[index]!;
      try {
        documents[index] = {
          ...entry,
          markdown: await downloadText(
            sourceUrl(revision, entry.path),
            fetcher,
          ),
        };
      } catch (error) {
        failures.push(
          error instanceof Error
            ? error
            : new Error('Download failed', { cause: error }),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (failures.length === 1) throw failures[0]!;
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `Multiple documentation downloads failed: ${failures[0]!.message}`,
    );
  return { version, ref: source.ref, revision, documents };
}
