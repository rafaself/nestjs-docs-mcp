import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DocumentationCorpusSchema } from '../../domain/documentation.schemas.js';
import type { DocumentationCorpus } from '../../domain/documentation.types.js';

/** Replace the output only after the entire snapshot has been processed. */
export async function writeDocumentationCorpus(
  corpus: DocumentationCorpus,
  output: string,
): Promise<void> {
  const validatedCorpus = DocumentationCorpusSchema.parse(corpus);
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.ingestion-'));
  try {
    const temporary = join(staging, 'documentation.json');
    await writeFile(
      temporary,
      `${JSON.stringify(validatedCorpus, null, 2)}\n`,
      'utf8',
    );
    await rename(temporary, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
