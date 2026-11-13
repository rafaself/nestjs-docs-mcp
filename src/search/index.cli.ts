import { readFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import type { DocumentationCorpus } from '../ingestion/types.js';
import { DocumentationSearchModule } from './search.module.js';
import { DocumentationSearchService } from './search.service.js';
import { DEFAULT_SEARCH_DATABASE_PATH } from './search.constants.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', default: 'data/documentation.json' },
      database: { type: 'string', default: DEFAULT_SEARCH_DATABASE_PATH },
    },
    allowPositionals: false,
  });
  const corpus = JSON.parse(
    await readFile(values.input, 'utf8'),
  ) as DocumentationCorpus;
  const app = await NestFactory.createApplicationContext(
    DocumentationSearchModule.register(values.database),
    { logger: false },
  );
  try {
    const chunks = app.get(DocumentationSearchService).indexCorpus(corpus);
    console.error(
      `Indexed ${chunks} documentation chunks into ${values.database}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
