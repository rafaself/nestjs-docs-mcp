import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Client } from '@modelcontextprotocol/client';
import { connectMcpClient } from '@nestjs/mcp/testing';
import { AppModule } from '../../src/app.module.js';
import { ingestSnapshot } from '../../src/ingestion/pipeline.js';
import { DocumentationSearchService } from '../../src/search/search.service.js';
import { loadSearchCorpus } from '../fixtures/search.fixtures.js';

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

    const index = new DocumentationSearchService(databasePath, 12);
    const longCorpus = ingestSnapshot({
      version: 12,
      ref: 'master',
      revision: corpus.source.revision,
      documents: [
        {
          path: 'content/long.md',
          canonicalUrl: 'https://docs.nestjs.com/long',
          markdown: `# Long page\n\n## Streaming\n\n${'streaming 🌍 '.repeat(2000)}\n\n## Last section\n\nlate-marker`,
        },
      ],
    });
    index.indexCorpus({
      ...corpus,
      documents: [...corpus.documents, ...longCorpus.documents],
    });
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
        documentId: {
          type: 'string',
          pattern: '^nestjs-doc:v(?:11|12):[0-9a-f]{64}$',
        },
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
    expect(text).toContain('Section ID:');
    expect(text).toContain('Source revision:');
    const sectionId = /Section ID: ([^\n]+)/u.exec(text)?.[1];
    const fetched = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId, sectionId },
    });
    expect(resultText(fetched.content)).toContain('ExecutionContext');
    expect(fetched.structuredContent).toMatchObject({
      found: true,
      truncated: false,
      sectionId,
      documentationVersion: 12,
    });
    expect(result.structuredContent).toMatchObject({
      documentationVersion: 12,
      results: [{ chunkId: sectionId, documentId }],
    });
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

  it('returns structured continuation and fetches a later section from a search hit', async () => {
    const search = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'late-marker' },
    });
    const data = search.structuredContent as {
      results: { documentId: string; chunkId: string }[];
    };
    const hit = data.results[0]!;
    const target = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId: hit.documentId, sectionId: hit.chunkId },
    });
    expect(target.structuredContent).toMatchObject({
      found: true,
      truncated: false,
    });
    expect(resultText(target.content)).toContain('late-marker');
    const first = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId: hit.documentId },
    });
    const page = first.structuredContent as {
      truncated: boolean;
      nextCursor: string;
    };
    expect(page.truncated).toBe(true);
    const next = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId: hit.documentId, cursor: page.nextCursor },
    });
    expect(next.isError).toBeFalsy();
    expect(next.structuredContent).toMatchObject({
      documentId: hit.documentId,
      found: true,
    });
    const wrong = await client.callTool({
      name: 'fetch_docs',
      arguments: {
        documentId: hit.documentId,
        sectionId: hit.chunkId,
        cursor: page.nextCursor,
      },
    });
    expect(wrong.isError).toBe(true);
  });

  it('returns structured empty results for missing queries and documents', async () => {
    const search = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'termnotpresentanywhere' },
    });
    expect(search.isError).toBeFalsy();
    expect(search.structuredContent).toEqual({
      documentationVersion: 12,
      results: [],
    });
    const missing = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId: `nestjs-doc:v12:${'0'.repeat(64)}` },
    });
    expect(missing.isError).toBeFalsy();
    expect(missing.structuredContent).toMatchObject({
      found: false,
      sections: [],
      nextCursor: null,
      truncated: false,
    });
  });

  it('rejects a malformed cursor and returns no section for an unrelated section ID', async () => {
    const malformed = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId, cursor: 'invalid' },
    });
    expect(malformed.isError).toBe(true);
    expect(resultText(malformed.content)).toContain('Input validation error');
    const search = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'late-marker', limit: 1 },
    });
    const result = search.structuredContent as {
      results: { chunkId: string }[];
    };
    const otherSection = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId, sectionId: result.results[0]!.chunkId },
    });
    expect(otherSection.isError).toBeFalsy();
    expect(otherSection.structuredContent).toMatchObject({
      found: false,
      sections: [],
    });
  });

  it('rejects document IDs from another configured major', async () => {
    const result = await client.callTool({
      name: 'fetch_docs',
      arguments: { documentId: `nestjs-doc:v11:${'0'.repeat(64)}` },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result.content)).toContain('configured for v12');
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
