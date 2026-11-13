import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = resolve(rootDirectory, 'data');
const repository = 'https://github.com/nestjs/docs.nestjs.com';
const supportedVersions = [
  { version: 11, ref: '11.0.0' },
  { version: 12, ref: 'master' },
];

async function main() {
  const packageMetadata = JSON.parse(
    await readFile(resolve(rootDirectory, 'package.json'), 'utf8'),
  );
  const requiredPackageFiles = [
    'dist/**',
    'data/documentation-v11.sqlite',
    'data/documentation-v12.sqlite',
    'data/manifest.json',
    'README.md',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    'licenses/nestjs-docs-v11-LICENSE',
    'licenses/nestjs-docs-v12-LICENSE',
  ];
  const executablePath = resolve(rootDirectory, 'dist/main.js');
  await requireFile(executablePath);
  if (
    packageMetadata.private === true ||
    packageMetadata.bin?.['nestjs-docs-mcp'] !== './dist/main.js' ||
    requiredPackageFiles.some(
      (path) => !packageMetadata.files?.includes(path),
    ) ||
    !(await readFile(executablePath, 'utf8')).startsWith(
      '#!/usr/bin/env node\n',
    )
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
    manifest.repository !== repository ||
    !sameValues(Object.keys(manifest.versions ?? {}).sort(), ['11', '12'])
  ) {
    throw new Error('Documentation index manifest metadata is invalid');
  }

  for (const { version, ref } of supportedVersions) {
    const key = String(version);
    const entry = manifest.versions[key];
    const licensePath = resolve(
      rootDirectory,
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

    const database = new DatabaseSync(databasePath);
    try {
      const integrity = database
        .prepare('PRAGMA integrity_check')
        .all()
        .map((row) => row.integrity_check);
      if (integrity.length !== 1 || integrity[0] !== 'ok') {
        throw new Error(`NestJS v${version} SQLite integrity check failed`);
      }

      checkFtsIntegrity(database, version);
      const columns = new Set(
        database
          .prepare('PRAGMA table_info(documentation_search)')
          .all()
          .map((row) => row.name),
      );
      if (
        ![
          'documentation_version',
          'document_id',
          'source_revision',
          'chunk_id',
        ].every((column) => columns.has(column))
      ) {
        throw new Error(`NestJS v${version} index schema is incomplete`);
      }

      const summary = database
        .prepare(
          `
          SELECT COUNT(*) AS chunkCount,
            COUNT(DISTINCT document_id) AS documentCount,
            COUNT(DISTINCT source_revision) AS revisionCount,
            MIN(source_revision) AS revision
          FROM documentation_search
          WHERE documentation_version = ?
        `,
        )
        .get(version);
      const otherVersionRows = database
        .prepare(
          'SELECT COUNT(*) AS count FROM documentation_search WHERE documentation_version <> ?',
        )
        .get(version)?.count;
      if (
        summary?.chunkCount !== entry.chunkCount ||
        summary.documentCount !== entry.documentCount ||
        summary.revisionCount !== 1 ||
        summary.revision !== entry.revision ||
        otherVersionRows !== 0
      ) {
        throw new Error(
          `NestJS v${version} index contents do not match its manifest`,
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

function checkFtsIntegrity(database, version) {
  database.exec('BEGIN');
  try {
    database
      .prepare(
        "INSERT INTO documentation_search(documentation_search, rank) VALUES ('integrity-check', 1)",
      )
      .run();
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Some SQLite errors roll back the active transaction automatically.
    }
    throw new Error(`NestJS v${version} FTS5 integrity check failed`, {
      cause: error,
    });
  }
  database.exec('ROLLBACK');
}

async function requireFile(path) {
  try {
    await access(path);
  } catch {
    throw new Error(
      `Required package asset is missing: ${path}. Extract the latest documentation index release into data/, or generate a new bundle with scripts/synchronize-documentation-indexes.mjs before packing.`,
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
