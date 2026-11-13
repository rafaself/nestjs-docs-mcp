import type { NestJsDocumentationVersion } from './integrations/nestjs/version/documentation-version.js';

export function documentationCorpusPath(
  version: NestJsDocumentationVersion,
): string {
  return `data/documentation-v${version}.json`;
}
