import { z } from 'zod';
import {
  DocumentationIdentitySchema,
  DocumentationSourceProvenanceSchema,
  DocumentationVersionSchema,
} from './documentation.schemas.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();

export const DOCUMENTATION_BUILD_MANIFEST_VERSION = 2;
export const DOCUMENTATION_RUNTIME_MANIFEST_VERSION = 1;

const runtimeIndexFields = {
  file: nonEmptyStringSchema,
  sha256: sha256Schema,
  documentationVersion: DocumentationVersionSchema,
  sourceRevision: nonEmptyStringSchema,
  schemaVersion: positiveIntegerSchema,
  formatVersion: positiveIntegerSchema,
  documentCount: positiveIntegerSchema,
  chunkCount: positiveIntegerSchema,
};

const manifestIdentityFields = {
  documentation: DocumentationIdentitySchema,
  source: DocumentationSourceProvenanceSchema,
};

const runtimeManifestFields = {
  manifestVersion: z.literal(DOCUMENTATION_RUNTIME_MANIFEST_VERSION),
  ...manifestIdentityFields,
  index: z.strictObject(runtimeIndexFields),
};

function validateManifestIdentity(
  manifest: {
    documentation: { version: string };
    source: { revision: string };
    index: { documentationVersion: string; sourceRevision: string };
  },
  context: z.RefinementCtx,
): void {
  if (manifest.documentation.version !== manifest.index.documentationVersion) {
    context.addIssue({
      code: 'custom',
      path: ['index', 'documentationVersion'],
      message: 'Index version must match the documentation identity',
    });
  }
  if (manifest.source.revision !== manifest.index.sourceRevision) {
    context.addIssue({
      code: 'custom',
      path: ['index', 'sourceRevision'],
      message: 'Index revision must match the documentation source',
    });
  }
}

/** Small validated manifest projection consumed at runtime. */
export const DocumentationIndexRuntimeManifestSchema = z
  .strictObject(runtimeManifestFields)
  .superRefine(validateManifestIdentity);

/** Full deterministic build manifest used for package and corpus verification. */
export const DocumentationBuildManifestSchema = z
  .strictObject({
    manifestVersion: z.literal(DOCUMENTATION_BUILD_MANIFEST_VERSION),
    ...manifestIdentityFields,
    index: z.strictObject({
      ...runtimeIndexFields,
      file: z.literal('index.sqlite'),
    }),
    pipeline: z.strictObject({
      parserVersion: positiveIntegerSchema,
      transformerVersion: positiveIntegerSchema,
      normalizationAlgorithmVersion: positiveIntegerSchema,
      chunkingAlgorithmVersion: positiveIntegerSchema,
      maxChunkChars: positiveIntegerSchema,
      indexSchemaVersion: positiveIntegerSchema,
      indexFormatVersion: positiveIntegerSchema,
    }),
    corpus: z.strictObject({
      file: z.literal('corpus.json'),
      sha256: sha256Schema,
      documentCount: positiveIntegerSchema,
      documents: z.array(
        z.strictObject({
          id: nonEmptyStringSchema,
          path: nonEmptyStringSchema,
          sourceContentHash: sha256Schema,
          normalizedContentHash: sha256Schema,
        }),
      ),
    }),
  })
  .superRefine((manifest, context) => {
    validateManifestIdentity(manifest, context);
    if (
      manifest.pipeline.indexSchemaVersion !== manifest.index.schemaVersion ||
      manifest.pipeline.indexFormatVersion !== manifest.index.formatVersion
    ) {
      context.addIssue({
        code: 'custom',
        path: ['pipeline'],
        message: 'Pipeline index versions must match the index metadata',
      });
    }
    if (
      manifest.corpus.documentCount !== manifest.corpus.documents.length ||
      manifest.index.documentCount !== manifest.corpus.documentCount
    ) {
      context.addIssue({
        code: 'custom',
        path: ['corpus', 'documentCount'],
        message: 'Corpus and index document counts must agree',
      });
    }
    const documentIds = new Set<string>();
    const paths = new Set<string>();
    for (const [index, document] of manifest.corpus.documents.entries()) {
      if (documentIds.has(document.id) || paths.has(document.path)) {
        context.addIssue({
          code: 'custom',
          path: ['corpus', 'documents', index],
          message: 'Manifest document IDs and paths must be unique',
        });
      }
      documentIds.add(document.id);
      paths.add(document.path);
    }
  });

export type DocumentationIndexRuntimeManifest = z.infer<
  typeof DocumentationIndexRuntimeManifestSchema
>;
export type DocumentationBuildManifest = z.infer<
  typeof DocumentationBuildManifestSchema
>;
