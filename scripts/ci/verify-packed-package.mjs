import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../../', import.meta.url));
const versions = [11, 12];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal})\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function withoutNpmDryRun(environment) {
  const clean = { ...environment };
  delete clean.npm_config_dry_run;
  delete clean.NPM_CONFIG_DRY_RUN;
  return clean;
}

async function withTimeout(promise, label, milliseconds = 30_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyVersion(project, version) {
  const binary = join(project, 'node_modules', '.bin', 'nestjs-docs-mcp');
  const transport = new StdioClientTransport({
    command: binary,
    cwd: project,
    env: {
      PATH: process.env.PATH ?? '',
      NESTJS_VERSION: String(version),
      ...(process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    },
    stderr: 'pipe',
  });
  const transportErrors = [];
  const stderr = [];
  transport.onerror = (error) => transportErrors.push(error);
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
  const client = new Client({
    name: 'nestjs-docs-package-smoke',
    version: '1.0.0',
  });
  let child;
  try {
    await withTimeout(
      client.connect(transport),
      `NestJS v${version} initialize`,
    );
    child = transport._process;
    assert.ok(transport.pid, `NestJS v${version} executable did not start`);

    const tools = await withTimeout(
      client.listTools(),
      `NestJS v${version} listTools`,
    );
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['fetch_docs', 'search_docs'],
      'the installed server must expose both documentation tools',
    );

    const search = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: { query: 'ExecutionContext', limit: 3 },
      }),
      `NestJS v${version} search_docs`,
    );
    assert.ok(!search.isError, 'search_docs should succeed');
    const searchData = search.structuredContent;
    assert.equal(searchData.documentationVersion, version);
    assert.ok(
      searchData.results.length > 0,
      'the packaged index should return documentation',
    );
    const hit = searchData.results[0];
    assert.match(hit.documentId, new RegExp(`^nestjs-doc:v${version}:`));
    assert.match(hit.sourceRevision, /^[a-f0-9]{40}$/u);
    assert.match(hit.canonicalUrl, /^https:\/\/docs\.nestjs\.com\//u);
    if (version === 11)
      assert.match(hit.canonicalUrl, /^https:\/\/docs\.nestjs\.com\/v11\//u);
    else assert.doesNotMatch(hit.canonicalUrl, /\/v11(?:\/|#|$)/u);

    const fetched = await withTimeout(
      client.callTool({
        name: 'fetch_docs',
        arguments: { documentId: hit.documentId, sectionId: hit.chunkId },
      }),
      `NestJS v${version} fetch_docs`,
    );
    assert.ok(!fetched.isError, 'fetch_docs should succeed');
    const document = fetched.structuredContent;
    assert.equal(document.documentationVersion, version);
    assert.equal(document.found, true);
    assert.equal(document.sourceRevision, hit.sourceRevision);
    assert.ok(
      document.sections.some((section) =>
        section.markdown.includes('ExecutionContext'),
      ),
    );
    assert.ok(
      document.sections.every((section) =>
        section.canonicalUrl.startsWith('https://docs.nestjs.com/'),
      ),
    );

    assert.deepEqual(
      transportErrors,
      [],
      'stdout must contain only valid MCP protocol messages',
    );
    await client.close();
    await withTimeout(
      waitForClose(child),
      `NestJS v${version} graceful shutdown`,
    );
    assert.equal(
      child.exitCode,
      0,
      'the installed process should exit cleanly after stdin closes',
    );
    assert.equal(child.signalCode, null);
    assert.match(
      stderr.join(''),
      /NestFactory/u,
      'application logs should be written to stderr',
    );
    console.log(`Verified installed NestJS v${version} MCP server`);
  } finally {
    child ??= transport._process;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForClose(child);
    }
    await client.close().catch(() => {});
  }
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolveClose) => child.once('close', resolveClose));
}

async function main() {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'nestjs-docs-packed-package-'),
  );
  try {
    const packDirectory = join(temporaryDirectory, 'packed');
    const project = join(temporaryDirectory, 'isolated-project');
    await Promise.all([mkdir(packDirectory), mkdir(project)]);

    const packed = JSON.parse(
      run(
        'npm',
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          packDirectory,
        ],
        { env: withoutNpmDryRun(process.env) },
      ),
    );
    assert.equal(packed.length, 1, 'npm pack should produce one tarball');
    const files = new Set(packed[0].files.map((file) => file.path));
    for (const path of [
      'data/documentation-v11.sqlite',
      'data/documentation-v12.sqlite',
      'data/manifest.json',
    ]) {
      assert.ok(files.has(path), `the npm tarball must include ${path}`);
    }
    for (const version of versions) {
      assert.ok(
        !files.has(`data/documentation-v${version}.json`),
        'the npm tarball should omit corpus files after validating them during prepack',
      );
    }
    const tarballPath = resolve(packDirectory, packed[0].filename);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'nestjs-docs-mcp-package-smoke',
        version: '1.0.0',
        private: true,
      }),
    );
    run(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--no-save',
        '--package-lock=false',
        tarballPath,
      ],
      { cwd: project, env: withoutNpmDryRun(process.env) },
    );

    const installedPackage = join(project, 'node_modules', 'nestjs-docs-mcp');
    for (const version of versions) {
      const index = join(
        installedPackage,
        'data',
        `documentation-v${version}.sqlite`,
      );
      await readFile(index);
    }
    for (const developmentOnlyPackage of [
      'typescript',
      'jest',
      '@nestjs/cli',
    ]) {
      try {
        await readFile(
          join(project, 'node_modules', developmentOnlyPackage, 'package.json'),
        );
        throw new Error(
          `${developmentOnlyPackage} was installed in the production-only project`,
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    for (const version of versions) await verifyVersion(project, version);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
