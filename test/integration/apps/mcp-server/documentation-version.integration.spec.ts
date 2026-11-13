import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { connectMcpClient } from '@nestjs/mcp/testing';
import type { Client } from '@modelcontextprotocol/client';
import { McpServerModule } from '../../../../src/apps/mcp-server/mcp-server.module.js';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { ingestNestJsDocuments } from '../../../fixtures/ingestion.fixtures.js';
import { createTestIndexManifest } from '../../../fixtures/mcp-server-index.js';

describe('documentation index selection', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'documentation-index-config-'));
  });
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('requires an explicit existing index path', () => {
    const previousPath = process.env.DOCUMENTATION_INDEX_PATH;
    delete process.env.DOCUMENTATION_INDEX_PATH;
    try {
      expect(() => McpServerModule.register()).toThrow(
        'DOCUMENTATION_INDEX_PATH is required',
      );
    } finally {
      if (previousPath !== undefined)
        process.env.DOCUMENTATION_INDEX_PATH = previousPath;
    }
  });

  it.each(['11', '12'] as const)(
    'serves a generated NestJS v%s index using its own metadata',
    async (version) => {
      const indexDirectory = join(directory, `v${version}`);
      await mkdir(indexDirectory);
      const databasePath = join(indexDirectory, 'index.sqlite');
      const manifestPath = join(indexDirectory, 'manifest.json');
      const corpus = ingestNestJsDocuments(version, [
        {
          path: 'content/startup.md',
          canonicalUrl:
            version === '11'
              ? 'https://docs.nestjs.com/v11/startup'
              : 'https://docs.nestjs.com/startup',
          markdown: `# Startup v${version}\n\nStartup fixture content.`,
        },
      ]);
      const index = new DocumentationIndexWriter(databasePath, version);
      try {
        index.indexCorpus(corpus);
      } finally {
        index.close();
      }
      await writeFile(
        manifestPath,
        `${JSON.stringify(
          createTestIndexManifest(
            databasePath,
            corpus,
            'https://github.com/nestjs/docs.nestjs.com',
          ),
          null,
          2,
        )}\n`,
      );

      const app = await NestFactory.createApplicationContext(
        McpServerModule.register(databasePath, manifestPath),
        { logger: false },
      );
      let client: Client | undefined;
      try {
        expect(app.get(DocumentationSearchService).documentation).toEqual({
          id: 'https://github.com/nestjs/docs.nestjs.com',
          version,
        });
        client = await connectMcpClient(app);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          'fetch_docs',
          'search_docs',
        ]);
        const search = await client.callTool({
          name: 'search_docs',
          arguments: { query: 'Startup fixture content' },
        });
        expect(search.isError).toBeFalsy();
        expect(search.structuredContent).toMatchObject({
          documentationId: 'https://github.com/nestjs/docs.nestjs.com',
          documentationVersion: version,
          results: [
            {
              documentId: corpus.documents[0]!.id,
              canonicalUrl:
                version === '11'
                  ? 'https://docs.nestjs.com/v11/startup#startup-v11'
                  : 'https://docs.nestjs.com/startup#startup-v12',
              sourceRevision: corpus.source.revision,
            },
          ],
        });
      } finally {
        await client?.close();
        await app.close();
      }
    },
  );

  it('rejects a manifest whose version does not match the index', async () => {
    const databasePath = join(directory, 'index.sqlite');
    const corpus = ingestNestJsDocuments('11', [
      {
        path: 'content/startup.md',
        canonicalUrl: 'https://docs.nestjs.com/v11/startup',
        markdown: '# Startup\n\nStartup fixture content.',
      },
    ]);
    const writer = new DocumentationIndexWriter(databasePath, '11');
    try {
      writer.indexCorpus(corpus);
    } finally {
      writer.close();
    }
    const manifest = createTestIndexManifest(databasePath, corpus);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        documentation: { ...manifest.documentation, version: '12' },
      }),
    );

    expect(() => McpServerModule.register(databasePath)).toThrow(
      /Index version must match/u,
    );
  });
});
