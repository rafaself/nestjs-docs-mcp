import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  documentationCorpusPath,
  parseDocumentationVersion,
} from '../../documentation-version.js';
import { DocumentationIndexWriter } from './index-writer.js';
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
  const index = new DocumentationIndexWriter(values.database, version);
  try {
    const chunks = index.indexCorpus(corpus);
    console.error(
      `Indexed ${chunks} documentation chunks into ${values.database}`,
    );
  } finally {
    index.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
