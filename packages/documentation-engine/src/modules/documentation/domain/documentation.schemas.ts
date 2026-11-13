import { z } from 'zod';

const nonEmptyString = z.string().refine((value) => value.trim().length > 0);
const sha256Hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const DocumentationVersionSchema = nonEmptyString;

export const DocumentationIdentitySchema = z.strictObject({
  id: nonEmptyString,
  version: DocumentationVersionSchema,
});

export const LocalDocumentationSourceSchema = z.strictObject({
  kind: z.literal('local'),
  root: nonEmptyString,
  revision: nonEmptyString,
});

export const GitDocumentationSourceSchema = z.strictObject({
  kind: z.literal('git'),
  repository: nonEmptyString,
  ref: nonEmptyString,
  revision: nonEmptyString,
});

export const DocumentationSourceProvenanceSchema = z.discriminatedUnion(
  'kind',
  [LocalDocumentationSourceSchema, GitDocumentationSourceSchema],
);

export const SourceDocumentSchema = DocumentationIdentitySchema.extend({
  path: nonEmptyString,
  canonicalUrl: z.url(),
  sourceLocation: nonEmptyString,
  markdown: z.string(),
});

export const DocumentationSnapshotSchema = z
  .strictObject({
    version: DocumentationVersionSchema,
    source: DocumentationSourceProvenanceSchema,
    documents: z.array(SourceDocumentSchema).min(1),
  })
  .superRefine((snapshot, context) => {
    const ids = new Set<string>();
    for (const [index, document] of snapshot.documents.entries()) {
      if (document.version !== snapshot.version) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'version'],
          message: 'Document version must match its snapshot',
        });
      }
      if (ids.has(document.id)) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'id'],
          message: 'Snapshot document IDs must be unique',
        });
      }
      ids.add(document.id);
    }
  });

export const HeadingSchema = z.strictObject({
  level: z.number().int().min(1).max(6),
  title: nonEmptyString,
  slug: nonEmptyString,
});

export const CodeExampleSchema = z.strictObject({
  language: z.string(),
  filename: z.string().optional(),
  code: z.string(),
});

export const DocumentationChunkSchema = z.strictObject({
  id: nonEmptyString,
  documentId: nonEmptyString,
  index: z.number().int().nonnegative(),
  title: nonEmptyString,
  canonicalUrl: z.url(),
  sourceRevision: nonEmptyString,
  headingPath: z.array(HeadingSchema),
  markdown: z.string(),
  contentHash: sha256Hash,
  codeExamples: z.array(CodeExampleSchema),
});

export const NormalizedDocumentSourceSchema = z.strictObject({
  provenance: DocumentationSourceProvenanceSchema,
  path: nonEmptyString,
  location: nonEmptyString,
  contentHash: sha256Hash,
});

export const DocumentationFrontmatterSchema = z.strictObject({
  format: z.enum(['yaml', 'toml']),
  raw: z.string(),
  title: nonEmptyString.optional(),
});

export const NormalizedDocumentSchema = DocumentationIdentitySchema.extend({
  title: nonEmptyString,
  canonicalUrl: z.url(),
  source: NormalizedDocumentSourceSchema,
  frontmatter: DocumentationFrontmatterSchema.optional(),
  markdown: z.string(),
  contentHash: sha256Hash,
  headings: z.array(HeadingSchema),
  chunks: z.array(DocumentationChunkSchema).min(1),
}).superRefine((document, context) => {
  const chunkIds = new Set<string>();
  for (const [index, chunk] of document.chunks.entries()) {
    if (chunk.documentId !== document.id) {
      context.addIssue({
        code: 'custom',
        path: ['chunks', index, 'documentId'],
        message: 'Chunk document ID must match its document',
      });
    }
    if (chunk.title !== document.title) {
      context.addIssue({
        code: 'custom',
        path: ['chunks', index, 'title'],
        message: 'Chunk title must match its document',
      });
    }
    if (chunkIds.has(chunk.id)) {
      context.addIssue({
        code: 'custom',
        path: ['chunks', index, 'id'],
        message: 'Document chunk IDs must be unique',
      });
    }
    chunkIds.add(chunk.id);
  }
});

export const DocumentationCorpusSchema = z
  .strictObject({
    version: DocumentationVersionSchema,
    source: DocumentationSourceProvenanceSchema,
    documents: z.array(NormalizedDocumentSchema).min(1),
  })
  .superRefine((corpus, context) => {
    const ids = new Set<string>();
    const chunkIds = new Set<string>();
    for (const [index, document] of corpus.documents.entries()) {
      if (document.version !== corpus.version) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'version'],
          message: 'Document version must match its corpus',
        });
      }
      if (!sameSourceProvenance(document.source.provenance, corpus.source)) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'source', 'provenance'],
          message: 'Document provenance must match its corpus',
        });
      }
      if (ids.has(document.id)) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'id'],
          message: 'Corpus document IDs must be unique',
        });
      }
      ids.add(document.id);
      for (const [chunkIndex, chunk] of document.chunks.entries()) {
        if (chunk.sourceRevision !== corpus.source.revision) {
          context.addIssue({
            code: 'custom',
            path: ['documents', index, 'chunks', chunkIndex, 'sourceRevision'],
            message: 'Chunk revision must match its corpus source',
          });
        }
        if (chunkIds.has(chunk.id)) {
          context.addIssue({
            code: 'custom',
            path: ['documents', index, 'chunks', chunkIndex, 'id'],
            message: 'Corpus chunk IDs must be unique',
          });
        }
        chunkIds.add(chunk.id);
      }
    }
  });

function sameSourceProvenance(
  left: z.infer<typeof DocumentationSourceProvenanceSchema>,
  right: z.infer<typeof DocumentationSourceProvenanceSchema>,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'local' && right.kind === 'local'
    ? left.root === right.root && left.revision === right.revision
    : left.kind === 'git' &&
        right.kind === 'git' &&
        left.repository === right.repository &&
        left.ref === right.ref &&
        left.revision === right.revision;
}
