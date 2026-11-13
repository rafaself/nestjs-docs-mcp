import type { NestJsDocumentationVersion } from '../documentation-version.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DATA_DIRECTORY = fileURLToPath(
  new URL('../../data/', import.meta.url),
);

export function searchDatabasePath(
  version: NestJsDocumentationVersion,
): string {
  return resolve(PACKAGE_DATA_DIRECTORY, `documentation-v${version}.sqlite`);
}

export const DEFAULT_SEARCH_RESULT_LIMIT = 10;
export const MAX_SEARCH_RESULT_LIMIT = 50;
export const MAX_SEARCH_QUERY_LENGTH = 256;
export const MAX_SEARCH_QUERY_TERMS = 32;
export const MAX_FETCH_DOCUMENT_CHARS = 12_000;
export const DOCUMENT_ID_PATTERN = /^nestjs-doc:v(?:11|12):[0-9a-f]{64}$/u;
