import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ingestNestJsDocuments } from '../../../../fixtures/ingestion.fixtures.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { TestDocumentationSearchService as DocumentationSearchService } from '../../../../fixtures/test-documentation-search-service.js';
import { createTestIndexManifest } from '../../../../fixtures/mcp-server-index.js';
import { DocumentationIndexRuntimeManifestSchema } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';

const repositoryRoot = resolve('.');
const verifier = resolve('scripts/ci/verify-package.mjs');
const sha256 = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');

describe('package index verification', () => {
  let root: string;
  let manifest: {
    formatVersion: number;
    indexPipelineVersion: number;
    repository: string;
    versions: Record<
      string,
      {
        version: '11' | '12';
        ref: string;
        revision: string;
        documentCount: number;
        chunkCount: number;
        sourceContentHashes: Record<string, string>;
        normalizedContentHashes: Record<string, string>;
        corpusSha256: string;
        indexSha256: string;
      }
    >;
  };
  const indexPath = (version: '11' | '12') =>
    join(root, 'data', `documentation-v${version}.sqlite`);
  const corpusPath = (version: '11' | '12') =>
    join(root, 'data', `documentation-v${version}.json`);
  const runtimeManifestPath = (version: '11' | '12') =>
    join(root, 'data', `documentation-v${version}.manifest.json`);
  const saveManifest = () =>
    writeFileSync(
      join(root, 'data', 'manifest.json'),
      JSON.stringify(manifest),
    );
  const rehashIndex = (version: '11' | '12') => {
    const indexSha256 = sha256(readFileSync(indexPath(version)));
    manifest.versions[String(version)]!.indexSha256 = indexSha256;
    const runtimeManifest = DocumentationIndexRuntimeManifestSchema.parse(
      JSON.parse(readFileSync(runtimeManifestPath(version), 'utf8')),
    );
    runtimeManifest.index.sha256 = indexSha256;
    writeFileSync(
      runtimeManifestPath(version),
      JSON.stringify(runtimeManifest),
    );
    saveManifest();
  };
  const verify = () =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import { pathToFileURL } from "node:url"; const verifier = process.argv[1]; const root = process.argv[2]; process.argv[1] = ""; const { verifyPackage } = await import(pathToFileURL(verifier).href); await verifyPackage(root);',
        verifier,
        root,
      ],
      { encoding: 'utf8' },
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nestjs-docs-package-'));
    for (const path of ['data', 'dist', 'licenses'])
      mkdirSync(join(root, path));
    copyFileSync(
      join(repositoryRoot, 'package.json'),
      join(root, 'package.json'),
    );
    const bootstrapDirectory = join(
      root,
      'dist',
      'apps',
      'mcp-server',
      'bootstrap',
    );
    mkdirSync(bootstrapDirectory, { recursive: true });
    writeFileSync(
      join(bootstrapDirectory, 'http.js'),
      '#!/usr/bin/env node\nHTTP entry point\n',
    );
    writeFileSync(
      join(bootstrapDirectory, 'stdio.js'),
      '#!/usr/bin/env node\n',
    );
    manifest = {
      formatVersion: 1,
      indexPipelineVersion: 2,
      repository: 'https://github.com/nestjs/docs.nestjs.com',
      versions: {},
    };
    for (const version of ['11', '12'] as const) {
      const ref = version === '11' ? '11.0.0' : 'master';
      const revision = (version === '11' ? 'a' : 'b').repeat(40);
      const corpus = ingestNestJsDocuments(
        version,
        [
          {
            path: 'content/page.md',
            canonicalUrl: `https://docs.nestjs.com/${version === '11' ? 'v11/' : ''}page`,
            markdown: '# Page\n\nSearchable content.',
          },
        ],
        revision,
      );
      writeFileSync(corpusPath(version), JSON.stringify(corpus));
      const writer = new DocumentationIndexWriter(indexPath(version), version);
      writer.indexCorpus(corpus);
      writer.close();
      writeFileSync(
        runtimeManifestPath(version),
        JSON.stringify(
          createTestIndexManifest(
            indexPath(version),
            corpus,
            'https://github.com/nestjs/docs.nestjs.com',
          ),
        ),
      );
      copyFileSync(
        join(repositoryRoot, `licenses/nestjs-docs-v${version}-LICENSE`),
        join(root, `licenses/nestjs-docs-v${version}-LICENSE`),
      );
      manifest.versions[String(version)] = {
        version,
        ref,
        revision,
        documentCount: corpus.documents.length,
        chunkCount: corpus.documents.flatMap((document) => document.chunks)
          .length,
        sourceContentHashes: Object.fromEntries(
          corpus.documents.map((document) => [
            document.id,
            document.source.contentHash,
          ]),
        ),
        normalizedContentHashes: Object.fromEntries(
          corpus.documents.map((document) => [
            document.id,
            document.contentHash,
          ]),
        ),
        corpusSha256: sha256(readFileSync(corpusPath(version))),
        indexSha256: sha256(readFileSync(indexPath(version))),
      };
    }
    saveManifest();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts complete indexes without changing them and requires their corpora for packing', () => {
    const service = new DocumentationSearchService(indexPath('11'), '11');
    try {
      const before = sha256(readFileSync(indexPath('11')));
      const verification = verify();
      expect(verification).toMatchObject({ status: 0 });
      expect(sha256(readFileSync(indexPath('11')))).toBe(before);
      expect(service.search('searchable')).toHaveLength(1);
      unlinkSync(corpusPath('11'));
      unlinkSync(corpusPath('12'));
      const result = verify();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Required package input is missing:');
    } finally {
      service.onModuleDestroy();
    }
  });

  it.each([
    [
      'name',
      'different-name',
      'npm package name does not match the MCP server name',
    ],
    [
      'version',
      '1.2.3',
      'npm package version does not match the MCP server version',
    ],
    [
      'description',
      'Different description.',
      'npm package description does not match the MCP server description',
    ],
  ] as const)(
    'rejects a package %s that differs from MCP metadata',
    (field, value, expectedError) => {
      const packagePath = join(root, 'package.json');
      const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        name: string;
        version: string;
        description: string;
      };
      packageMetadata[field] = value;
      writeFileSync(packagePath, JSON.stringify(packageMetadata));

      const result = verify();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
    },
  );

  it('rejects malformed package metadata', () => {
    const packagePath = join(root, 'package.json');
    const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      name: unknown;
      version: unknown;
      description: unknown;
    };
    packageMetadata.description = 42;
    writeFileSync(packagePath, JSON.stringify(packageMetadata));

    const result = verify();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('description');
  });

  it.each(['schema', 'version'] as const)(
    'rejects %s changes in both runtime and package verification',
    (change) => {
      const database = new DatabaseSync(indexPath('11'));
      if (change === 'schema') {
        database.exec(
          'DROP TABLE documentation_search; CREATE VIRTUAL TABLE documentation_search USING fts5(title, markdown)',
        );
      } else {
        database.exec(
          "UPDATE documentation_search SET documentation_version = '12'",
        );
      }
      database.close();
      rehashIndex('11');
      expect(
        () => new DocumentationSearchService(indexPath('11'), '11'),
      ).toThrow();
      const result = verify();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Invalid documentation v11 index/u);
    },
  );

  it('rejects an index that differs from its corpus even if the manifest hash is updated', () => {
    const db = new DatabaseSync(indexPath('11'));
    db.exec("UPDATE documentation_search SET markdown = 'altered content'");
    db.close();
    rehashIndex('11');
    const result = verify();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SQLite content does not match corpus');
  });

  it('rejects altered index and corpus files when their hashes no longer match the manifest', () => {
    const db = new DatabaseSync(indexPath('11'));
    db.exec("UPDATE documentation_search SET markdown = 'altered content'");
    db.close();
    expect(verify().stderr).toContain('index hash does not match manifest');
    rehashIndex('11');
    writeFileSync(corpusPath('11'), 'invalid corpus');
    expect(verify().stderr).toContain('corpus hash does not match manifest');
  });

  it('rejects manifest hash maps that disagree with an available corpus', () => {
    const entry = manifest.versions['11']!;
    entry.normalizedContentHashes[
      Object.keys(entry.normalizedContentHashes)[0]!
    ] = '0'.repeat(64);
    saveManifest();
    expect(verify().stderr).toContain(
      'corpus contents do not match its manifest',
    );
  });

  it('rejects manifest document IDs missing from the index', () => {
    const entry = manifest.versions['11']!;
    const id = Object.keys(entry.sourceContentHashes)[0]!;
    delete entry.sourceContentHashes[id];
    entry.sourceContentHashes[`nestjs-doc:v11:${'0'.repeat(64)}`] = 'a'.repeat(
      64,
    );
    saveManifest();
    expect(verify().stderr).toContain(
      'index contents do not match its manifest',
    );
  });

  it('rejects corrupt FTS content even when the database hash is updated', () => {
    const db = new DatabaseSync(indexPath('11'), { defensive: false });
    db.exec("UPDATE documentation_search_content SET c2 = 'corrupted content'");
    db.close();
    rehashIndex('11');
    const result = verify();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/integrity check failed|corrupt|checksum/iu);
  });
});
