import { NESTJS_DOCUMENTATION_REPOSITORY } from './version/documentation-version.js';
import type {
  DocumentationSourceProvenance,
  NormalizedDocument,
  SourceDocument,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { normalizeAndChunkDocument } from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import {
  normalizeLineEndings,
  parseMarkdown,
  type ParsedCodeExample,
  type ParsedMarkdownDocument,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';

/** Increment when NestJS-specific source transformations change. */
export const NESTJS_DOCUMENTATION_TRANSFORMER_VERSION = 1;

/** Apply NestJS source conventions before passing content through the generic
 * parser and normalizer. */
export function transformNestJsDocument(
  file: SourceDocument,
  source: DocumentationSourceProvenance,
  maxChunkChars = 4000,
): NormalizedDocument {
  const markdown = normalizeNestJsSource(file.markdown);
  const parsed = parseMarkdown(markdown, { path: file.path });
  const transformed = transformNestJsDirectives(parsed);
  return normalizeAndChunkDocument(file, source, transformed, {
    maxChunkChars,
    identity: { id: NESTJS_DOCUMENTATION_REPOSITORY, version: file.version },
    idPrefix: `nestjs-doc:v${file.version}`,
  });
}

function normalizeNestJsSource(source: string): string {
  let fence: { marker: '`' | '~'; length: number } | undefined;
  return normalizeLineEndings(source)
    .split('\n')
    .map((line) => {
      const withoutBlockquote = line.replace(/^(?: {0,3}> ?)+/u, '');
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(withoutBlockquote);
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
        fence = { marker: marker[1][0] as '`' | '~', length: marker[1].length };
        return line;
      }
      if (/^( {4}|\t)/u.test(line)) return line;
      return line
        .replace(/^\s*<app-banner-([\w-]+)><\/app-banner-\1>\s*$/u, '')
        .replace(/\{\{\s*(['"])([{}])\1\s*\}\}/gu, '$2');
    })
    .join('\n');
}

function transformNestJsDirectives(
  parsed: ParsedMarkdownDocument,
): ParsedMarkdownDocument {
  const blocks = parsed.blocks.map((block) => {
    if (block.kind !== 'code' || block.codeExamples.length === 0) return block;
    const variants = block.codeExamples.flatMap((example) =>
      splitNestJsCode(example),
    );
    const hasDirectives = block.codeExamples.some(({ code }) =>
      /^@@filename\(.*\)\s*$|^@@switch\s*$/mu.test(code),
    );
    if (!hasDirectives) return block;
    return {
      ...block,
      markdown: variants.map(renderCodeExample).join('\n\n'),
      codeExamples: variants,
    };
  });
  return {
    ...parsed,
    blocks,
    codeExamples: blocks.flatMap((block) => block.codeExamples),
  };
}

function splitNestJsCode(example: ParsedCodeExample): ParsedCodeExample[] {
  let filename = example.filename;
  const variants: string[] = [];
  let current: string[] = [];
  for (const line of example.code.split('\n')) {
    const filenameDirective = /^@@filename\((.*)\)\s*$/u.exec(line);
    if (filenameDirective) {
      filename = filenameDirective[1] || undefined;
      continue;
    }
    if (/^@@switch\s*$/u.test(line)) {
      variants.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  variants.push(current.join('\n'));
  return variants.map((code, index) => ({
    language: index === 0 ? example.language : 'javascript',
    ...(filename && { filename }),
    code: code.replace(/^\n+|\n+$/gu, ''),
  }));
}

function renderCodeExample(example: ParsedCodeExample): string {
  const longest = Math.max(
    2,
    ...[...example.code.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}${example.language}\n${example.code}\n${fence}`;
}
