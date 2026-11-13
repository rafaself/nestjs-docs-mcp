import type { DocumentationIdentity } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { DocumentationSnapshotSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import {
  discoverLocalDocumentation,
  DocumentationDiscoverySettingsSchema,
  type DocumentationDiscoveryOptions,
} from '@nestjs-docs/documentation-engine/infrastructure/filesystem/documentation-discovery.js';
import { normalizeAndChunkDocument } from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import {
  parseMarkdown,
  type MarkdownDiagnostic,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import {
  DocumentationBuildConfigSchema,
  type DocumentationBuildConfig,
} from '../config/documentation-build-config.js';
import {
  buildDocumentationSnapshot,
  type DocumentationBuildMode,
  type DocumentationBuildDiagnostic,
  type DocumentationBuildSummary,
} from './build-documentation-snapshot.js';

/** Increment when local source-to-document transforms change. */
export const LOCAL_DOCUMENTATION_TRANSFORMER_VERSION = 1;

export type {
  DocumentationBuildDiagnostic,
  DocumentationBuildSummary,
} from './build-documentation-snapshot.js';

/** Build a local Markdown/MDX directory through the shared documentation engine. */
export async function buildLocalDocumentation(
  configInput: DocumentationBuildConfig,
  options: { mode?: DocumentationBuildMode } = {},
): Promise<DocumentationBuildSummary> {
  const config = DocumentationBuildConfigSchema.parse(configInput);
  const discoverySettings = DocumentationDiscoverySettingsSchema.parse(
    config.discovery ?? {},
  );
  const snapshot = await discoverLocalDocumentation({
    ...discoverySettings,
    root: config.inputDirectory,
    version: config.version,
  } satisfies DocumentationDiscoveryOptions);
  const routedSnapshot = DocumentationSnapshotSchema.parse({
    ...snapshot,
    documents: snapshot.documents.map((document) => ({
      ...document,
      canonicalUrl: mapCanonicalRoute(
        document.path,
        config.routeMapping.baseUrl,
        config.routeMapping.pathPrefix,
        config.routeMapping.indexFileNames,
      ),
    })),
  });

  const identity: DocumentationIdentity = {
    id: config.id,
    version: config.version,
  };
  const diagnostics: DocumentationBuildDiagnostic[] = [];
  return buildDocumentationSnapshot({
    identity,
    snapshot: routedSnapshot,
    transformerVersion: LOCAL_DOCUMENTATION_TRANSFORMER_VERSION,
    transformDocument: (file, source, maxChunkChars) => {
      const parsed = parseMarkdown(file.markdown, { path: file.path });
      diagnostics.push(
        ...parsed.diagnostics.map((diagnostic: MarkdownDiagnostic) => ({
          ...diagnostic,
          path: file.path,
        })),
      );
      return normalizeAndChunkDocument(file, source, parsed, {
        identity,
        maxChunkChars,
      });
    },
    outputDirectory: config.outputDirectory,
    mode: options.mode,
    maxChunkChars: config.maxChunkChars,
    diagnostics,
  });
}

function mapCanonicalRoute(
  documentPath: string,
  baseUrl: string,
  pathPrefix: string,
  indexFileNames: string[],
): string {
  const pathSegments = documentPath.split('/');
  const lastSegment = pathSegments.at(-1)!;
  const routeName = lastSegment.replace(/\.(?:md|mdx)$/iu, '');
  pathSegments[pathSegments.length - 1] = routeName;
  if (
    indexFileNames.some(
      (indexName) => indexName.toLowerCase() === routeName.toLowerCase(),
    )
  ) {
    pathSegments.pop();
  }

  const routeSegments = [
    ...pathPrefix.split('/').filter(Boolean),
    ...pathSegments.filter(Boolean),
  ];
  const base = new URL(baseUrl);
  const baseSegments = base.pathname.split('/').filter(Boolean);
  base.pathname = `/${[...baseSegments, ...routeSegments]
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
  return base.href;
}
