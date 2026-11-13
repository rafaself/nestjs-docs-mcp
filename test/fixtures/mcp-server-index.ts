import type { DocumentationCorpus } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { DocumentationCorpusSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import {
  DOCUMENTATION_BUILD_MANIFEST_VERSION,
  DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
  DocumentationBuildManifestSchema,
  DocumentationIndexRuntimeManifestSchema,
  type DocumentationIndexRuntimeManifest,
} from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import { parseMarkdown } from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import { normalizeAndChunkDocument } from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import {
  DOCUMENT_CHUNKING_ALGORITHM_VERSION,
  DOCUMENT_NORMALIZATION_ALGORITHM_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import { MARKDOWN_PARSER_VERSION } from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function createMcpServerTestIndex(
  databasePath: string,
  version = '12',
): DocumentationCorpus {
  const source = {
    kind: 'local' as const,
    root: '/synthetic/mcp-docs',
    revision: 'mcp-synthetic-revision',
  };
  const file = {
    id: 'synthetic-mcp-documentation',
    version,
    path: 'execution-context.md',
    canonicalUrl: 'https://docs.example.test/execution-context',
    sourceLocation: 'file:///synthetic/mcp-docs/execution-context.md',
    markdown:
      '# Execution context\n\n## API\n\nExecutionContext provides execution-context details for this synthetic index.\n',
  };
  const document = normalizeAndChunkDocument(
    file,
    source,
    parseMarkdown(file.markdown, { path: file.path }),
  );
  const corpus = DocumentationCorpusSchema.parse({
    version,
    source,
    documents: [document],
  });
  const writer = new DocumentationIndexWriter(databasePath, version);
  try {
    writer.indexCorpus(corpus);
  } finally {
    writer.close();
  }
  const corpusContents = `${JSON.stringify(corpus, null, 2)}\n`;
  writeFileSync(join(dirname(databasePath), 'corpus.json'), corpusContents);
  const chunkCount = corpus.documents.reduce(
    (count, entry) => count + entry.chunks.length,
    0,
  );
  const manifest = DocumentationBuildManifestSchema.parse({
    manifestVersion: DOCUMENTATION_BUILD_MANIFEST_VERSION,
    documentation: {
      id: 'synthetic-mcp-documentation',
      version: corpus.version,
    },
    source: corpus.source,
    pipeline: {
      parserVersion: MARKDOWN_PARSER_VERSION,
      transformerVersion: 1,
      normalizationAlgorithmVersion: DOCUMENT_NORMALIZATION_ALGORITHM_VERSION,
      chunkingAlgorithmVersion: DOCUMENT_CHUNKING_ALGORITHM_VERSION,
      maxChunkChars: 4000,
      indexSchemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
      indexFormatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
    },
    corpus: {
      file: 'corpus.json',
      sha256: createHash('sha256').update(corpusContents).digest('hex'),
      documentCount: corpus.documents.length,
      documents: corpus.documents.map((entry) => ({
        id: entry.id,
        path: entry.source.path,
        sourceContentHash: entry.source.contentHash,
        normalizedContentHash: entry.contentHash,
      })),
    },
    index: {
      file: 'index.sqlite',
      sha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
      documentationVersion: corpus.version,
      sourceRevision: corpus.source.revision,
      schemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
      formatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
      documentCount: corpus.documents.length,
      chunkCount,
    },
  });
  writeFileSync(
    join(dirname(databasePath), 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return corpus;
}

export function createTestIndexManifest(
  databasePath: string,
  corpus: DocumentationCorpus,
  documentationId = 'synthetic-mcp-documentation',
): DocumentationIndexRuntimeManifest {
  const indexBytes = readFileSync(databasePath);
  const chunkCount = corpus.documents.reduce(
    (count, document) => count + document.chunks.length,
    0,
  );
  return DocumentationIndexRuntimeManifestSchema.parse({
    manifestVersion: DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
    documentation: { id: documentationId, version: corpus.version },
    source: corpus.source,
    index: {
      file: basename(databasePath),
      sha256: createHash('sha256').update(indexBytes).digest('hex'),
      documentationVersion: corpus.version,
      sourceRevision: corpus.source.revision,
      schemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
      formatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
      documentCount: corpus.documents.length,
      chunkCount,
    },
  });
}
