import { createHash } from 'node:crypto';
import { ingestSnapshot } from '@nestjs-docs/documentation-engine/application/services/documentation-ingestion.service.js';
import type {
  DocumentationSnapshot,
  DocumentationSourceProvenance,
  SourceDocument,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import {
  DOCUMENT_CHUNKING_ALGORITHM_VERSION,
  DOCUMENT_NORMALIZATION_ALGORITHM_VERSION,
  normalizeAndChunkDocument,
  normalizeRelativePath,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import { parseMarkdown } from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';

const provenance = {
  kind: 'git' as const,
  repository: 'https://example.test/docs',
  ref: 'main',
  revision: 'a'.repeat(40),
};

function sourceDocument(
  path: string,
  markdown: string,
  id = `fixture:${path}`,
): SourceDocument {
  return {
    id,
    version: '1',
    path,
    canonicalUrl: `https://example.test/${path.replaceAll('\\', '/')}`,
    sourceLocation: `https://example.test/revision/${path.replaceAll('\\', '/')}`,
    markdown,
  };
}

function transform(
  file: SourceDocument,
  source: DocumentationSourceProvenance,
  maxChunkChars = 4000,
) {
  return normalizeAndChunkDocument(
    file,
    source,
    parseMarkdown(file.markdown, { path: file.path }),
    { maxChunkChars },
  );
}

describe('document normalization and structural chunking', () => {
  it('centralizes algorithm versions and creates repeatable output', () => {
    expect(DOCUMENT_NORMALIZATION_ALGORITHM_VERSION).toBeGreaterThan(0);
    expect(DOCUMENT_CHUNKING_ALGORITHM_VERSION).toBeGreaterThan(0);
    const file = sourceDocument(
      'guide/start.md',
      '# Guide\n\n## Setup\n\nInstall it.\n\n### Detail\n\nConfigure it.\n',
    );
    expect(transform(file, provenance)).toEqual(transform(file, provenance));
  });

  it('sorts shuffled corpus inputs into the same stable normalized output', () => {
    const documents = [
      sourceDocument('zeta.md', '# Zeta\n\nLast.'),
      sourceDocument('alpha.md', '# Alpha\n\nFirst.'),
    ];
    const snapshot: DocumentationSnapshot = {
      version: '1',
      source: provenance,
      documents,
    };
    const first = ingestSnapshot(snapshot, transform);
    const shuffled = ingestSnapshot(
      { ...snapshot, documents: [...documents].reverse() },
      transform,
    );
    expect(shuffled).toEqual(first);
    expect(first.documents.map(({ source }) => source.path)).toEqual([
      'alpha.md',
      'zeta.md',
    ]);
  });

  it('uses stable document identities, duplicate-safe heading refs, and content hashes', () => {
    const original = sourceDocument(
      'guide.md',
      '# Guide\n\n## Setup\n\nOriginal text.\n\n## Setup\n\nMore text.\n',
      'docs-space',
    );
    const changed = {
      ...original,
      markdown: original.markdown.replace('Original', 'Updated'),
    };
    const first = transform(original, provenance);
    const edited = transform(changed, provenance);
    expect(first.id).toBe(edited.id);
    expect(first.headings.map(({ slug }) => slug)).toEqual([
      'guide',
      'setup',
      'setup-1',
    ]);
    expect(first.contentHash).not.toBe(edited.contentHash);
    expect(first.chunks[1]?.id).toBe(edited.chunks[1]?.id);
    expect(first.chunks[1]?.contentHash).not.toBe(
      edited.chunks[1]?.contentHash,
    );
  });

  it('normalizes portable paths and distinguishes identity namespaces', () => {
    const markdown = '# Path\n\nContent.';
    const windowsPath = transform(
      sourceDocument('nested\\path.md', markdown, 'namespace-a'),
      provenance,
    );
    const posixPath = transform(
      sourceDocument('nested/path.md', markdown, 'namespace-a'),
      provenance,
    );
    const otherNamespace = transform(
      sourceDocument('nested/path.md', markdown, 'namespace-b'),
      provenance,
    );
    expect(windowsPath.source.path).toBe('nested/path.md');
    expect(windowsPath.id).toBe(posixPath.id);
    expect(windowsPath.id).not.toBe(otherNamespace.id);
    expect(() => normalizeRelativePath('../outside.md')).toThrow(
      'cannot traverse above its root',
    );
  });

  it('preserves fenced code, filename metadata, and adjacent explanation', () => {
    const file = sourceDocument(
      'code.md',
      '# Code\n\nRun this example:\n\n```typescript filename="app.ts"\nconst app = true;\n```\n',
    );
    const document = transform(file, provenance, 80);
    const codeChunk = document.chunks.find(
      ({ codeExamples }) => codeExamples.length,
    )!;
    expect(codeChunk.markdown).toContain('Run this example:');
    expect(codeChunk.markdown).toContain('const app = true;');
    expect(codeChunk.codeExamples).toEqual([
      { language: 'typescript', filename: 'app.ts', code: 'const app = true;' },
    ]);
  });

  it('preserves oversized blocks by default and rejects them when requested', () => {
    const file = sourceDocument(
      'large.md',
      `# Large\n\n\`\`\`ts\n${'const line = true;\n'.repeat(12)}\`\`\`\n`,
    );
    const parsed = parseMarkdown(file.markdown, { path: file.path });
    const preserved = normalizeAndChunkDocument(file, provenance, parsed, {
      maxChunkChars: 40,
    });
    expect(preserved.chunks.some(({ markdown }) => markdown.length > 40)).toBe(
      true,
    );
    expect(
      preserved.chunks.map(({ markdown }) => markdown).join('\n'),
    ).toContain('const line = true;');
    expect(() =>
      normalizeAndChunkDocument(file, provenance, parsed, {
        maxChunkChars: 40,
        oversizedBlockPolicy: 'error',
      }),
    ).toThrow('exceeds maxChunkChars');
  });

  it('uses the original source hash separately from normalized content hashes', () => {
    const file = sourceDocument('hash.md', '\uFEFF# Hash\r\n\r\nText.\r\n');
    const document = transform(file, provenance);
    const rawHash = createHash('sha256').update(file.markdown).digest('hex');
    const normalizedHash = createHash('sha256')
      .update(document.markdown)
      .digest('hex');
    expect(document.source.contentHash).toBe(rawHash);
    expect(document.contentHash).toBe(normalizedHash);
    expect(document.source.contentHash).not.toBe(document.contentHash);
  });
});
