import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NestJsDocumentationVersion } from '../../documentation-version.js';
import type { DocumentationCorpus } from '../../ingestion/types.js';
import { DOCUMENTATION_SOURCES, REPOSITORY } from '../../ingestion/source.js';
import { validateRuntimeIndex } from '../runtime-index.js';

const RAW_SOURCE = 'https://raw.githubusercontent.com/nestjs/docs.nestjs.com';
const SITE = 'https://docs.nestjs.com';

interface ExpectedRow {
  chunkId: string;
  documentId: string;
  title: string;
  headingPath: string;
  markdown: string;
  canonicalUrl: string;
  sourceRevision: string;
}

/** Check SQLite and FTS5 without writing to the source database. */
export function validateIndexIntegrity(
  database: DatabaseSync,
  version: NestJsDocumentationVersion,
): ReturnType<typeof validateRuntimeIndex> {
  const summary = validateRuntimeIndex(database, version);
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`NestJS v${version} SQLite integrity check failed`);
  }

  // FTS5's integrity check is a write command. Run it on a disposable copy,
  // so validation cannot modify the index served by the MCP runtime.
  const directory = mkdtempSync(join(tmpdir(), 'nestjs-docs-fts-check-'));
  try {
    const copyPath = join(directory, 'index.sqlite');
    database.prepare('VACUUM main INTO ?').run(copyPath);
    const copy = new DatabaseSync(copyPath);
    try {
      copy
        .prepare(
          "INSERT INTO documentation_search(documentation_search, rank) VALUES ('integrity-check', 1)",
        )
        .run();
    } catch (error) {
      throw new Error(`NestJS v${version} FTS5 integrity check failed`, {
        cause: error,
      });
    } finally {
      copy.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return summary;
}

/** Validate a generated corpus against its existing index. */
export function validateDocumentationIndex(
  version: NestJsDocumentationVersion,
  corpus: DocumentationCorpus,
  databasePath: string,
): { documentCount: number; chunkCount: number } {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    validateIndexIntegrity(database, version);
    return validateCorpusIndex(version, corpus, database);
  } finally {
    database.close();
  }
}

/** Validate corpus hashes and require exact parity with its SQLite FTS rows. */
export function validateCorpusIndex(
  version: NestJsDocumentationVersion,
  corpus: DocumentationCorpus,
  database: DatabaseSync,
): { documentCount: number; chunkCount: number } {
  const revision = corpus?.source?.revision;
  const expectedRef = DOCUMENTATION_SOURCES[version].ref;
  if (
    !corpus ||
    corpus.source?.repository !== REPOSITORY ||
    corpus.source?.version !== version ||
    corpus.source?.ref !== expectedRef ||
    typeof revision !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    !Array.isArray(corpus.documents) ||
    corpus.documents.length === 0
  ) {
    throw new Error(`NestJS v${version} corpus metadata is invalid`);
  }

  const documentIds = new Set<string>();
  const expectedRows = new Map<string, ExpectedRow>();
  for (const document of corpus.documents) {
    const sourcePath = document?.source?.path;
    if (
      !document ||
      typeof document.id !== 'string' ||
      document.id !==
        `nestjs-doc:v${version}:${sha256(`${REPOSITORY}\0v${version}\0${sourcePath}`)}` ||
      documentIds.has(document.id) ||
      typeof sourcePath !== 'string' ||
      !/^content\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/u.test(sourcePath) ||
      typeof document.title !== 'string' ||
      !document.title.trim() ||
      typeof document.markdown !== 'string' ||
      document.contentHash !== sha256(document.markdown) ||
      !isSha256(document.source?.contentHash) ||
      document.source?.revision !== revision ||
      document.source?.url !== `${RAW_SOURCE}/${revision}/${sourcePath}` ||
      !isCanonicalUrl(version, document.canonicalUrl) ||
      !Array.isArray(document.chunks) ||
      document.chunks.length === 0
    ) {
      throw new Error(`NestJS v${version} document failed integrity checks`);
    }
    documentIds.add(document.id);

    for (const chunk of document.chunks) {
      if (
        !chunk ||
        typeof chunk.id !== 'string' ||
        !chunk.id.startsWith(`${document.id}:`) ||
        expectedRows.has(chunk.id) ||
        chunk.documentId !== document.id ||
        chunk.title !== document.title ||
        chunk.sourceRevision !== revision ||
        !isCanonicalUrl(version, chunk.canonicalUrl) ||
        typeof chunk.markdown !== 'string' ||
        chunk.contentHash !== sha256(chunk.markdown) ||
        !Array.isArray(chunk.headingPath) ||
        chunk.headingPath.some(
          (heading) => !heading || typeof heading.title !== 'string',
        )
      ) {
        throw new Error(`NestJS v${version} chunk failed integrity checks`);
      }
      expectedRows.set(chunk.id, {
        chunkId: chunk.id,
        documentId: document.id,
        title: document.title,
        headingPath: chunk.headingPath
          .map((heading) => heading.title)
          .join(' > '),
        markdown: chunk.markdown,
        canonicalUrl: chunk.canonicalUrl,
        sourceRevision: revision,
      });
    }
  }

  const actualRows = database
    .prepare(
      `
        SELECT chunk_id AS chunkId, document_id AS documentId, title,
          heading_path AS headingPath, markdown,
          canonical_url AS canonicalUrl, source_revision AS sourceRevision
        FROM documentation_search
        WHERE documentation_version = ?
      `,
    )
    .all(version);
  if (actualRows.length !== expectedRows.size) {
    throw new Error(
      `NestJS v${version} SQLite row count does not match corpus`,
    );
  }

  const seen = new Set<string>();
  for (const row of actualRows) {
    const expected = expectedRows.get(String(row.chunkId));
    if (
      !expected ||
      seen.has(expected.chunkId) ||
      row.documentId !== expected.documentId ||
      row.title !== expected.title ||
      row.headingPath !== expected.headingPath ||
      row.markdown !== expected.markdown ||
      row.canonicalUrl !== expected.canonicalUrl ||
      row.sourceRevision !== expected.sourceRevision
    ) {
      throw new Error(
        `NestJS v${version} SQLite content does not match corpus`,
      );
    }
    seen.add(expected.chunkId);
  }

  return { documentCount: documentIds.size, chunkCount: expectedRows.size };
}

function isCanonicalUrl(
  version: NestJsDocumentationVersion,
  value: unknown,
): boolean {
  if (typeof value !== 'string') return false;
  const prefix = version === 11 ? `${SITE}/v11` : SITE;
  if (
    version === 12 &&
    (value === `${SITE}/v11` ||
      value.startsWith(`${SITE}/v11/`) ||
      value.startsWith(`${SITE}/v11#`))
  ) {
    return false;
  }
  return (
    value === prefix ||
    value.startsWith(`${prefix}/`) ||
    value.startsWith(`${prefix}#`)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
