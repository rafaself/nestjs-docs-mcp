import { Injectable } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import * as z from 'zod';
import { DocumentationSearchService } from './search/search.service.js';
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
});

@Injectable()
export class DocumentationTools {
  constructor(private readonly documentation: DocumentationSearchService) {}

  @Tool({
    name: 'search_docs',
    description:
      'Search the latest indexed NestJS documentation. Returns ranked section excerpts, document IDs, and official source URLs.',
    inputSchema: searchDocsInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  searchDocs({ query, limit }: { query: string; limit?: number }): string {
    const results = this.documentation.search(
      query,
      limit ?? DEFAULT_SEARCH_RESULT_LIMIT,
    );
    if (!results.length) return 'No matching NestJS documentation found.';

    return results
      .map((result, index) =>
        [
          `### ${index + 1}. ${result.title}`,
          `Document ID: ${result.documentId}`,
          `Source: ${result.canonicalUrl}`,
          `Excerpt: ${result.excerpt}`,
        ].join('\n'),
      )
      .join('\n\n');
  }

  @Tool({
    name: 'fetch_docs',
    description:
      'Fetch a bounded section-aware excerpt of one latest NestJS documentation document by its deterministic document ID.',
    inputSchema: fetchDocsInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  fetchDocs({ documentId }: { documentId: string }): string {
    const document = this.documentation.fetchDocument(documentId);
    if (!document) return `No document found for ID ${documentId}.`;

    const sections = document.sections
      .map(
        (section) =>
          `## ${section.headingPath}\nSource: ${section.canonicalUrl}\n\n${section.markdown}`,
      )
      .join('\n\n');
    const truncationNotice = document.truncated
      ? '\n\n[Document excerpt truncated to limit output size. Use search_docs to find a narrower section.]'
      : '';

    return [
      `# ${document.title}`,
      `Document ID: ${document.documentId}`,
      `Source revision: ${document.sourceRevision}`,
      '',
      sections,
      truncationNotice,
    ].join('\n');
  }
}
