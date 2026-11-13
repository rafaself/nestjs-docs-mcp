import * as z from 'zod';
import type { FetchedDocumentation } from '../../application/contracts/documentation-reader.contract.js';
import { DOCUMENT_ID_PATTERN } from '../../domain/documentation-version.js';
import { MAX_SEARCH_QUERY_LENGTH } from '../../retrieval/search.constants.js';

const MAX_TOOL_SEARCH_RESULTS = 10;

export const searchDocsInputSchema = z.strictObject({
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

export const fetchDocsInputSchema = z.strictObject({
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

export const searchDocsOutputSchema = z.object({
  documentationVersion: z.number(),
  results: z.array(searchResultSchema),
});

export const fetchDocsOutputSchema = z.object({
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

export type SearchDocsInput = z.infer<typeof searchDocsInputSchema>;
export type SearchDocsOutput = z.infer<typeof searchDocsOutputSchema>;
export type FetchDocsInput = z.infer<typeof fetchDocsInputSchema>;
export type FetchDocsOutput = z.infer<typeof fetchDocsOutputSchema>;

export interface FetchDocsPresentationInput extends FetchDocsInput {
  documentationVersion: number;
  document: FetchedDocumentation | null;
}
