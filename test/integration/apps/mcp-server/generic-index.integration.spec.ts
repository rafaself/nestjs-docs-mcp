import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Client } from '@modelcontextprotocol/client';
import { connectMcpClient } from '@nestjs/mcp/testing';
import { McpServerModule } from '../../../../src/apps/mcp-server/mcp-server.module.js';
import { createMcpServerTestIndex } from '../../../fixtures/mcp-server-index.js';

describe('source-independent MCP index serving', () => {
  let directory: string;
  let app: INestApplicationContext;
  let client: Client;
  let documentId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'generic-documentation-mcp-'));
    const databasePath = join(directory, 'index.sqlite');
    const corpus = createMcpServerTestIndex(databasePath, 'candidate-3');
    documentId = corpus.documents[0]!.id;
    app = await NestFactory.createApplicationContext(
      McpServerModule.register(databasePath),
      { logger: false },
    );
    client = await connectMcpClient(app);
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('discovers tools and searches/fetches a generic index with string metadata', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'fetch_docs',
      'search_docs',
    ]);

    const search = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'ExecutionContext' },
    });
    expect(search.isError).toBeFalsy();
    expect(search.structuredContent).toMatchObject({
      documentationId: 'synthetic-mcp-documentation',
      documentationVersion: 'candidate-3',
      results: [
        {
          documentId,
          canonicalUrl: 'https://docs.example.test/execution-context#api',
          sourceRevision: 'mcp-synthetic-revision',
        },
      ],
    });

    const hit = (
      search.structuredContent as {
        results: { documentId: string; chunkId: string }[];
      }
    ).results[0]!;
    const fetched = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId: hit.documentId, sectionId: hit.chunkId },
    });
    expect(fetched.isError).toBeFalsy();
    expect(fetched.structuredContent).toMatchObject({
      documentationId: 'synthetic-mcp-documentation',
      documentationVersion: 'candidate-3',
      documentId,
      sourceRevision: 'mcp-synthetic-revision',
      found: true,
    });
    expect(JSON.stringify(fetched.structuredContent)).toContain(
      'ExecutionContext provides execution-context details',
    );
  });
});
