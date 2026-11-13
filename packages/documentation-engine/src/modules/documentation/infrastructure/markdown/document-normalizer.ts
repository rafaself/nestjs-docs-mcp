import { createHash } from 'node:crypto';
import type {
  DocumentationIdentity,
  DocumentationSourceProvenance,
  Heading,
  NormalizedDocument,
  SourceDocument,
} from '../../domain/documentation.types.js';
import { NormalizedDocumentSchema } from '../../domain/documentation.schemas.js';
import {
  normalizeLineEndings,
  type ParsedCodeExample,
  type ParsedMarkdownBlock,
  type ParsedMarkdownDocument,
} from './markdown-parser.js';

export const DOCUMENT_NORMALIZATION_ALGORITHM_VERSION = 1;
export const DOCUMENT_CHUNKING_ALGORITHM_VERSION = 1;

export type OversizedBlockPolicy = 'preserve' | 'error';

export interface DocumentNormalizationOptions {
  maxChunkChars?: number;
  oversizedBlockPolicy?: OversizedBlockPolicy;
  identity?: DocumentationIdentity;
  idPrefix?: string;
}

interface ContentUnit {
  blocks: ParsedMarkdownBlock[];
  markdown: string;
}

interface Section {
  headingPath: Heading[];
  blocks: ParsedMarkdownBlock[];
}

/** Normalize parsed Markdown and split it into stable, heading-aware chunks. */
export function normalizeAndChunkDocument(
  file: SourceDocument,
  source: DocumentationSourceProvenance,
  parsed: ParsedMarkdownDocument,
  options: DocumentNormalizationOptions = {},
): NormalizedDocument {
  const maxChunkChars = options.maxChunkChars ?? 4000;
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error('maxChunkChars must be a positive integer');
  }
  const oversizedBlockPolicy = options.oversizedBlockPolicy ?? 'preserve';
  const path = normalizeRelativePath(file.path);
  const identity = options.identity ?? { id: file.id, version: file.version };
  if (identity.version !== file.version) {
    throw new Error(
      'Documentation identity version must match the source document',
    );
  }

  const headings: Heading[] = [];
  const headingByPosition = new Map<string, Heading>();
  const seenSlugs = new Set<string>();
  for (const heading of parsed.headings) {
    const normalized: Heading = {
      level: heading.level,
      title: normalizeInlineWhitespace(heading.title),
      slug: headingSlug(heading.title, seenSlugs),
    };
    headings.push(normalized);
    headingByPosition.set(`${heading.line}:${heading.column}`, normalized);
  }

  const title = normalizeInlineWhitespace(
    parsed.frontmatter?.title ?? headings[0]?.title ?? '',
  );
  if (!title) throw new Error(`Document has no title: ${path}`);

  const id = createStableDocumentId(
    identity,
    path,
    options.idPrefix ?? `documentation:v${identity.version}`,
  );
  const normalizedBlocks = parsed.blocks
    .map((block) => normalizeBlock(block))
    .filter((block) => block.markdown.length > 0);
  const sections = buildSections(normalizedBlocks, headingByPosition);
  const markdownParts = [
    ...(parsed.frontmatter
      ? [normalizeFrontmatter(parsed.frontmatter.raw)]
      : []),
    ...normalizedBlocks.map((block) => block.markdown),
  ].filter(Boolean);
  const markdown =
    markdownParts.length > 0 ? `${markdownParts.join('\n\n').trim()}\n` : '';
  const chunks = createChunks({
    id,
    title,
    canonicalUrl: file.canonicalUrl,
    sourceRevision: source.revision,
    sections,
    maxChunkChars,
    oversizedBlockPolicy,
  });
  const frontmatter = parsed.frontmatter
    ? {
        format: parsed.frontmatter.format,
        raw: normalizeFrontmatter(parsed.frontmatter.raw),
        ...(parsed.frontmatter.title && {
          title: normalizeInlineWhitespace(parsed.frontmatter.title),
        }),
      }
    : undefined;

  return NormalizedDocumentSchema.parse({
    id,
    version: file.version,
    title,
    canonicalUrl: file.canonicalUrl,
    source: {
      provenance: source,
      path,
      location: file.sourceLocation,
      contentHash: contentHash(file.markdown),
    },
    ...(frontmatter && { frontmatter }),
    markdown,
    contentHash: contentHash(markdown),
    headings,
    chunks,
  });
}

/** IDs are namespaced by the documentation identity and stable across edits. */
export function createStableDocumentId(
  identity: DocumentationIdentity,
  relativePath: string,
  prefix = `documentation:v${identity.version}`,
): string {
  const path = normalizeRelativePath(relativePath);
  const digest = contentHash(`${identity.id}\0v${identity.version}\0${path}`);
  return `${prefix}:${digest}`;
}

export function normalizeRelativePath(path: string): string {
  const portable = path.replaceAll('\\', '/');
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[a-z]:/iu.test(portable) ||
    portable.includes('\0')
  ) {
    throw new Error(`Documentation path must be relative: "${path}"`);
  }
  const parts = portable
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new Error(
      `Documentation path cannot traverse above its root: "${path}"`,
    );
  }
  if (parts.length === 0) {
    throw new Error(`Documentation path is empty: "${path}"`);
  }
  return parts.join('/');
}

function buildSections(
  blocks: ParsedMarkdownBlock[],
  headingByPosition: Map<string, Heading>,
): Section[] {
  const sections: Section[] = [{ headingPath: [], blocks: [] }];
  let headingPath: Heading[] = [];
  let current = sections[0]!;
  for (const block of blocks) {
    if (block.heading) {
      const heading = headingByPosition.get(
        `${block.heading.line}:${block.heading.column}`,
      );
      if (!heading) throw new Error('Parsed heading metadata is inconsistent');
      headingPath = [
        ...headingPath.filter((parent) => parent.level < heading.level),
        heading,
      ];
      current = { headingPath, blocks: [] };
      sections.push(current);
    }
    current.blocks.push(block);
  }
  return sections.filter((section) => section.blocks.length > 0);
}

function createChunks(input: {
  id: string;
  title: string;
  canonicalUrl: string;
  sourceRevision: string;
  sections: Section[];
  maxChunkChars: number;
  oversizedBlockPolicy: OversizedBlockPolicy;
}): NormalizedDocument['chunks'] {
  const chunks: NormalizedDocument['chunks'] = [];
  for (const section of input.sections) {
    const units = groupRelatedBlocks(section.blocks);
    let pending: ContentUnit[] = [];
    let part = 0;
    const flush = (): void => {
      if (!pending.length) return;
      const markdown = joinBlocks(pending.flatMap((unit) => unit.blocks));
      const heading = section.headingPath.at(-1);
      const canonicalUrl = heading
        ? `${input.canonicalUrl.replace(/#.*$/u, '')}#${heading.slug}`
        : input.canonicalUrl;
      const sectionKey = section.headingPath.map((item) => item.slug);
      chunks.push({
        id: `${input.id}:${contentHash(
          JSON.stringify([
            DOCUMENT_NORMALIZATION_ALGORITHM_VERSION,
            DOCUMENT_CHUNKING_ALGORITHM_VERSION,
            sectionKey,
            part++,
          ]),
        )}`,
        documentId: input.id,
        index: chunks.length,
        title: input.title,
        canonicalUrl,
        sourceRevision: input.sourceRevision,
        headingPath: section.headingPath,
        markdown,
        contentHash: contentHash(markdown),
        codeExamples: pending
          .flatMap((unit) => unit.blocks)
          .flatMap((block) => block.codeExamples)
          .map(toCodeExample),
      });
      pending = [];
    };

    for (const unit of units) {
      const combined = joinBlocks([
        ...pending.flatMap((item) => item.blocks),
        ...unit.blocks,
      ]);
      if (pending.length && combined.length > input.maxChunkChars) flush();
      if (unit.markdown.length > input.maxChunkChars) {
        if (input.oversizedBlockPolicy === 'error') {
          throw new Error(
            `Documentation block exceeds maxChunkChars (${input.maxChunkChars})`,
          );
        }
        flush();
      }
      pending.push(unit);
    }
    flush();
  }
  return chunks;
}

function groupRelatedBlocks(blocks: ParsedMarkdownBlock[]): ContentUnit[] {
  const units: ContentUnit[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const next = blocks[index + 1];
    if (block.kind === 'heading' && next && next.kind !== 'heading') {
      const afterNext = blocks[index + 2];
      const related =
        next.kind === 'paragraph' && afterNext?.kind === 'code'
          ? [block, next, afterNext]
          : [block, next];
      units.push({ blocks: related, markdown: joinBlocks(related) });
      index += related.length - 1;
    } else if (block.kind === 'paragraph' && next?.kind === 'code') {
      const pair = [block, next];
      units.push({ blocks: pair, markdown: joinBlocks(pair) });
      index++;
    } else {
      units.push({ blocks: [block], markdown: block.markdown });
    }
  }
  return units;
}

function normalizeBlock(block: ParsedMarkdownBlock): ParsedMarkdownBlock {
  const markdown = normalizeMarkdownBlock(block.markdown);
  return {
    ...block,
    markdown,
    text: normalizeInlineWhitespace(block.text),
    codeExamples: block.codeExamples.map((example) => ({
      ...example,
      code: normalizeLineEndings(example.code),
    })),
  };
}

function normalizeMarkdownBlock(value: string): string {
  const lines = normalizeLineEndings(value).split('\n');
  const output: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | undefined;
  for (const line of lines) {
    const marker = markdownFenceMarker(line);
    if (fence) {
      output.push(line);
      if (
        marker?.[1]?.[0] === fence.marker &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      ) {
        fence = undefined;
      }
    } else {
      if (marker?.[1])
        fence = { marker: marker[1][0] as '`' | '~', length: marker[1].length };
      output.push(fence ? line : trimTrailingWhitespace(line));
    }
  }
  while (output[0]?.trim() === '') output.shift();
  while (output.at(-1)?.trim() === '') output.pop();
  return output.join('\n');
}

function markdownFenceMarker(line: string): RegExpExecArray | null {
  const withoutBlockquote = line.replace(/^(?: {0,3}> ?)+/u, '');
  return /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(withoutBlockquote);
}

function trimTrailingWhitespace(line: string): string {
  const trailing = /[\t ]+$/u.exec(line)?.[0];
  return trailing && trailing.length < 2
    ? line.slice(0, -trailing.length)
    : line;
}

function normalizeFrontmatter(value: string): string {
  return normalizeLineEndings(value).trim();
}

function normalizeInlineWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function joinBlocks(blocks: ParsedMarkdownBlock[]): string {
  const result = blocks
    .map((block) => block.markdown)
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return result ? `${result}\n` : '';
}

function headingSlug(value: string, seen: Set<string>): string {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/<[!/a-z].*?>/giu, '')
    .replace(
      /[\u2000-\u206f\u2e00-\u2e7f\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/gu,
      '',
    )
    .replace(/\s/gu, '-');
  let slug = base;
  for (let suffix = 1; seen.has(slug); suffix++) slug = `${base}-${suffix}`;
  seen.add(slug);
  return slug;
}

function toCodeExample(
  example: ParsedCodeExample,
): NormalizedDocument['chunks'][number]['codeExamples'][number] {
  return {
    language: example.language,
    ...(example.filename && { filename: example.filename }),
    code: example.code,
  };
}

function contentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
