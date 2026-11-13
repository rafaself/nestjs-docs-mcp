import { createProcessor } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';

/** Increment when parsing semantics or the persisted parse result changes. */
export const MARKDOWN_PARSER_VERSION = 1;

export type MarkdownFormat = 'markdown' | 'mdx';

export interface ParsedFrontmatter {
  format: 'yaml' | 'toml';
  raw: string;
  title?: string;
}

export interface ParsedCodeExample {
  language: string;
  filename?: string;
  code: string;
}

export interface ParsedHeading {
  level: number;
  title: string;
  markdown: string;
  line: number;
  column: number;
}

export interface ParsedLink {
  kind: 'link' | 'image';
  text: string;
  url: string;
  title?: string;
}

export interface ParsedJsxAttribute {
  name: string;
  value: string | boolean;
}

export interface ParsedStaticJsxElement {
  name: string;
  attributes: ParsedJsxAttribute[];
  text: string;
  markdown: string;
  line: number;
  column: number;
}

export interface MarkdownDiagnostic {
  code:
    | 'unterminated-frontmatter'
    | 'unsupported-mdx-expression'
    | 'unsupported-mdx-module'
    | 'dynamic-jsx-attribute';
  message: string;
  line: number;
  column: number;
}

export type ParsedBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'code'
  | 'blockquote'
  | 'jsx'
  | 'html'
  | 'thematic-break'
  | 'unsupported-mdx'
  | 'other';

export interface ParsedMarkdownBlock {
  kind: ParsedBlockKind;
  markdown: string;
  text: string;
  heading?: ParsedHeading;
  codeExamples: ParsedCodeExample[];
}

export interface ParsedMarkdownDocument {
  format: MarkdownFormat;
  source: string;
  frontmatter?: ParsedFrontmatter;
  blocks: ParsedMarkdownBlock[];
  headings: ParsedHeading[];
  paragraphs: string[];
  lists: string[];
  tables: string[];
  links: ParsedLink[];
  codeExamples: ParsedCodeExample[];
  jsxElements: ParsedStaticJsxElement[];
  diagnostics: MarkdownDiagnostic[];
}

interface Position {
  start?: { offset?: number; line?: number; column?: number };
  end?: { offset?: number };
}

interface AstNode {
  type: string;
  position?: Position;
  children?: AstNode[];
  [key: string]: unknown;
}

const markdownProcessor = createProcessor({
  format: 'md',
  remarkPlugins: [remarkGfm],
});
const mdxProcessor = createProcessor({
  format: 'mdx',
  remarkPlugins: [remarkGfm],
});

/** Parse Markdown/MDX into static structures. This deliberately uses parse()
 * only: MDX imports, expressions, and components are never compiled or run. */
export function parseMarkdown(
  input: string,
  options: { path?: string; format?: MarkdownFormat } = {},
): ParsedMarkdownDocument {
  const source = normalizeLineEndings(input);
  const format =
    options.format ??
    (options.path?.toLowerCase().endsWith('.mdx') ? 'mdx' : 'markdown');
  const {
    body,
    frontmatter,
    lineOffset,
    diagnostic: frontmatterDiagnostic,
  } = extractFrontmatter(source);
  let tree: AstNode;
  try {
    const processor = format === 'mdx' ? mdxProcessor : markdownProcessor;
    tree = processor.parse(body) as unknown as AstNode;
  } catch (cause) {
    const location = options.path ? ` in "${options.path}"` : '';
    throw new Error(`Unable to parse ${format}${location}`, { cause });
  }

  const diagnostics: MarkdownDiagnostic[] = frontmatterDiagnostic
    ? [frontmatterDiagnostic]
    : [];
  const headings: ParsedHeading[] = [];
  const paragraphs: string[] = [];
  const lists: string[] = [];
  const tables: string[] = [];
  const links: ParsedLink[] = [];
  const codeExamples: ParsedCodeExample[] = [];
  const jsxElements: ParsedStaticJsxElement[] = [];
  const blocks: ParsedMarkdownBlock[] = [];
  const definitions = collectDefinitions(tree);

  for (const node of tree.children ?? []) {
    const markdown = sourceSlice(body, node);
    if (!markdown.trim()) continue;
    const heading =
      node.type === 'heading'
        ? makeHeading(node, markdown, lineOffset)
        : undefined;
    if (heading) headings.push(heading);
    const examples = getCodeExamples(node);
    codeExamples.push(...examples);
    blocks.push({
      kind: blockKind(node),
      markdown,
      text: nodeText(node),
      ...(heading && { heading }),
      codeExamples: examples,
    });
  }

  visit(tree, (node) => {
    if (node.type === 'paragraph') {
      const text = nodeText(node).trim();
      if (text) paragraphs.push(text);
    } else if (node.type === 'list') {
      const markdown = sourceSlice(body, node).trim();
      if (markdown) lists.push(markdown);
    } else if (node.type === 'table') {
      const markdown = sourceSlice(body, node).trim();
      if (markdown) tables.push(markdown);
    } else if (node.type === 'link' || node.type === 'image') {
      const url = stringProperty(node, 'url');
      if (url) {
        const title = stringProperty(node, 'title');
        links.push({
          kind: node.type,
          text: nodeText(node),
          url,
          ...(title && { title }),
        });
      }
    } else if (
      node.type === 'linkReference' ||
      node.type === 'imageReference'
    ) {
      const key = normalizedLabel(stringProperty(node, 'identifier') ?? '');
      const definition = definitions.get(key);
      if (definition) {
        links.push({
          kind: node.type === 'imageReference' ? 'image' : 'link',
          text: nodeText(node),
          url: definition.url,
          ...(definition.title && { title: definition.title }),
        });
      }
    } else if (
      node.type === 'mdxFlowExpression' ||
      node.type === 'mdxTextExpression'
    ) {
      diagnostics.push(
        diagnostic(
          'unsupported-mdx-expression',
          'Dynamic MDX expressions are preserved as source and are not evaluated.',
          node,
          lineOffset,
        ),
      );
    } else if (node.type === 'mdxjsEsm') {
      diagnostics.push(
        diagnostic(
          'unsupported-mdx-module',
          'MDX imports and exports are preserved as source and are not executed.',
          node,
          lineOffset,
        ),
      );
    } else if (
      node.type === 'mdxJsxFlowElement' ||
      node.type === 'mdxJsxTextElement'
    ) {
      const element = makeStaticJsx(node, body, lineOffset, diagnostics);
      if (element) jsxElements.push(element);
    }
  });

  return {
    format,
    source,
    ...(frontmatter && { frontmatter }),
    blocks,
    headings,
    paragraphs,
    lists,
    tables,
    links,
    codeExamples,
    jsxElements,
    diagnostics,
  };
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}

function extractFrontmatter(source: string): {
  body: string;
  lineOffset: number;
  frontmatter?: ParsedFrontmatter;
  diagnostic?: MarkdownDiagnostic;
} {
  const lines = source.split('\n');
  const delimiter = lines[0];
  const format =
    delimiter === '---' ? 'yaml' : delimiter === '+++' ? 'toml' : null;
  if (!format) return { body: source, lineOffset: 0 };

  const closing = lines.findIndex(
    (line, index) =>
      index > 0 &&
      (line === delimiter || (format === 'yaml' && line === '...')),
  );
  if (closing < 0) {
    return {
      body: source,
      lineOffset: 0,
      diagnostic: {
        code: 'unterminated-frontmatter',
        message:
          'Frontmatter opening delimiter has no matching closing delimiter.',
        line: 1,
        column: 1,
      },
    };
  }

  const raw = lines.slice(0, closing + 1).join('\n');
  const values = lines.slice(1, closing).join('\n');
  const title = readFrontmatterTitle(values, format);
  const bodyLines = lines.slice(closing + 1);
  const hasLeadingBlankLine = bodyLines[0] === '';
  const body = bodyLines.slice(hasLeadingBlankLine ? 1 : 0).join('\n');
  return {
    body,
    lineOffset: closing + (hasLeadingBlankLine ? 2 : 1),
    frontmatter: { format, raw, ...(title && { title }) },
  };
}

function readFrontmatterTitle(
  value: string,
  format: 'yaml' | 'toml',
): string | undefined {
  const pattern =
    format === 'yaml' ? /^title\s*:\s*(.*?)\s*$/mu : /^title\s*=\s*(.*?)\s*$/mu;
  const match = pattern.exec(value)?.[1];
  if (!match) return undefined;
  const title = match.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2').trim();
  return title || undefined;
}

function makeHeading(
  node: AstNode,
  markdown: string,
  lineOffset: number,
): ParsedHeading {
  const position = node.position?.start;
  return {
    level: numberProperty(node, 'depth') ?? 1,
    title: nodeText(node).trim(),
    markdown,
    line: (position?.line ?? 1) + lineOffset,
    column: position?.column ?? 1,
  };
}

function blockKind(node: AstNode): ParsedBlockKind {
  switch (node.type) {
    case 'heading':
      return 'heading';
    case 'paragraph':
      return containsJsx(node) ? 'jsx' : 'paragraph';
    case 'list':
      return 'list';
    case 'table':
      return 'table';
    case 'code':
      return 'code';
    case 'blockquote':
      return 'blockquote';
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      return 'jsx';
    case 'html':
      return 'html';
    case 'thematicBreak':
      return 'thematic-break';
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
    case 'mdxjsEsm':
      return 'unsupported-mdx';
    default:
      return 'other';
  }
}

function getCodeExamples(node: AstNode): ParsedCodeExample[] {
  const examples: ParsedCodeExample[] = [];
  visit(node, (candidate) => {
    if (candidate.type !== 'code') return;
    const language = stringProperty(candidate, 'lang') ?? '';
    const meta = stringProperty(candidate, 'meta') ?? '';
    const filename = filenameFromMeta(meta);
    examples.push({
      language,
      ...(filename && { filename }),
      code: stringProperty(candidate, 'value') ?? '',
    });
  });
  return examples;
}

function filenameFromMeta(meta: string): string | undefined {
  const match =
    /(?:^|\s)(?:filename|file|title)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/u.exec(
      meta,
    );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function makeStaticJsx(
  node: AstNode,
  source: string,
  lineOffset: number,
  diagnostics: MarkdownDiagnostic[],
): ParsedStaticJsxElement | undefined {
  const name = stringProperty(node, 'name');
  if (!name) return undefined;
  const attributes: ParsedJsxAttribute[] = [];
  for (const candidate of arrayProperty(node, 'attributes')) {
    if (candidate.type === 'mdxJsxExpressionAttribute') {
      diagnostics.push(
        diagnostic(
          'dynamic-jsx-attribute',
          'Spread JSX attributes are preserved as source and are not evaluated.',
          candidate,
          lineOffset,
        ),
      );
      continue;
    }
    const attributeName = stringProperty(candidate, 'name');
    if (!attributeName) continue;
    const value = candidate.value;
    if (typeof value === 'string') {
      attributes.push({ name: attributeName, value });
    } else if (value === null || value === undefined) {
      attributes.push({ name: attributeName, value: true });
    } else {
      diagnostics.push(
        diagnostic(
          'dynamic-jsx-attribute',
          `JSX attribute "${attributeName}" is dynamic and is not evaluated.`,
          candidate,
          lineOffset,
        ),
      );
    }
  }
  const position = node.position?.start;
  return {
    name,
    attributes,
    text: nodeText(node).trim(),
    markdown: sourceSlice(source, node),
    line: (position?.line ?? 1) + lineOffset,
    column: position?.column ?? 1,
  };
}

function containsJsx(node: AstNode): boolean {
  let result = false;
  visit(node, (child) => {
    if (
      child.type === 'mdxJsxFlowElement' ||
      child.type === 'mdxJsxTextElement'
    )
      result = true;
  });
  return result;
}

function nodeText(node: AstNode): string {
  const value = stringProperty(node, 'value');
  if (
    (node.type === 'text' ||
      node.type === 'inlineCode' ||
      node.type === 'code') &&
    value !== undefined
  ) {
    return value;
  }
  if (node.type === 'break') return '\n';
  if (node.type === 'image' || node.type === 'imageReference') {
    return stringProperty(node, 'alt') ?? childrenText(node);
  }
  if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') {
    return `{${value ?? ''}}`;
  }
  return childrenText(node);
}

function childrenText(node: AstNode): string {
  return (node.children ?? []).map(nodeText).join('');
}

function collectDefinitions(
  tree: AstNode,
): Map<string, { url: string; title?: string }> {
  const definitions = new Map<string, { url: string; title?: string }>();
  visit(tree, (node) => {
    if (node.type !== 'definition') return;
    const identifier = stringProperty(node, 'identifier');
    const url = stringProperty(node, 'url');
    if (!identifier || !url) return;
    const title = stringProperty(node, 'title');
    definitions.set(normalizedLabel(identifier), {
      url,
      ...(title && { title }),
    });
  });
  return definitions;
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function diagnostic(
  code: MarkdownDiagnostic['code'],
  message: string,
  node: AstNode,
  lineOffset: number,
): MarkdownDiagnostic {
  return {
    code,
    message,
    line: (node.position?.start?.line ?? 1) + lineOffset,
    column: node.position?.start?.column ?? 1,
  };
}

function sourceSlice(source: string, node: AstNode): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === 'number' && typeof end === 'number'
    ? source.slice(start, end)
    : '';
}

function visit(node: AstNode, visitor: (node: AstNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) visit(child, visitor);
  for (const attribute of arrayProperty(node, 'attributes'))
    visit(attribute, visitor);
}

function stringProperty(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

function numberProperty(node: AstNode, key: string): number | undefined {
  const value = node[key];
  return typeof value === 'number' ? value : undefined;
}

function arrayProperty(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is AstNode => isAstNode(entry))
    : [];
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}
