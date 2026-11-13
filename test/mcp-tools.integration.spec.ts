import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Client } from '@modelcontextprotocol/client';
import { connectMcpClient } from '@nestjs/mcp/testing';
import { AppModule } from '../src/app.module.js';
import { DocumentationSearchService } from '../src/search/search.service.js';
import { loadSearchCorpus } from './search.fixtures.js';

describe('documentation MCP tools', () => {
  let directory: string;
  let app: INestApplicationContext;
  let client: Client;
  let documentId = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-mcp-tools-'));
    const databasePath = join(directory, 'search.sqlite');
    const corpus = await loadSearchCorpus();
    documentId = corpus.documents[0]!.id;

    const index = new DocumentationSearchService(databasePath);
    index.indexCorpus(corpus);
    index.onModuleDestroy();

    app = await NestFactory.createApplicationContext(
      AppModule.register(databasePath),
      { logger: false },
    );
    client = await connectMcpClient(app);
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('discovers the two read-only tools with validated input schemas', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'search_docs',
      'fetch_docs',
    ]);
    expect(tools.map((tool) => tool.annotations?.readOnlyHint)).toEqual([
      true,
      true,
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', maximum: 10 },
      },
    });
    expect(tools[1]?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        documentId: { type: 'string', pattern: '^nestjs-doc:[0-9a-f]{64}$' },
      },
    });
  });

  it('searches documentation and returns an official source URL', async () => {
    const result = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'ExecutionContext', limit: 1 },
    });
    const text = resultText(result.content);

    expect(result.isError).toBeFalsy();
    expect(text).toContain('Authorization guards');
    expect(text).toContain(documentId);
    expect(text).toContain(
      'https://docs.nestjs.com/guards#inspecting-request-context',
    );
    expect(text).toContain('ExecutionContext');
  });

  it('fetches section-aware documentation by deterministic ID', async () => {
    const result = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId },
    });
    const text = resultText(result.content);

    expect(result.isError).toBeFalsy();
    expect(text).toContain('Authorization guards');
    expect(text).toContain('Document ID: ' + documentId);
    expect(text).toContain(
      'Source: https://docs.nestjs.com/guards#inspecting-request-context',
    );
    expect(text).toContain('@Injectable()');
    expect(text).toContain('ExecutionContext');
  });

  it.each([
    { name: 'empty query', tool: 'search_docs', arguments: { query: '  ' } },
    {
      name: 'excessive result limit',
      tool: 'search_docs',
      arguments: { query: 'guard', limit: 11 },
    },
    {
      name: 'version argument',
      tool: 'search_docs',
      arguments: { query: 'guard', version: 'latest' },
    },
    {
      name: 'invalid document ID',
      tool: 'fetch_docs',
      arguments: { documentId: 'not-a-document-id' },
    },
    {
      name: 'fetch version argument',
      tool: 'fetch_docs',
      arguments: { documentId, version: 'latest' },
    },
  ])(
    'rejects $name before invoking a tool handler',
    async ({ tool, arguments: args }) => {
      const result = await client.callTool({ name: tool, arguments: args });

      expect(result.isError).toBe(true);
      expect(resultText(result.content)).toContain('Input validation error');
    },
  );
});

function resultText(
  content: readonly { type: string; text?: string }[],
): string {
  const block = content.find((item) => item.type === 'text');
  if (!block?.text) throw new Error('MCP tool returned no text content');
  return block.text;
}
