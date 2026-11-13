import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseDocumentationVersion } from '../integrations/nestjs/version/documentation-version.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { searchDatabasePath } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-paths.js';
import { documentationCorpusPath } from '../paths.js';

export async function indexDocumentation(args: string[]): Promise<void> {
  const version = parseDocumentationVersion(process.env.NESTJS_VERSION);
  const { values } = parseArgs({
    args,
    options: {
      input: { type: 'string', default: documentationCorpusPath(version) },
      database: {
        type: 'string',
        default: searchDatabasePath(version),
      },
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
