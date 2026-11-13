import { z } from 'zod';
import JSON5 from 'json5';
import type { DocumentationSnapshot, SourceDocument } from './types.js';

export const REPOSITORY = 'https://github.com/nestjs/docs.nestjs.com';
export const SOURCE_REF = 'master';
const API = 'https://api.github.com/repos/nestjs/docs.nestjs.com';
const RAW = 'https://raw.githubusercontent.com/nestjs/docs.nestjs.com';
const SITE = 'https://docs.nestjs.com';
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const routeSchema = z.string().regex(/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/);

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
          canonicalUrl: `${SITE}${route === '/' ? '' : route}`,
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

export async function downloadDocumentation(
  fetcher: typeof fetch = fetch,
): Promise<DocumentationSnapshot> {
  const commit: unknown = JSON.parse(
    await downloadText(`${API}/commits/${SOURCE_REF}`, fetcher),
  );
  const { sha: revision } = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(commit);
  const [index, generator] = await Promise.all([
    downloadText(
      sourceUrl(revision, 'src/app/shared/nav/nav-items.ts'),
      fetcher,
    ),
    downloadText(sourceUrl(revision, 'tools/generate-llms-txt.ts'), fetcher),
  ]);
  const entries = readSourceIndex(index, readContentAliases(generator));
  const documents = new Array<SourceDocument>(entries.length);
  let next = 0;
  let failure: Error | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && next < entries.length) {
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
        failure = error instanceof Error ? error : new Error('Download failed');
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (failure) throw failure;
  return { revision, documents };
}
