import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_DESCRIPTION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from '../../../../src/shared/config/package-metadata.js';

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
          result: {
            serverInfo: {
              name: PACKAGE_NAME,
              version: PACKAGE_VERSION,
              description: PACKAGE_DESCRIPTION,
            },
          },
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

  it('writes debug timing to stderr while keeping stdout protocol-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-mcp-stdio-'));
    const inputPath = join(directory, 'input.jsonl');
    const stdoutPath = join(directory, 'stdout.jsonl');
    const stderrPath = join(directory, 'stderr.log');
    writeFileSync(
      inputPath,
      [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'timing-test', version: '0.0.1' },
          },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_docs',
            arguments: { query: 'ExecutionContext', limit: 1 },
          },
        }),
      ].join('\n') + '\n',
    );

    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<readonly unknown[]> | undefined;
    let timeout: NodeJS.Timeout | undefined;

    try {
      const inputDescriptor = openSync(inputPath, 'r');
      const stdoutDescriptor = openSync(stdoutPath, 'w');
      const stderrDescriptor = openSync(stderrPath, 'w');
      try {
        child = spawn(process.execPath, [entryPoint], {
          env: { ...process.env, DEBUG: '1' },
          stdio: [inputDescriptor, stdoutDescriptor, stderrDescriptor],
        });
      } finally {
        closeSync(inputDescriptor);
        closeSync(stdoutDescriptor);
        closeSync(stderrDescriptor);
      }

      closed = once(child, 'close');
      timeout = setTimeout(() => child?.kill('SIGKILL'), 5000);
      const exit: readonly unknown[] = await closed;
      expect(exit).toEqual([0, null]);

      const stdout = readFileSync(stdoutPath, 'utf8');
      const stderr = readFileSync(stderrPath, 'utf8');
      const messages = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ jsonrpc: '2.0', id: 1 });
      expect(messages[0]).toMatchObject({
        result: {
          serverInfo: {
            name: PACKAGE_NAME,
            version: PACKAGE_VERSION,
            description: PACKAGE_DESCRIPTION,
          },
        },
      });
      expect(messages[1]).toMatchObject({ jsonrpc: '2.0', id: 2 });
      expect(messages[1]?.['result']).toHaveProperty('content');
      expect(stderr).toMatch(/MCP tool search_docs success in \d+ ms/u);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        if (closed) await closed;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
});
