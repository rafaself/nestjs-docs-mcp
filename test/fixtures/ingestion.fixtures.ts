import { readFile } from 'node:fs/promises';
import {
  NESTJS_DOCUMENTATION_REPOSITORY,
  createNestJsDocumentationIdentity,
} from '../../apps/docs-indexer/src/integrations/nestjs/version/documentation-version.js';
import {
  DOCUMENTATION_SOURCES,
  readContentAliases,
  readSourceIndex,
} from '../../apps/docs-indexer/src/integrations/nestjs/github/documentation-source.js';
import { sourceUrl } from '../../apps/docs-indexer/src/integrations/nestjs/github/documentation-source.js';
import type { DocumentationSnapshot } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import type { DocumentationCorpus } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import type { NestJsDocumentationVersion } from '../../apps/docs-indexer/src/integrations/nestjs/version/documentation-version.js';
import { ingestSnapshot as runDocumentationIngestion } from '@nestjs-docs/documentation-engine/application/services/documentation-ingestion.service.js';
import { transformNestJsDocument } from '../../apps/docs-indexer/src/integrations/nestjs/nestjs-documentation-transformer.js';

export const revision = 'a'.repeat(40);

export function makeNestJsSnapshot(
  version: NestJsDocumentationVersion,
  sourceDocuments: Array<{
    path: string;
    canonicalUrl: string;
    markdown: string;
  }>,
  sourceRevision = revision,
): DocumentationSnapshot {
  return {
    version,
    source: {
      kind: 'git',
      repository: NESTJS_DOCUMENTATION_REPOSITORY,
      ref: DOCUMENTATION_SOURCES[version].ref,
      revision: sourceRevision,
    },
    documents: sourceDocuments.map((document) => ({
      ...createNestJsDocumentationIdentity(version, document.path),
      ...document,
      sourceLocation: sourceUrl(sourceRevision, document.path),
    })),
  };
}

export function ingestSnapshot(
  snapshot: DocumentationSnapshot,
  maxChunkChars = 4000,
): DocumentationCorpus {
  return runDocumentationIngestion(snapshot, transformNestJsDocument, maxChunkChars);
}

export function ingestNestJsDocuments(
  version: NestJsDocumentationVersion,
  documents: Array<{
    path: string;
    canonicalUrl: string;
    markdown: string;
  }>,
  sourceRevision = revision,
  maxChunkChars = 4000,
): DocumentationCorpus {
  return ingestSnapshot(
    makeNestJsSnapshot(version, documents, sourceRevision),
    maxChunkChars,
  );
}
export const fixture = (path: string): Promise<string> => readFile(new URL(`./documentation/${path}`, import.meta.url), 'utf8');
export async function loadIngestionFixtures(): Promise<{ snapshot: DocumentationSnapshot; index: string; aliases: string }> {
  const [index, aliases] = await Promise.all([fixture('navigation.txt'), fixture('aliases.txt')]);
  const entries = readSourceIndex(index, readContentAliases(aliases));
  const sourceDocuments = await Promise.all(entries.map(async (entry) => ({
    ...entry,
    markdown: await fixture(entry.path.replace(/^content\//, '')),
  })));
  return {
    index,
    aliases,
    snapshot: makeNestJsSnapshot('12', sourceDocuments),
  };
}
