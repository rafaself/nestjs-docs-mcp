import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  MAX_DOCUMENT_ID_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_QUERY_TERMS,
} from './search.constants.js';

const searchQuerySchema = z
  .string({ error: 'Search query must be a string' })
  .max(
    MAX_SEARCH_QUERY_LENGTH,
    `Search query must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`,
  )
  .refine(
    (value) => !containsForbiddenControlCharacters(value),
    'Search query contains control characters',
  );
const resultLimitSchema = z.number().int().positive().safe();
const documentIdSchema = z
  .string()
  .min(1)
  .max(MAX_DOCUMENT_ID_LENGTH)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !containsForbiddenControlCharacters(value));

export function buildSearchExpression(query: unknown, limit: number): string {
  const parsed = searchQuerySchema.safeParse(query);
  if (!parsed.success)
    throw new BadRequestException(parsed.error.issues[0]?.message);
  if (!resultLimitSchema.safeParse(limit).success) {
    throw new BadRequestException(
      'Search result limit must be a positive integer',
    );
  }
  const terms = [
    ...new Set(parsed.data.trim().match(/[\p{L}\p{N}_]+/gu) ?? []),
  ];
  if (terms.length > MAX_SEARCH_QUERY_TERMS) {
    throw new BadRequestException(
      `Search query must contain at most ${MAX_SEARCH_QUERY_TERMS} terms`,
    );
  }
  // Quote every token so user text stays data, including in phrase queries.
  const quote = (term: string): string => `"${term.replaceAll('"', '""')}"`;
  const quotedTerms = terms.map(quote);
  const alternatives = quotedTerms.join(' OR ');
  if (terms.length < 2) return alternatives;

  // The exact phrase clause gives contiguous multiword matches a relevance
  // lift; the original OR terms remain as a recall fallback.
  const phrase = quote(terms.join(' '));
  return `${phrase} OR ${alternatives}`;
}

export function validateDocumentId(documentId: unknown): string {
  const parsed = documentIdSchema.safeParse(documentId);
  if (!parsed.success)
    throw new BadRequestException('Document ID must be a non-empty string');
  return parsed.data;
}

function containsForbiddenControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 8 ||
      (code >= 11 && code <= 12) ||
      (code >= 14 && code <= 31) ||
      code === 127
    )
      return true;
  }
  return false;
}
