import { Inject, Injectable } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import * as z from 'zod';
import type {
  DocumentationReader,
  DocumentationSearchResult,
  FetchedDocumentation,
} from './search/documentation-search.types.js';
import type { NestJsDocumentationVersion } from './documentation-version.js';
import { DOCUMENTATION_READER } from './search/search.tokens.js';
import {
  DEFAULT_SEARCH_RESULT_LIMIT,
  DOCUMENT_ID_PATTERN,
  MAX_SEARCH_QUERY_LENGTH,
} from './search/search.constants.js';

const MAX_TOOL_SEARCH_RESULTS = 10;

const searchDocsInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SEARCH_QUERY_LENGTH)
    .describe(
      'Natural-language terms or an exact NestJS identifier to search.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOOL_SEARCH_RESULTS)
    .optional()
    .describe('Maximum results to return (1 to 10; defaults to 10).'),
});

const fetchDocsInput = z.strictObject({
  documentId: z
    .string()
    .regex(DOCUMENT_ID_PATTERN)
    .describe('The deterministic document ID returned by search_docs.'),
  sectionId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Section ID returned by search_docs.'),
  cursor: z
    .string()
    .max(110)
    .regex(/^[0-9a-f]{64}:(0|[1-9]\d*):(0|[1-9]\d*)$/u)
    .optional()
    .describe(
      'Continuation cursor returned by fetch_docs; use the same document and section.',
    ),
});

const searchResultSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  title: z.string(),
  canonicalUrl: z.string(),
  sourceRevision: z.string(),
  excerpt: z.string(),
  score: z.number(),
});
const searchOutputSchema = z.object({
  documentationVersion: z.number(),
  results: z.array(searchResultSchema),
});
const fetchOutputSchema = z.object({
  documentationVersion: z.number(),
  documentId: z.string(),
  sectionId: z.string().nullable(),
  found: z.boolean(),
  title: z.string().nullable(),
  sourceRevision: z.string().nullable(),
  sections: z.array(
    z.object({
      headingPath: z.string(),
      canonicalUrl: z.string(),
      markdown: z.string(),
    }),
  ),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});

@Injectable()
export class DocumentationTools {
  constructor(
    @Inject(DOCUMENTATION_READER)
    private readonly documentation: DocumentationReader,
  ) {}

  @Tool({
    name: 'search_docs',
    description:
      'Searches the NestJS documentation major selected when this server starts. Returns ranked section excerpts, document IDs, and official source URLs.',
    inputSchema: searchDocsInput,
    outputSchema: searchOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  searchDocs({ query, limit }: { query: string; limit?: number }) {
    const results = this.documentation.search(
      query,
      limit ?? DEFAULT_SEARCH_RESULT_LIMIT,
    );
    const formatted = formatSearchResults(
      results,
      this.documentation.documentationVersion,
    );
    return {
      content: [{ type: 'text' as const, text: formatted }],
      structuredContent: {
        documentationVersion: this.documentation.documentationVersion,
        results,
      },
    };
  }

  @Tool({
    name: 'fetch_docs',
    description:
      'Fetch a document or a section identified by search_docs. Use the returned cursor with the same document and section to continue a truncated excerpt.',
    inputSchema: fetchDocsInput,
    outputSchema: fetchOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  fetchDocs({
    documentId,
    sectionId,
    cursor,
  }: {
    documentId: string;
    sectionId?: string;
    cursor?: string;
  }) {
    const document = this.documentation.fetchDocument(
      documentId,
      sectionId,
      cursor,
    );
    if (!document)
      return {
        content: [
          {
            type: 'text' as const,
            text: `No document or section found for ID ${documentId}.`,
          },
        ],
        structuredContent: {
          documentationVersion: this.documentation.documentationVersion,
          documentId,
          sectionId: sectionId ?? null,
          found: false,
          title: null,
          sourceRevision: null,
          sections: [],
          truncated: false,
          nextCursor: null,
        },
      };

    const formatted = formatDocument(
      document,
      this.documentation.documentationVersion,
    );
    return {
      content: [{ type: 'text' as const, text: formatted }],
      structuredContent: {
        documentationVersion: this.documentation.documentationVersion,
        documentId,
        sectionId: sectionId ?? null,
        found: true,
        title: document.title,
        sourceRevision: document.sourceRevision,
        sections: document.sections,
        truncated: document.truncated,
        nextCursor: document.nextCursor ?? null,
      },
    };
  }
}

function formatSearchResults(
  results: DocumentationSearchResult[],
  version: NestJsDocumentationVersion,
): string {
  return !results.length
    ? 'No matching NestJS documentation found.'
    : [
        `Documentation major: v${version}`,
        ...results.map((result, index) =>
          [
            `### ${index + 1}. ${result.title}`,
            `Document ID: ${result.documentId}`,
            `Section ID: ${result.chunkId}`,
            `Source revision: ${result.sourceRevision}`,
            `Source: ${result.canonicalUrl}`,
            `Excerpt: ${result.excerpt}`,
          ].join('\n'),
        ),
      ].join('\n\n');
}

function formatDocument(
  document: FetchedDocumentation,
  version: NestJsDocumentationVersion,
): string {
  const sections = document.sections
    .map(
      (section) =>
        `## ${section.headingPath}\nSource: ${section.canonicalUrl}\n\n${section.markdown}`,
    )
    .join('\n\n');
  const truncationNotice = document.truncated
    ? `\n\n[Document excerpt truncated. Continue with cursor: ${document.nextCursor}]`
    : '';

  return [
    `# ${document.title}`,
    `Documentation major: v${version}`,
    `Document ID: ${document.documentId}`,
    `Source revision: ${document.sourceRevision}`,
    '',
    sections,
    truncationNotice,
  ].join('\n');
}
