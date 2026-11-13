import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';
import { DocumentationBuildManifestSchema } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import { MARKDOWN_PARSER_VERSION } from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';

describe('local documentation build command', () => {
  let workspace: string;
  let inputDirectory: string;
  let outputDirectory: string;
  let configPath: string;
  const cliPath = resolve('apps/docs-indexer/dist/cli.js');

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'local-docs-build-'));
    inputDirectory = join(workspace, 'docs');
    outputDirectory = join(workspace, 'generated');
    configPath = join(workspace, 'documentation.config.json');
    mkdirSync(join(inputDirectory, 'reference'), { recursive: true });
    mkdirSync(join(inputDirectory, 'drafts'), { recursive: true });
    writeFileSync(
      join(inputDirectory, 'index.md'),
      [
        '---',
        'title: Local Handbook',
        '---',
        '',
        '# Local Handbook',
        '',
        'Queue orchestration preserves ember tokens across retries.',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(inputDirectory, 'reference', 'guide.mdx'),
      [
        '# Reference Guide',
        '',
        '<Callout title="Static context">',
        'Velvet compass documents dependency injection context.',
        '</Callout>',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(inputDirectory, 'drafts', 'private.md'),
      '# Draft\n\nHidden amber phrase.\n',
    );
    writeConfiguration({
      id: 'local-handbook',
      version: 'candidate-3',
      inputDirectory: './docs',
      discovery: { exclude: ['**/drafts/**'] },
      routeMapping: {
        baseUrl: 'https://manual.example.test',
        pathPrefix: 'guide',
      },
      outputDirectory: './generated',
    });
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('builds, validates, and reproducibly replaces a local Markdown/MDX index', () => {
    const firstRun = runBuild();
    expect(firstRun.status).toBe(0);
    expect(firstRun.stderr).toContain(
      'Built documentation local-handbook@candidate-3',
    );

    const firstCorpus = readFileSync(
      join(outputDirectory, 'corpus.json'),
      'utf8',
    );
    const firstManifest = DocumentationBuildManifestSchema.parse(
      JSON.parse(readFileSync(join(outputDirectory, 'manifest.json'), 'utf8')),
    );
    expect(firstManifest).toMatchObject({
      manifestVersion: 2,
      documentation: { id: 'local-handbook', version: 'candidate-3' },
      source: { kind: 'local' },
      pipeline: {
        parserVersion: MARKDOWN_PARSER_VERSION,
        transformerVersion: 1,
        normalizationAlgorithmVersion: 1,
        chunkingAlgorithmVersion: 1,
        maxChunkChars: 4000,
        indexSchemaVersion: 1,
        indexFormatVersion: 1,
      },
      corpus: { file: 'corpus.json', documentCount: 2 },
      index: {
        file: 'index.sqlite',
        documentationVersion: 'candidate-3',
        documentCount: 2,
      },
    });
    expect(firstManifest.corpus.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstManifest.index.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstManifest.index.chunkCount).toBeGreaterThan(0);

    const firstSearch = searchOutput('candidate-3');
    expect(firstSearch.markdown.documentId).toBeTruthy();
    expect(firstSearch.markdown.canonicalUrl).toBe(
      'https://manual.example.test/guide#local-handbook',
    );
    expect(firstSearch.markdown.sourceRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstSearch.mdx.documentId).toBeTruthy();
    expect(firstSearch.mdx.canonicalUrl).toBe(
      'https://manual.example.test/guide/reference/guide#reference-guide',
    );
    expect(firstSearch.mdx.sourceRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstSearch.markdown.markdown).toContain('ember tokens');
    expect(firstSearch.mdx.markdown).toContain('Velvet compass');
    expect(firstSearch.mdx.sections[0]?.markdown).toContain('<Callout');

    const secondRun = runBuild();
    expect(secondRun.status).toBe(0);
    expect(secondRun.stderr).toContain('mode: incremental');
    expect(secondRun.stderr).toContain(
      '0 added, 0 modified, 2 unchanged, 0 removed',
    );
    expect(readFileSync(join(outputDirectory, 'corpus.json'), 'utf8')).toBe(
      firstCorpus,
    );
    const secondManifest = DocumentationBuildManifestSchema.parse(
      JSON.parse(readFileSync(join(outputDirectory, 'manifest.json'), 'utf8')),
    );
    expect({
      ...secondManifest,
      index: { ...secondManifest.index, sha256: 'sqlite-bytes-may-vary' },
    }).toEqual({
      ...firstManifest,
      index: { ...firstManifest.index, sha256: 'sqlite-bytes-may-vary' },
    });
    expect(searchOutput('candidate-3')).toEqual(firstSearch);

    const cleanRun = runBuild(['--clean']);
    expect(cleanRun.status).toBe(0);
    expect(cleanRun.stderr).toContain('mode: clean');
    expect(cleanRun.stderr).toContain(
      '2 added, 0 modified, 0 unchanged, 0 removed',
    );
    expect(readFileSync(join(outputDirectory, 'corpus.json'), 'utf8')).toBe(
      firstCorpus,
    );
    expect(searchOutput('candidate-3')).toEqual(firstSearch);
  });

  it('leaves the previous valid output untouched when the build fails', () => {
    const result = runBuild();
    expect(result.status).toBe(0);
    const previousOutput = readOutputBytes();

    writeConfiguration({
      id: 'local-handbook',
      version: 'candidate-3',
      inputDirectory: './docs',
      discovery: { maxFileBytes: 8 },
      routeMapping: { baseUrl: 'https://manual.example.test' },
      outputDirectory: './generated',
    });
    const failed = runBuild();
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('maxFileBytes');
    expect(readOutputBytes()).toEqual(previousOutput);
  });

  it('reports invalid config fields before starting discovery', () => {
    writeConfiguration({
      id: '../bad-id',
      version: 'candidate-3',
      inputDirectory: './docs',
      routeMapping: { baseUrl: 'file:///tmp/docs' },
      outputDirectory: './generated',
    });
    const result = runBuild();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid documentation config');
    expect(result.stderr).toContain('id:');
  });

  function writeConfiguration(configuration: object): void {
    writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
  }

  function runBuild(extraArgs: string[] = []): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(
      process.execPath,
      [cliPath, 'build', '--config', configPath, ...extraArgs],
      { cwd: workspace, encoding: 'utf8' },
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  function readOutputBytes(): Record<string, Buffer> {
    return Object.fromEntries(
      ['corpus.json', 'index.sqlite', 'manifest.json'].map((filename) => [
        filename,
        readFileSync(join(outputDirectory, filename)),
      ]),
    );
  }

  function searchOutput(version: 'candidate-3') {
    const service = new TestDocumentationSearchService(
      join(outputDirectory, 'index.sqlite'),
      version,
    );
    try {
      const markdown = service.search('ember tokens', 1)[0]!;
      const mdx = service.search('velvet compass', 1)[0]!;
      return {
        markdown: {
          documentId: markdown.documentId,
          canonicalUrl: markdown.canonicalUrl,
          sourceRevision: markdown.sourceRevision,
          markdown: service.fetchDocument(markdown.documentId)!.sections[0]!
            .markdown,
        },
        mdx: {
          documentId: mdx.documentId,
          canonicalUrl: mdx.canonicalUrl,
          sourceRevision: mdx.sourceRevision,
          markdown: service.fetchDocument(mdx.documentId)!.sections[0]!
            .markdown,
          sections: service.fetchDocument(mdx.documentId)!.sections,
        },
      };
    } finally {
      service.onModuleDestroy();
    }
  }
});
