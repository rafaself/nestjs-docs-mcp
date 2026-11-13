import * as z from 'zod';
import {
  MAX_DOCUMENT_ID_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
} from '@nestjs-docs/documentation-engine/retrieval/search.constants.js';

const MAX_TOOL_SEARCH_RESULTS = 10;

export const searchDocsInputSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SEARCH_QUERY_LENGTH)
    .describe(
      'Natural-language terms or an exact identifier from the indexed documentation.',
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
    .trim()
    .min(1)
    .max(MAX_DOCUMENT_ID_LENGTH)
    .refine((value) => !containsForbiddenControlCharacters(value))
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
  documentationId: z.string(),
  documentationVersion: z.string(),
  results: z.array(searchResultSchema),
});

export const fetchDocsOutputSchema = z.object({
  documentationId: z.string(),
  documentationVersion: z.string(),
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

function containsForbiddenControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 8 ||
      (code >= 11 && code <= 12) ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      return true;
    }
  }
  return false;
}
