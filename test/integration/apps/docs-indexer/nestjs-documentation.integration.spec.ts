import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNestJsDocumentationSet } from '@nestjs-docs/docs-indexer/integrations/nestjs/documentation.integration.js';
import { DocumentationBuildManifestSchema } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import { SUPPORTED_DOCUMENTATION_VERSIONS } from '../../../../apps/docs-indexer/src/integrations/nestjs/version/documentation-version.js';
import { sourceUrl } from '../../../../apps/docs-indexer/src/integrations/nestjs/github/documentation-source.js';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';
import { loadIngestionFixtures } from '../../../fixtures/ingestion.fixtures.js';

describe('NestJS documentation source integration', () => {
  let workspace: string;
  let fixtureData: Awaited<ReturnType<typeof loadIngestionFixtures>>;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'nestjs-source-build-'));
    fixtureData = await loadIngestionFixtures();
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('builds validated corpus, indexes, and exact-revision manifests for v11 and v12', async () => {
    const outputDirectory = join(workspace, 'official-docs');
    const revision11 = 'b'.repeat(40);
    const revision12 = 'c'.repeat(40);
    const treeRevision = 'd'.repeat(40);
    const historicalPaths = [
      'content/introduction.md',
      'content/components.md',
    ];
    const contentByPath = new Map(
      fixtureData.snapshot.documents.map((document) => [
        document.path,
        document.markdown,
      ]),
    );
    const revisions = [revision12, revision11];
    const fetcher: typeof fetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/commits/master')) {
        return Promise.resolve(Response.json({ sha: revision12 }));
      }
      if (url.endsWith('/commits/11.0.0')) {
        return Promise.resolve(Response.json({ sha: revision11 }));
      }
      if (url.endsWith(`/commits/${revision11}`)) {
        return Promise.resolve(
          Response.json({ commit: { tree: { sha: treeRevision } } }),
        );
      }
      if (url.endsWith(`/git/trees/${treeRevision}?recursive=1`)) {
        return Promise.resolve(
          Response.json({
            tree: historicalPaths.map((path) => ({ path, type: 'blob' })),
          }),
        );
      }
      if (url === sourceUrl(revision12, 'src/app/shared/nav/nav-items.ts')) {
        return Promise.resolve(new Response(fixtureData.index));
      }
      if (url === sourceUrl(revision12, 'tools/generate-llms-txt.ts')) {
        return Promise.resolve(new Response(fixtureData.aliases));
      }
      for (const revision of revisions) {
        const prefix = sourceUrl(revision, '');
        if (url.startsWith(prefix)) {
          const path = url.slice(prefix.length);
          const body = contentByPath.get(path);
          return Promise.resolve(
            new Response(body ?? 'Missing fixture', {
              status: body ? 200 : 404,
            }),
          );
        }
      }
      return Promise.resolve(
        new Response('Unexpected fixture request', { status: 404 }),
      );
    };

    const summary = await buildNestJsDocumentationSet(outputDirectory, fetcher);
    expect(summary.versions.map(({ version }) => version)).toEqual(
      SUPPORTED_DOCUMENTATION_VERSIONS,
    );

    for (const version of SUPPORTED_DOCUMENTATION_VERSIONS) {
      const versionDirectory = join(outputDirectory, `v${version}`);
      const corpus = JSON.parse(
        await readFile(join(versionDirectory, 'corpus.json'), 'utf8'),
      ) as {
        version: string;
        source: { kind: string; revision: string; ref?: string };
        documents: Array<{
          id: string;
          canonicalUrl: string;
          chunks: Array<{ sourceRevision: string }>;
        }>;
      };
      const manifest = DocumentationBuildManifestSchema.parse(
        JSON.parse(
          await readFile(join(versionDirectory, 'manifest.json'), 'utf8'),
        ),
      );
      const expectedRevision = version === '11' ? revision11 : revision12;
      expect(corpus).toMatchObject({
        version,
        source: {
          kind: 'git',
          revision: expectedRevision,
        },
      });
      expect(corpus.documents.length).toBeGreaterThan(0);
      expect(
        corpus.documents.every((document) =>
          document.chunks.every(
            (chunk) => chunk.sourceRevision === expectedRevision,
          ),
        ),
      ).toBe(true);
      expect(manifest).toMatchObject({
        documentation: {
          id: 'https://github.com/nestjs/docs.nestjs.com',
          version,
        },
        source: { kind: 'git', revision: expectedRevision },
        index: {
          documentationVersion: version,
          sourceRevision: expectedRevision,
          documentCount: corpus.documents.length,
        },
      });
      expect(manifest.index.sha256).toBe(
        createHash('sha256')
          .update(await readFile(join(versionDirectory, 'index.sqlite')))
          .digest('hex'),
      );

      const search = new TestDocumentationSearchService(
        join(versionDirectory, 'index.sqlite'),
        version,
      );
      try {
        const result = search.search('providers')[0];
        expect(result?.canonicalUrl).toContain(
          version === '11' ? '/v11/providers' : '/providers',
        );
        expect(result?.sourceRevision).toBe(expectedRevision);
      } finally {
        search.onModuleDestroy();
      }
    }

    const repeatedBuild = await buildNestJsDocumentationSet(
      outputDirectory,
      fetcher,
    );
    expect(
      repeatedBuild.versions.map(({ version, documentCount, changes }) => ({
        version,
        changes,
        expectedUnchanged: documentCount,
      })),
    ).toEqual(
      summary.versions.map(({ version, documentCount }) => ({
        version,
        changes: {
          added: 0,
          modified: 0,
          unchanged: documentCount,
          removed: 0,
        },
        expectedUnchanged: documentCount,
      })),
    );

    const previousFiles = await readBuildFiles(outputDirectory);
    await expect(
      buildNestJsDocumentationSet(outputDirectory, () =>
        Promise.resolve(new Response('Unavailable', { status: 503 })),
      ),
    ).rejects.toThrow('Download failed (503)');
    expect(await readBuildFiles(outputDirectory)).toEqual(previousFiles);
  });

  async function readBuildFiles(directory: string): Promise<Buffer[]> {
    const files: Buffer[] = [];
    for (const version of SUPPORTED_DOCUMENTATION_VERSIONS) {
      const versionDirectory = join(directory, `v${version}`);
      for (const filename of ['corpus.json', 'index.sqlite', 'manifest.json']) {
        files.push(await readFile(join(versionDirectory, filename)));
      }
    }
    return files;
  }
});
