import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverLocalDocumentation } from '@nestjs-docs/documentation-engine/infrastructure/filesystem/documentation-discovery.js';

describe('local documentation discovery', () => {
  let roots: string[];
  let root: string;

  beforeEach(async () => {
    roots = [];
    root = await makeTemporaryRoot(roots);
  });

  afterEach(async () => {
    await Promise.all(
      roots.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('returns a repeatable, sorted snapshot filtered by relative-path globs', async () => {
    await writeMarkdown(root, 'z-overview.md', '# Z');
    await writeMarkdown(root, 'guide/index.mdx', '# Index');
    await writeMarkdown(root, 'guide/api/reference.md', '# API');
    await writeMarkdown(root, 'guide/draft.md', '# Draft');
    await writeMarkdown(root, '.git/content.md', '# Git metadata');
    await writeMarkdown(root, 'node_modules/pkg/content.mdx', '# Dependency');
    await writeMarkdown(root, 'assets/example.txt', 'not documentation');

    const defaults = await discoverLocalDocumentation({
      root,
      version: '2026.1',
    });
    const options = {
      root,
      version: '2026.1',
      include: ['guide/**'],
      exclude: ['**/draft.md'],
    };
    const first = await discoverLocalDocumentation(options);
    const second = await discoverLocalDocumentation(options);

    expect(first.documents.map((document) => document.path)).toEqual([
      'guide/api/reference.md',
      'guide/index.mdx',
    ]);
    expect(defaults.documents.map((document) => document.path)).toEqual([
      'guide/api/reference.md',
      'guide/draft.md',
      'guide/index.mdx',
      'z-overview.md',
    ]);
    expect(first).toEqual(second);
    expect(first.source).toMatchObject({ kind: 'local', root });
    expect(first.source.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.documents[0]).toMatchObject({
      id: 'guide/api/reference.md',
      version: '2026.1',
      markdown: '# API',
    });
  });

  it('uses Markdown defaults and skips symlinks unless following is enabled', async () => {
    await writeMarkdown(root, 'guide.md', '# Guide');
    const outside = await makeTemporaryRoot(roots);
    const outsideFile = await writeMarkdown(outside, 'secret.md', '# Secret');
    await symlink(join(root, 'guide.md'), join(root, 'guide-link.md'));
    await symlink(outsideFile, join(root, 'outside-link.md'));

    const snapshot = await discoverLocalDocumentation({
      root,
      version: 'local',
    });

    expect(snapshot.documents.map((document) => document.path)).toEqual([
      'guide.md',
    ]);
  });

  it('follows in-root symlinks without recursing through directory cycles', async () => {
    await writeMarkdown(root, 'store/body.txt', '# Local content');
    await mkdir(join(root, 'nested'), { recursive: true });
    await symlink(join(root, 'store/body.txt'), join(root, 'guide.md'));
    await symlink(root, join(root, 'nested/up'));

    const snapshot = await discoverLocalDocumentation({
      root,
      version: 'local',
      followSymlinks: true,
    });

    expect(snapshot.documents.map((document) => document.path)).toEqual([
      'guide.md',
    ]);
    expect(snapshot.documents[0]?.markdown).toBe('# Local content');
  });

  it('rejects followed symlinks that resolve outside the configured root', async () => {
    const outside = await makeTemporaryRoot(roots);
    const outsideFile = await writeMarkdown(outside, 'secret.md', '# Secret');
    await symlink(outsideFile, join(root, 'external.md'));

    await expect(
      discoverLocalDocumentation({
        root,
        version: 'local',
        followSymlinks: true,
      }),
    ).rejects.toThrow('resolves outside configured root');
  });

  it('rejects duplicate physical files reached through different paths', async () => {
    await writeMarkdown(root, 'guide.md', '# Guide');
    await symlink(join(root, 'guide.md'), join(root, 'guide-alias.md'));

    await expect(
      discoverLocalDocumentation({
        root,
        version: 'local',
        followSymlinks: true,
      }),
    ).rejects.toThrow('Duplicate documentation file target');
  });

  it('reports empty directories and invalid roots explicitly', async () => {
    await expect(
      discoverLocalDocumentation({ root, version: 'local' }),
    ).rejects.toThrow('No Markdown or MDX files found');

    await expect(
      discoverLocalDocumentation({
        root: join(root, 'missing'),
        version: 'local',
      }),
    ).rejects.toThrow('Unable to resolve documentation root');

    const file = await writeMarkdown(root, 'file.md', '# File');
    await expect(
      discoverLocalDocumentation({ root: file, version: 'local' }),
    ).rejects.toThrow('Documentation root is not a directory');
  });

  it('rejects invalid patterns and limits', async () => {
    await writeMarkdown(root, 'guide.md', '# Guide');
    await writeMarkdown(root, 'reference.md', '# Reference');

    await expect(
      discoverLocalDocumentation({
        root,
        version: 'local',
        include: ['../**/*.md'],
      }),
    ).rejects.toThrow('Patterns must be relative');
    await expect(
      discoverLocalDocumentation({ root: ' ', version: 'local' }),
    ).rejects.toThrow();
    await expect(
      discoverLocalDocumentation({ root, version: 'local', maxFiles: 0 }),
    ).rejects.toThrow();
    await expect(
      discoverLocalDocumentation({ root, version: 'local', maxFiles: 1 }),
    ).rejects.toThrow('exceeds maxFiles');
    await expect(
      discoverLocalDocumentation({ root, version: 'local', maxFileBytes: 2 }),
    ).rejects.toThrow('exceeds maxFileBytes');
    await expect(
      discoverLocalDocumentation({ root, version: 'local', maxTotalBytes: 2 }),
    ).rejects.toThrow('exceeds maxTotalBytes');
  });

  it('enforces traversal depth and entry limits', async () => {
    await writeMarkdown(root, 'nested/guide.md', '# Guide');

    await expect(
      discoverLocalDocumentation({ root, version: 'local', maxDepth: 0 }),
    ).rejects.toThrow('exceeds maxDepth');
    await expect(
      discoverLocalDocumentation({ root, version: 'local', maxEntries: 1 }),
    ).rejects.toThrow('exceeds maxEntries');
  });

  const permissionTestsSupported =
    process.platform !== 'win32' && process.getuid?.() !== 0;
  (permissionTestsSupported ? it : it.skip)(
    'reports unreadable files with their portable path',
    async () => {
      const file = await writeMarkdown(root, 'private.md', '# Private');
      await chmod(file, 0);
      try {
        await expect(
          discoverLocalDocumentation({ root, version: 'local' }),
        ).rejects.toThrow('Unable to read documentation file "private.md"');
      } finally {
        await chmod(file, 0o600);
      }
    },
  );
});

async function makeTemporaryRoot(roots: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'documentation-discovery-'));
  roots.push(directory);
  return directory;
}

async function writeMarkdown(
  directory: string,
  path: string,
  markdown: string,
): Promise<string> {
  const file = join(directory, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, markdown, 'utf8');
  return file;
}
