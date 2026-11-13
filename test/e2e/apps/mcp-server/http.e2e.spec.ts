import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServerTestIndex } from '../../../fixtures/mcp-server-index.js';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const entryPoint = fileURLToPath(
  new URL(
    '../../../../dist/apps/mcp-server/bootstrap/http.js',
    import.meta.url,
  ),
);

describe('MCP HTTP server', () => {
  it('serves the documentation MCP over HTTP and shuts down cleanly', async () => {
    const port = await reservePort();
    const directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-mcp-http-'));
    const databasePath = join(directory, 'index.sqlite');
    createMcpServerTestIndex(databasePath);
    const child = spawn(process.execPath, [entryPoint], {
      env: {
        ...process.env,
        PORT: String(port),
        DOCUMENTATION_INDEX_PATH: databasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = once(child, 'close');
    const client = new Client({
      name: 'nestjs-docs-http-e2e',
      version: '0.0.1',
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );

    try {
      await waitForPort(port, child, () => stderr);
      await withTimeout(client.connect(transport), 'HTTP MCP initialize');
      const tools = await withTimeout(client.listTools(), 'HTTP MCP listTools');
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'fetch_docs',
        'search_docs',
      ]);

      const result = await withTimeout(
        client.callTool({
          name: 'search_docs',
          arguments: { query: 'ExecutionContext', limit: 1 },
        }),
        'HTTP MCP documentation search',
      );
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain('execution-context');
    } finally {
      await client.close().catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await withTimeout(closed, 'HTTP server shutdown');
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not reserve a local HTTP test port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForPort(
  port: number,
  child: ReturnType<typeof spawn>,
  readStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`HTTP server exited before listening: ${readStderr()}`);
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP server did not listen: ${readStderr()}`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 10_000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
