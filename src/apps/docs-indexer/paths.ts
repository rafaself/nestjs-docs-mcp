import type { NestJsDocumentationVersion } from '../../modules/documentation/domain/documentation-version.js';

export function documentationCorpusPath(
  version: NestJsDocumentationVersion,
): string {
  return `data/documentation-v${version}.json`;
}
