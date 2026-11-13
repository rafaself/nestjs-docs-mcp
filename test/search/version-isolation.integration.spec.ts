import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { ingestSnapshot } from '../../src/ingestion/pipeline.js';
import { DocumentationSearchModule } from '../../src/search/search.module.js';
import { DocumentationSearchService } from '../../src/search/search.service.js';

describe('documentation version isolation', () => {
  let directory: string;
  let app11: INestApplicationContext;
  let app12: INestApplicationContext;
  let service11: DocumentationSearchService;
  let service12: DocumentationSearchService;
  let corpus11: ReturnType<typeof createVersionCorpus>;
  let corpus12: ReturnType<typeof createVersionCorpus>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-version-'));
    const databasePath = join(directory, 'shared.sqlite');
    corpus11 = createVersionCorpus(11, 'v11onlymango');
    corpus12 = createVersionCorpus(12, 'v12onlygrapefruit');

    app11 = await NestFactory.createApplicationContext(
      DocumentationSearchModule.register(databasePath, 11),
      { logger: false },
    );
    app12 = await NestFactory.createApplicationContext(
      DocumentationSearchModule.register(databasePath, 12),
      { logger: false },
    );
    service11 = app11.get(DocumentationSearchService);
    service12 = app12.get(DocumentationSearchService);
    service11.indexCorpus(corpus11);
    service12.indexCorpus(corpus12);
  });

  afterAll(async () => {
    await app12?.close();
    await app11?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('keeps search results isolated in one shared SQLite file', () => {
    expect(corpus11.source).toMatchObject({
      version: 11,
      ref: '11.0.0',
      revision: 'a'.repeat(40),
    });
    expect(corpus12.source).toMatchObject({
      version: 12,
      ref: 'master',
      revision: 'b'.repeat(40),
    });
    expect(
      service11.search('v11onlymango').map((result) => result.documentId),
    ).toEqual([corpus11.documents[0]?.id]);
    expect(service11.search('v12onlygrapefruit')).toEqual([]);
    expect(
      service12.search('v12onlygrapefruit').map((result) => result.documentId),
    ).toEqual([corpus12.documents[0]?.id]);
    expect(service12.search('v11onlymango')).toEqual([]);
  });

  it('rejects cross-version document IDs even when both versions are indexed', () => {
    const id11 = corpus11.documents[0]!.id;
    const id12 = corpus12.documents[0]!.id;

    expect(service11.fetchDocument(id11)).not.toBeNull();
    expect(service12.fetchDocument(id12)).not.toBeNull();
    expect(() => service11.fetchDocument(id12)).toThrow(/configured for v11/u);
    expect(() => service12.fetchDocument(id11)).toThrow(/configured for v12/u);
  });

  it('refuses to index a corpus from another major', () => {
    expect(() => service11.indexCorpus(corpus12)).toThrow(
      'Documentation corpus must contain documents for NestJS v11',
    );
  });
});

function createVersionCorpus(version: 11 | 12, uniqueTerm: string) {
  const revision = version === 11 ? 'a'.repeat(40) : 'b'.repeat(40);
  return ingestSnapshot({
    version,
    ref: version === 11 ? '11.0.0' : 'master',
    revision,
    documents: [
      {
        path: 'content/fundamentals/execution-context.md',
        canonicalUrl:
          version === 11
            ? 'https://docs.nestjs.com/v11/fundamentals/execution-context'
            : 'https://docs.nestjs.com/fundamentals/execution-context',
        markdown: `# Versioned execution context\n\n## API\n\n${uniqueTerm} describes this version only.`,
      },
    ],
  });
}
