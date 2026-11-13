import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DocumentationBuildManifestSchema,
  DocumentationIndexRuntimeManifestSchema,
  DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
  type DocumentationIndexRuntimeManifest,
} from '../../domain/documentation-index-manifest.schemas.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from './index-schema.js';

/** Load and validate the manifest that describes one existing SQLite index. */
export function loadDocumentationIndexManifest(
  databasePath: string,
  manifestPath = join(dirname(resolve(databasePath)), 'manifest.json'),
): DocumentationIndexRuntimeManifest {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read documentation index manifest "${manifestPath}"`,
      { cause: error },
    );
  }

  const buildManifest = DocumentationBuildManifestSchema.safeParse(parsedJson);
  let manifest: DocumentationIndexRuntimeManifest;
  if (buildManifest.success) {
    manifest = DocumentationIndexRuntimeManifestSchema.parse({
      manifestVersion: DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
      documentation: buildManifest.data.documentation,
      source: buildManifest.data.source,
      index: buildManifest.data.index,
    });
  } else {
    const runtimeManifest =
      DocumentationIndexRuntimeManifestSchema.safeParse(parsedJson);
    if (!runtimeManifest.success) {
      const issue = runtimeManifest.error.issues[0];
      const location = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
      throw new Error(
        `Invalid documentation index manifest${location}: ${issue?.message ?? 'invalid format'}`,
        { cause: runtimeManifest.error },
      );
    }
    manifest = runtimeManifest.data;
  }

  if (manifest.index.file !== basename(resolve(databasePath))) {
    throw new Error(
      'Documentation index manifest names a different database file',
    );
  }
  if (
    manifest.index.schemaVersion !== DOCUMENTATION_INDEX_SCHEMA_VERSION ||
    manifest.index.formatVersion !== DOCUMENTATION_INDEX_FORMAT_VERSION
  ) {
    throw new Error('Documentation index manifest format is unsupported');
  }
  return manifest;
}
