import {
  DocumentationCorpusSchema,
  DocumentationSnapshotSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import type { DocumentationSourceProvenance } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';

const gitSource: DocumentationSourceProvenance = {
  kind: 'git',
  repository: 'https://example.test/docs.git',
  ref: 'main',
  revision: 'a'.repeat(40),
};

const localSource: DocumentationSourceProvenance = {
  kind: 'local',
  root: '/workspace/docs',
  revision: 'local-snapshot-3',
};

function sourceDocument(
  source: DocumentationSourceProvenance,
  version = '2025.1',
) {
  return {
    id: 'guide',
    version,
    path: 'guide.md',
    canonicalUrl: 'https://docs.example.test/guide',
    sourceLocation:
      source.kind === 'git'
        ? `${source.repository}/raw/${source.revision}/guide.md`
        : `${source.root}/guide.md`,
    markdown: '# Guide\n\nSome documentation.',
  };
}

function normalizedDocument(
  source: DocumentationSourceProvenance,
  version = '2025.1',
) {
  const document = sourceDocument(source, version);
  const heading = { level: 1, title: 'Guide', slug: 'guide' };
  return {
    id: document.id,
    version: document.version,
    title: 'Guide',
    canonicalUrl: document.canonicalUrl,
    source: {
      provenance: source,
      path: document.path,
      location: document.sourceLocation,
      contentHash: 'b'.repeat(64),
    },
    markdown: document.markdown,
    contentHash: 'c'.repeat(64),
    headings: [heading],
    chunks: [
      {
        id: 'guide:chunk-0',
        documentId: document.id,
        index: 0,
        title: 'Guide',
        canonicalUrl: document.canonicalUrl,
        sourceRevision: source.revision,
        headingPath: [heading],
        markdown: 'Some documentation.',
        contentHash: 'd'.repeat(64),
        codeExamples: [],
      },
    ],
  };
}

describe('documentation persistent contracts', () => {
  it.each([gitSource, localSource])(
    'accepts a string version and %s provenance',
    (source) => {
      const document = sourceDocument(source);
      const snapshot = {
        version: '2025.1',
        source,
        documents: [document],
      };
      const corpus = {
        version: '2025.1',
        source,
        documents: [normalizedDocument(source)],
      };

      expect(DocumentationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
      expect(DocumentationCorpusSchema.parse(corpus)).toEqual(corpus);
    },
  );

  it('rejects an empty version, missing identity, and unknown source kind', () => {
    const snapshot = {
      version: '',
      source: gitSource,
      documents: [sourceDocument(gitSource)],
    };
    expect(DocumentationSnapshotSchema.safeParse(snapshot).success).toBe(false);

    const missingIdentity = sourceDocument(gitSource) as Record<
      string,
      unknown
    >;
    delete missingIdentity.id;
    expect(
      DocumentationSnapshotSchema.safeParse({
        version: '2025.1',
        source: gitSource,
        documents: [missingIdentity],
      }).success,
    ).toBe(false);

    expect(
      DocumentationSnapshotSchema.safeParse({
        version: '2025.1',
        source: { kind: 'remote', location: 'somewhere' },
        documents: [sourceDocument(gitSource)],
      }).success,
    ).toBe(false);
  });

  it('rejects corpus version, provenance, and identity relationships that disagree', () => {
    const document = normalizedDocument(gitSource);
    const base = {
      version: '2025.1',
      source: gitSource,
      documents: [document],
    };

    expect(
      DocumentationCorpusSchema.safeParse({ ...base, version: '2024.2' })
        .success,
    ).toBe(false);
    expect(
      DocumentationCorpusSchema.safeParse({
        ...base,
        source: { ...gitSource, revision: 'b'.repeat(40) },
      }).success,
    ).toBe(false);
    expect(
      DocumentationCorpusSchema.safeParse({
        ...base,
        documents: [
          {
            ...document,
            chunks: [{ ...document.chunks[0], documentId: 'another-document' }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      DocumentationCorpusSchema.safeParse({
        ...base,
        documents: [{ ...document, version: '2024.2' }],
      }).success,
    ).toBe(false);
  });
});
