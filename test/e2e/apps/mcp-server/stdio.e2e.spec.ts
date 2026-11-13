import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpServerTestIndex } from '../../../fixtures/mcp-server-index.js';

const entryPoint = fileURLToPath(
  new URL(
    '../../../../dist/apps/mcp-server/bootstrap/stdio.js',
    import.meta.url,
  ),
);

describe('MCP stdio server', () => {
  it.each(['EOF', 'SIGINT', 'SIGTERM'] as const)(
    'shuts down on %s with only protocol messages on stdout',
    async (shutdown) => {
      const directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-mcp-stdio-'));
      const databasePath = join(directory, 'index.sqlite');
      createMcpServerTestIndex(databasePath);
      const transport = createTransport(databasePath, directory);
      const client = new Client({ name: 'lifecycle-test', version: '0.0.1' });
      const transportErrors: Error[] = [];
      let stdout = '';
      let stderr = '';
      captureStdout(transport, (chunk) => {
        stdout += chunk;
      });
      transport.onerror = (error) => transportErrors.push(error);
      transport.stderr?.on('data', (chunk: string | Buffer) => {
        stderr += chunk.toString();
      });
      const timeout = setTimeout(() => {
        const child = getChildProcess(transport);
        child?.kill('SIGKILL');
      }, 5000);
      let child: ChildProcess | undefined;
      let closed: Promise<unknown[]> | undefined;

      try {
        await withTimeout(
          client.connect(transport).catch((error: unknown) => {
            throw new Error(`stdio MCP initialize failed: ${stderr}`, {
              cause: error,
            });
          }),
          'stdio MCP initialize',
        );
        const runningChild = getChildProcess(transport);
        if (!runningChild)
          throw new Error('stdio server process did not start');
        child = runningChild;
        closed = once(runningChild, 'close');
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          'fetch_docs',
          'search_docs',
        ]);
        if (shutdown === 'EOF') {
          await client.close();
        } else {
          runningChild.kill(shutdown);
        }
        const exit = (await withTimeout(closed, 'stdio server shutdown')) as [
          number | null,
          NodeJS.Signals | null,
        ];
        expect(exit).toEqual(shutdown === 'EOF' ? [0, null] : [null, shutdown]);
        expect(transportErrors).toEqual([]);
        expect(stderr).toContain('NestFactory');
        expectProtocolStdout(stdout);
      } finally {
        clearTimeout(timeout);
        await client.close().catch(() => undefined);
        child ??= getChildProcess(transport);
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          if (closed) await closed;
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    10000,
  );

  it('writes debug timing to stderr while keeping stdout protocol-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-mcp-stdio-'));
    const databasePath = join(directory, 'index.sqlite');
    createMcpServerTestIndex(databasePath);
    const transport = createTransport(databasePath, directory, { DEBUG: '1' });
    const client = new Client({ name: 'timing-test', version: '0.0.1' });
    const transportErrors: Error[] = [];
    let stdout = '';
    let stderr = '';
    captureStdout(transport, (chunk) => {
      stdout += chunk;
    });
    transport.onerror = (error) => transportErrors.push(error);
    transport.stderr?.on('data', (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      const child = getChildProcess(transport);
      child?.kill('SIGKILL');
    }, 5000);
    let child: ChildProcess | undefined;
    let closed: Promise<unknown[]> | undefined;

    try {
      await withTimeout(
        client.connect(transport).catch((error: unknown) => {
          throw new Error(`stdio MCP initialize failed: ${stderr}`, {
            cause: error,
          });
        }),
        'stdio MCP initialize',
      );
      const runningChild = getChildProcess(transport);
      if (!runningChild) throw new Error('stdio server process did not start');
      child = runningChild;
      closed = once(runningChild, 'close');
      const result = await withTimeout(
        client.callTool({
          name: 'search_docs',
          arguments: { query: 'ExecutionContext', limit: 1 },
        }),
        'stdio MCP tool call',
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        documentationId: 'synthetic-mcp-documentation',
        documentationVersion: '12',
        results: [
          {
            sourceRevision: 'mcp-synthetic-revision',
            canonicalUrl: 'https://docs.example.test/execution-context#api',
          },
        ],
      });
      expect(JSON.stringify(result)).toContain(
        'provides execution-context details',
      );
      await client.close();
      await withTimeout(closed, 'stdio server shutdown');
      expect(transportErrors).toEqual([]);
      expect(stderr).toMatch(/MCP tool search_docs success in \d+ ms/u);
      expectProtocolStdout(stdout);
    } finally {
      clearTimeout(timeout);
      await client.close().catch(() => undefined);
      child ??= getChildProcess(transport);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        if (closed) await closed;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
});

function createTransport(
  databasePath: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    cwd,
    env: {
      ...process.env,
      DOCUMENTATION_INDEX_PATH: databasePath,
      DOCUMENTATION_INDEX_MANIFEST_PATH: join(cwd, 'manifest.json'),
      ...environment,
    },
    stderr: 'pipe',
  });
}

function getChildProcess(
  transport: StdioClientTransport,
): ChildProcess | undefined {
  return (transport as unknown as { _process?: ChildProcess })._process;
}

function captureStdout(
  transport: StdioClientTransport,
  onData: (chunk: string) => void,
): void {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    getChildProcess(transport)?.stdout?.on('data', (chunk: Buffer) => {
      onData(chunk.toString());
    });
  };
}

function expectProtocolStdout(stdout: string): void {
  const lines = stdout.trim().split('\n');
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const message = JSON.parse(line) as Record<string, unknown>;
    expect(message['jsonrpc']).toBe('2.0');
    expect(
      typeof message['method'] === 'string' ||
        typeof message['id'] === 'number' ||
        typeof message['id'] === 'string',
    ).toBe(true);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 10000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
