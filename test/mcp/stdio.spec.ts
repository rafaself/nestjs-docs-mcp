import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const entryPoint = fileURLToPath(
  new URL('../../dist/main.js', import.meta.url),
);

describe('MCP stdio server', () => {
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
