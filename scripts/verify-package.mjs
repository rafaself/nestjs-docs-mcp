import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUPPORTED_DOCUMENTATION_VERSIONS } from '../dist/documentation-version.js';
import { DOCUMENTATION_SOURCES, REPOSITORY } from '../dist/ingestion/source.js';
import {
  PACKAGE_DESCRIPTION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  packageMetadataSchema,
} from '../dist/package-metadata.js';
import {
  validateCorpusIndex,
  validateIndexIntegrity,
} from '../dist/search/indexing/index-integrity.js';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
export async function verifyPackage(root = rootDirectory) {
  const dataDirectory = resolve(root, 'data');
  const packageMetadata = packageMetadataSchema.parse(
    JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')),
  );
  if (packageMetadata.name !== PACKAGE_NAME) {
    throw new Error('npm package name does not match the MCP server name');
  }
  if (packageMetadata.version !== PACKAGE_VERSION) {
    throw new Error(
      'npm package version does not match the MCP server version',
    );
  }
  if (packageMetadata.description !== PACKAGE_DESCRIPTION) {
    throw new Error(
      'npm package description does not match the MCP server description',
    );
  }

  const requiredPackageFiles = [
    'dist/**',
    ...SUPPORTED_DOCUMENTATION_VERSIONS.map(
      (version) => `data/documentation-v${version}.sqlite`,
    ),
    'data/manifest.json',
    'README.md',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    ...SUPPORTED_DOCUMENTATION_VERSIONS.map(
      (version) => `licenses/nestjs-docs-v${version}-LICENSE`,
    ),
  ];
  const httpEntryPath = resolve(root, 'dist/main.js');
  const executablePath = resolve(root, 'dist/stdio.js');
  await Promise.all([requireFile(httpEntryPath), requireFile(executablePath)]);
  const [httpEntry, stdioEntry] = await Promise.all([
    readFile(httpEntryPath, 'utf8'),
    readFile(executablePath, 'utf8'),
  ]);
  if (
    packageMetadata.private === true ||
    packageMetadata.bin?.['nestjs-docs-mcp'] !== './dist/stdio.js' ||
    packageMetadata.bin?.['nestjs-docs-mcp-http'] !== './dist/main.js' ||
    requiredPackageFiles.some(
      (path) => !packageMetadata.files?.includes(path),
    ) ||
    !httpEntry.startsWith('#!/usr/bin/env node\n') ||
    !stdioEntry.startsWith('#!/usr/bin/env node\n')
  ) {
    throw new Error(
      'npm package metadata or executable entry point is invalid',
    );
  }

  const manifestPath = resolve(dataDirectory, 'manifest.json');
  await requireFile(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.formatVersion !== 1 ||
    manifest.indexPipelineVersion !== 1 ||
    manifest.repository !== REPOSITORY ||
    !sameValues(
      Object.keys(manifest.versions ?? {}).sort(),
      SUPPORTED_DOCUMENTATION_VERSIONS.map(String).sort(),
    )
  ) {
    throw new Error('Documentation index manifest metadata is invalid');
  }

  for (const version of SUPPORTED_DOCUMENTATION_VERSIONS) {
    const { ref } = DOCUMENTATION_SOURCES[version];
    const key = String(version);
    const entry = manifest.versions[key];
    const licensePath = resolve(
      root,
      `licenses/nestjs-docs-v${version}-LICENSE`,
    );
    const databasePath = resolve(
      dataDirectory,
      `documentation-v${version}.sqlite`,
    );
    await requireFile(databasePath);
    await requireFile(licensePath);
    const license = await readFile(licensePath, 'utf8');
    if (
      !license.includes('(The MIT License)') ||
      !license.includes('Copyright (c)') ||
      !license.includes('Permission is hereby granted') ||
      !entry ||
      entry.version !== version ||
      entry.ref !== ref ||
      !isSha(entry.revision, 40) ||
      !isSha(entry.indexSha256, 64) ||
      !isSha(entry.corpusSha256, 64) ||
      !Number.isSafeInteger(entry.documentCount) ||
      entry.documentCount < 1 ||
      !Number.isSafeInteger(entry.chunkCount) ||
      entry.chunkCount < 1 ||
      !isHashMap(entry.sourceContentHashes, entry.documentCount) ||
      !isHashMap(entry.normalizedContentHashes, entry.documentCount)
    ) {
      throw new Error(`NestJS v${version} package manifest entry is invalid`);
    }
    if ((await hashFile(databasePath)) !== entry.indexSha256) {
      throw new Error(`NestJS v${version} index hash does not match manifest`);
    }

    const corpusPath = resolve(dataDirectory, `documentation-v${version}.json`);
    await requireFile(corpusPath);
    if ((await hashFile(corpusPath)) !== entry.corpusSha256) {
      throw new Error(`NestJS v${version} corpus hash does not match manifest`);
    }
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const summary = validateIndexIntegrity(database, version);
      const documentIds = database
        .prepare('SELECT DISTINCT document_id AS id FROM documentation_search')
        .all()
        .map((row) => row.id)
        .sort();
      if (
        summary.chunkCount !== entry.chunkCount ||
        summary.documentCount !== entry.documentCount ||
        summary.revision !== entry.revision ||
        !sameValues(
          documentIds,
          Object.keys(entry.sourceContentHashes).sort(),
        ) ||
        !sameValues(
          documentIds,
          Object.keys(entry.normalizedContentHashes).sort(),
        )
      ) {
        throw new Error(
          `NestJS v${version} index contents do not match its manifest`,
        );
      }

      validateCorpusIndex(version, corpus, database);
      if (
        corpus.source.revision !== entry.revision ||
        !corpus.documents.every(
          (document) =>
            entry.sourceContentHashes[document.id] ===
              document.source.contentHash &&
            entry.normalizedContentHashes[document.id] === document.contentHash,
        )
      ) {
        throw new Error(
          `NestJS v${version} corpus contents do not match its manifest`,
        );
      }
    } finally {
      database.close();
    }

    console.log(
      `Verified NestJS v${version}: ${entry.documentCount} documents, ${entry.chunkCount} chunks, revision ${entry.revision}`,
    );
  }
}

async function requireFile(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(
      `Required package input is missing: ${path}. Extract a complete documentation index bundle into data/, or generate one with scripts/synchronize-documentation-indexes.mjs before packing.`,
      { cause: error },
    );
  }
}

async function hashFile(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function isSha(value, length) {
  return (
    typeof value === 'string' &&
    new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)
  );
}

function isHashMap(value, expectedSize) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedSize &&
    Object.values(value).every((hash) => isSha(hash, 64))
  );
}

function sameValues(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifyPackage().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
