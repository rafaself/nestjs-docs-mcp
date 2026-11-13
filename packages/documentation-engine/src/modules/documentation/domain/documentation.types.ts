import type { z } from 'zod';
import type {
  CodeExampleSchema,
  DocumentationChunkSchema,
  DocumentationCorpusSchema,
  DocumentationFrontmatterSchema,
  DocumentationIdentitySchema,
  DocumentationSnapshotSchema,
  DocumentationSourceProvenanceSchema,
  DocumentationVersionSchema,
  HeadingSchema,
  NormalizedDocumentSchema,
  NormalizedDocumentSourceSchema,
  SourceDocumentSchema,
} from './documentation.schemas.js';

export type DocumentationVersion = z.infer<typeof DocumentationVersionSchema>;
export type DocumentationIdentity = z.infer<typeof DocumentationIdentitySchema>;
export type DocumentationSourceProvenance = z.infer<
  typeof DocumentationSourceProvenanceSchema
>;
export type LocalDocumentationSource = Extract<
  DocumentationSourceProvenance,
  { kind: 'local' }
>;
export type GitDocumentationSource = Extract<
  DocumentationSourceProvenance,
  { kind: 'git' }
>;
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type DocumentationSnapshot = z.infer<typeof DocumentationSnapshotSchema>;
export type Heading = z.infer<typeof HeadingSchema>;
export type CodeExample = z.infer<typeof CodeExampleSchema>;
export type DocumentationChunk = z.infer<typeof DocumentationChunkSchema>;
export type DocumentationFrontmatter = z.infer<
  typeof DocumentationFrontmatterSchema
>;
export type NormalizedDocumentSource = z.infer<
  typeof NormalizedDocumentSourceSchema
>;
export type NormalizedDocument = z.infer<typeof NormalizedDocumentSchema>;
export type DocumentationCorpus = z.infer<typeof DocumentationCorpusSchema>;
