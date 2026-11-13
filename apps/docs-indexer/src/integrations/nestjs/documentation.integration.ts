import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  DocumentationCorpus,
  DocumentationSnapshot,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { ingestSnapshot } from '@nestjs-docs/documentation-engine/application/services/documentation-ingestion.service.js';
import {
  downloadDocumentation,
  REPOSITORY,
} from './github/documentation-source.js';
import {
  NESTJS_DOCUMENTATION_TRANSFORMER_VERSION,
  transformNestJsDocument,
} from './nestjs-documentation-transformer.js';
import {
  DEFAULT_DOCUMENTATION_VERSION,
  SUPPORTED_DOCUMENTATION_VERSIONS,
  type NestJsDocumentationVersion,
} from './version/documentation-version.js';
import {
  buildDocumentationSnapshot,
  prepareDocumentationOutputDirectory,
  promoteDocumentationOutput,
  type DocumentationBuildMode,
  type DocumentationBuildSummary,
} from '../../services/build-documentation-snapshot.js';

export interface NestJsDocumentationIngestion {
  snapshot: DocumentationSnapshot;
  corpus: DocumentationCorpus;
}

export interface NestJsDocumentationSetBuildSummary {
  outputDirectory: string;
  versions: DocumentationBuildSummary[];
  cleanupWarning?: string;
}

export interface NestJsDocumentationSetBuildOptions {
  mode?: DocumentationBuildMode;
}

/** Resolve the selected official ref, pin all downloads, then use the shared ingestion engine. */
export async function ingestNestJsDocumentation(
  version: NestJsDocumentationVersion = DEFAULT_DOCUMENTATION_VERSION,
  fetcher: typeof fetch = fetch,
  maxChunkChars = 4000,
): Promise<NestJsDocumentationIngestion> {
  const snapshot = await downloadDocumentation(version, fetcher);
  const corpus = ingestSnapshot(
    snapshot,
    transformNestJsDocument,
    maxChunkChars,
  );
  return { snapshot, corpus };
}

/** Build both official majors in one validated directory promotion. */
export async function buildNestJsDocumentationSet(
  outputPath: string,
  fetcher: typeof fetch = fetch,
  options: NestJsDocumentationSetBuildOptions = {},
): Promise<NestJsDocumentationSetBuildSummary> {
  const outputDirectory = await prepareDocumentationOutputDirectory(outputPath);
  const stagingDirectory = await mkdtemp(
    join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-`),
  );
  const stagedSummaries: DocumentationBuildSummary[] = [];
  try {
    for (const version of SUPPORTED_DOCUMENTATION_VERSIONS) {
      const snapshot = await downloadDocumentation(version, fetcher);
      const summary = await buildDocumentationSnapshot({
        identity: { id: REPOSITORY, version },
        snapshot,
        transformerVersion: NESTJS_DOCUMENTATION_TRANSFORMER_VERSION,
        transformDocument: transformNestJsDocument,
        outputDirectory: join(stagingDirectory, `v${version}`),
        previousOutputDirectory: join(outputDirectory, `v${version}`),
        mode: options.mode,
      });
      stagedSummaries.push(summary);
    }
    const cleanupWarning = await promoteDocumentationOutput(
      stagingDirectory,
      outputDirectory,
    );
    return {
      outputDirectory,
      versions: stagedSummaries.map((summary) => ({
        ...summary,
        outputDirectory: join(outputDirectory, `v${summary.version}`),
      })),
      ...(cleanupWarning && { cleanupWarning }),
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
