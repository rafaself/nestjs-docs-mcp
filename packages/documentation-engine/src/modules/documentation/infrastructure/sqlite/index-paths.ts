import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentationVersion } from '../../domain/documentation.types.js';

const PACKAGE_DATA_DIRECTORY = fileURLToPath(
  new URL('../../../../../data/', import.meta.url),
);

export function searchDatabasePath(version: DocumentationVersion): string {
  return resolve(PACKAGE_DATA_DIRECTORY, `documentation-v${version}.sqlite`);
}
