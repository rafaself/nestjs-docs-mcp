import { readFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import {
  documentationCorpusPath,
  parseDocumentationVersion,
} from '../../documentation-version.js';
import { DocumentationSearchModule } from '../search.module.js';
import { DocumentationSearchService } from '../search.service.js';
import { searchDatabasePath } from '../search.constants.js';

async function main(): Promise<void> {
  const version = parseDocumentationVersion(process.env.NESTJS_VERSION);
  const { values } = parseArgs({
    options: {
      input: { type: 'string', default: documentationCorpusPath(version) },
      database: { type: 'string', default: searchDatabasePath(version) },
    },
    allowPositionals: false,
  });
  const corpus: unknown = JSON.parse(await readFile(values.input, 'utf8'));
  const app = await NestFactory.createApplicationContext(
    DocumentationSearchModule.register(values.database, version),
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
