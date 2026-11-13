import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entryPoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));

describe('MCP stdio server', () => {
  it('discovers and invokes ping through an MCP client', async () => {
    const client = new Client({
      name: 'stdio-integration-test',
      version: '0.0.1',
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPoint],
      stderr: 'pipe',
    });
    const protocolErrors: Error[] = [];
    client.onerror = (error) => protocolErrors.push(error);
    // Drain diagnostics separately; stdout must contain only MCP messages.
    transport.stderr?.on('data', () => undefined);

    try {
      await client.connect(transport, { timeout: 5000 });
      expect(client.getServerVersion()).toMatchObject({
        name: 'nestjs-docs-mcp',
        version: '0.0.1',
      });

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['ping']);
      expect(tools[0]).toMatchObject({
        name: 'ping',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      });

      const result = await client.callTool({ name: 'ping', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    } finally {
      await client.close();
    }
    expect(protocolErrors).toEqual([]);
  });

  it.each(['EOF', 'SIGINT', 'SIGTERM'] as const)(
    'shuts down on %s with only protocol messages on stdout',
    async (shutdown) => {
      const child = spawn(process.execPath, [entryPoint], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const lines = createInterface({ input: child.stdout });
      const initialized = once(lines, 'line');

      try {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'lifecycle-test', version: '0.0.1' },
            },
          }) + '\n',
        );
        await Promise.race([
          initialized,
          closed.then(() => {
            throw new Error(`Server exited before initialization: ${stderr}`);
          }),
        ]);

        if (shutdown === 'EOF') {
          child.stdin.end();
        } else {
          child.kill(shutdown);
        }
        const exit: readonly unknown[] = await closed;
        expect(exit).toEqual(shutdown === 'EOF' ? [0, null] : [null, shutdown]);

        // Parse the complete raw stream so even one non-protocol log fails.
        const messages: unknown[] = stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'nestjs-docs-mcp' } },
        });
        expect(stderr).toContain('NestFactory');
      } finally {
        clearTimeout(timeout);
        lines.close();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await closed;
        }
      }
    },
    10000,
  );
});
