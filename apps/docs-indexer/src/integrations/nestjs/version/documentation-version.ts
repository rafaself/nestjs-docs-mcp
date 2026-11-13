import { createHash } from 'node:crypto';
import type { DocumentationIdentity } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';

export const SUPPORTED_DOCUMENTATION_VERSIONS = ['11', '12'] as const;

export type NestJsDocumentationVersion =
  (typeof SUPPORTED_DOCUMENTATION_VERSIONS)[number];

export const DEFAULT_DOCUMENTATION_VERSION: NestJsDocumentationVersion = '12';
export const NESTJS_DOCUMENTATION_REPOSITORY =
  'https://github.com/nestjs/docs.nestjs.com';

const DOCUMENTATION_VERSION_PATTERN =
  SUPPORTED_DOCUMENTATION_VERSIONS.join('|');
const DOCUMENT_ID_VERSION_PATTERN = new RegExp(
  `^nestjs-doc:v(${DOCUMENTATION_VERSION_PATTERN}):[0-9a-f]{64}$`,
  'u',
);
export const DOCUMENT_ID_PATTERN = new RegExp(
  `^nestjs-doc:v(?:${DOCUMENTATION_VERSION_PATTERN}):[0-9a-f]{64}$`,
  'u',
);

/** Resolve and validate the NestJS-specific process version at the app boundary. */
export function parseDocumentationVersion(
  value: string | undefined,
): NestJsDocumentationVersion {
  if (value === undefined) return DEFAULT_DOCUMENTATION_VERSION;
  if (value === '11' || value === '12') return value;

  throw new Error(
    `Invalid NESTJS_VERSION "${value}". Supported values are 11 and 12.`,
  );
}

export function createNestJsDocumentationIdentity(
  version: NestJsDocumentationVersion,
  sourcePath: string,
): DocumentationIdentity {
  const digest = createHash('sha256')
    .update(
      `${NESTJS_DOCUMENTATION_REPOSITORY}\0v${version}\0${sourcePath}`,
      'utf8',
    )
    .digest('hex');
  return { id: `nestjs-doc:v${version}:${digest}`, version };
}

export function documentationVersionFromId(
  documentId: string,
): NestJsDocumentationVersion | null {
  const match = DOCUMENT_ID_VERSION_PATTERN.exec(documentId);
  if (match?.[1] === '11') return '11';
  if (match?.[1] === '12') return '12';
  return null;
}
