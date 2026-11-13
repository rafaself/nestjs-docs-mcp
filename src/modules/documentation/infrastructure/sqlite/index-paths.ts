import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestJsDocumentationVersion } from '../../domain/documentation-version.js';

const PACKAGE_DATA_DIRECTORY = fileURLToPath(
  new URL('../../../../../data/', import.meta.url),
);

export function searchDatabasePath(
  version: NestJsDocumentationVersion,
): string {
  return resolve(PACKAGE_DATA_DIRECTORY, `documentation-v${version}.sqlite`);
}
