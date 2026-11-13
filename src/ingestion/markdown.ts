import { createHash } from 'node:crypto';
import { Lexer, walkTokens, type Token, type Tokens } from 'marked';
import {
  DEFAULT_DOCUMENTATION_VERSION,
  type NestJsDocumentationVersion,
} from '../documentation-version.js';
import { REPOSITORY, sourceUrl } from './source.js';
import type {
  CodeExample,
  DocumentationChunk,
  DocumentationDocument,
  Heading,
  SourceDocument,
} from './types.js';

interface Block {
  markdown: string;
  codeExamples: CodeExample[];
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Normalize prose without applying template substitutions to code examples. */
function normalizeSource(source: string): string {
  let fence: { marker: string; length: number } | undefined;
  return source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (
          marker?.[1]?.[0] === fence.marker &&
          marker[1].length >= fence.length &&
          !marker[2]?.trim()
        ) {
          fence = undefined;
        }
        return line;
      }
      if (marker?.[1]) {
        fence = { marker: marker[1][0]!, length: marker[1].length };
        return line;
      }
      if (/^( {4}|\t)/.test(line)) return line;
      return line
        .replace(/^\s*<app-banner-([\w-]+)><\/app-banner-\1>\s*$/, '')
        .replace(/\{\{\s*(['"])([{}])\1\s*\}\}/g, '$2');
    })
    .join('\n');
}

function isHeading(token: Token): token is Tokens.Heading {
  return token.type === 'heading';
}

function isCode(token: Token): token is Tokens.Code {
  return token.type === 'code';
}

function inlineText(tokens: Token[]): string {
  return tokens
    .map((token): string => {
      if (token.type === 'html') return '';
      if ('tokens' in token && Array.isArray(token.tokens)) {
        return inlineText(token.tokens);
      }
      return 'text' in token && typeof token.text === 'string'
        ? token.text
        : token.raw;
    })
    .join('');
}

// Match the official site's heading renderer, including duplicate anchor IDs.
function headingSlug(text: string, seen: Set<string>): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/<[!/a-z].*?>/gi, '')
    .replace(
      /[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g,
      '',
    )
    .replace(/\s/g, '-');
  let slug = base;
  for (let suffix = 1; seen.has(slug); suffix++) slug = `${base}-${suffix}`;
  seen.add(slug);
  return slug;
}

function codeExamples(token: Tokens.Code): CodeExample[] {
  let filename: string | undefined;
  const code = token.text
    .split('\n')
    .filter((line) => {
      const directive = line.match(/^@@filename\((.*)\)\s*$/);
      if (!directive) return true;
      filename = directive[1] || undefined;
      return false;
    })
    .join('\n');
  return code.split(/^@@switch\s*$/m).map((variant, index) => ({
    language: index === 0 ? (token.lang ?? '') : 'javascript',
    ...(filename && { filename }),
    code: variant.replace(/^\n+|\n+$/g, ''),
  }));
}

function renderExample(example: CodeExample): string {
  const longest = Math.max(
    2,
    ...[...example.code.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}${example.language}\n${example.code}\n${fence}`;
}

function blockMarkdown(blocks: Block[]): string {
  return (
    blocks
      .map((block) => block.markdown)
      .join('\n\n')
      .trimEnd() + '\n'
  );
}

export function parseDocument(
  file: SourceDocument,
  revision: string,
  maxChunkChars = 4000,
  version: NestJsDocumentationVersion = DEFAULT_DOCUMENTATION_VERSION,
): DocumentationDocument {
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error('maxChunkChars must be a positive integer');
  }
  const id = `nestjs-doc:v${version}:${contentHash(`${REPOSITORY}\0v${version}\0${file.path}`)}`;
  const headings: Heading[] = [];
  const seen = new Set<string>();
  const sections: { headingPath: Heading[]; blocks: Block[] }[] = [];
  let headingPath: Heading[] = [];
  let section = { headingPath, blocks: [] as Block[] };
  sections.push(section);

  for (const token of Lexer.lex(normalizeSource(file.markdown))) {
    if (token.type === 'space') continue;
    if (isHeading(token)) {
      const heading = {
        level: token.depth,
        title: inlineText(token.tokens),
        slug: headingSlug(token.text, seen),
      };
      headings.push(heading);
      headingPath = [
        ...headingPath.filter((parent) => parent.level < heading.level),
        heading,
      ];
      section = { headingPath, blocks: [] };
      sections.push(section);
    }
    if (isCode(token)) {
      for (const example of codeExamples(token)) {
        section.blocks.push({
          markdown: renderExample(example),
          codeExamples: [example],
        });
      }
    } else {
      const examples: CodeExample[] = [];
      void walkTokens([token], (child) => {
        if (isCode(child)) examples.push(...codeExamples(child));
      });
      section.blocks.push({
        markdown: token.raw.trim(),
        codeExamples: examples,
      });
    }
  }
  const title = headings[0]?.title;
  if (!title) throw new Error(`Document has no title heading: ${file.path}`);

  const chunks: DocumentationChunk[] = [];
  for (const section of sections) {
    let blocks: Block[] = [];
    let part = 0;
    const flush = (): void => {
      if (blocks.length === 0) return;
      const markdown = blockMarkdown(blocks);
      const heading = section.headingPath.at(-1);
      chunks.push({
        id: `${id}:${contentHash(JSON.stringify([section.headingPath.map((h) => h.slug), part++]))}`,
        documentId: id,
        index: chunks.length,
        title,
        canonicalUrl: `${file.canonicalUrl}${heading ? `#${heading.slug}` : ''}`,
        sourceRevision: revision,
        headingPath: section.headingPath,
        markdown,
        contentHash: contentHash(markdown),
        codeExamples: blocks.flatMap((block) => block.codeExamples),
      });
      blocks = [];
    };
    for (const block of section.blocks) {
      if (
        blocks.length > 0 &&
        blockMarkdown([...blocks, block]).length > maxChunkChars
      ) {
        flush();
      }
      blocks.push(block);
    }
    flush();
  }
  const markdown = blockMarkdown(sections.flatMap((section) => section.blocks));
  return {
    id,
    title,
    canonicalUrl: file.canonicalUrl,
    source: {
      repository: REPOSITORY,
      revision,
      path: file.path,
      url: sourceUrl(revision, file.path),
      contentHash: contentHash(file.markdown),
    },
    markdown,
    contentHash: contentHash(markdown),
    headings,
    chunks,
  };
}
