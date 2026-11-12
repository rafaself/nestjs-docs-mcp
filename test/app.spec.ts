import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { connectMcpClient } from '@nestjs/mcp/testing';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';

describe('NestJS MCP application', () => {
  let app: INestApplication;
  let client: Awaited<ReturnType<typeof connectMcpClient>>;
  let url: URL;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    client = await connectMcpClient(app);
    await app.listen(0, '127.0.0.1');
    url = new URL('/mcp', await app.getUrl());
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  it('identifies the MCP server', () => {
    expect(client.getServerVersion()).toMatchObject({
      name: 'nestjs-docs-mcp',
      version: '0.0.1',
    });
  });

  it('starts without registering tools', async () => {
    await expect(client.listTools()).resolves.toMatchObject({ tools: [] });
  });

  it('serves the MCP endpoint over HTTP', async () => {
    const httpClient = new Client({
      name: 'http-smoke-test',
      version: '0.0.1',
    });
    try {
      await httpClient.connect(new StreamableHTTPClientTransport(url));
      expect(httpClient.getServerVersion()).toMatchObject({
        name: 'nestjs-docs-mcp',
        version: '0.0.1',
      });
    } finally {
      await httpClient.close();
    }
  });
});
