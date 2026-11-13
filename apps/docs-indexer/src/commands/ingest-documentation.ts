import { parseArgs } from 'node:util';
import { parseDocumentationVersion } from '../integrations/nestjs/version/documentation-version.js';
import { writeDocumentationCorpus } from '@nestjs-docs/documentation-engine/infrastructure/filesystem/documentation-corpus-store.js';
import { documentationCorpusPath } from '../paths.js';
import { ingestNestJsDocumentation } from '../integrations/nestjs/documentation.integration.js';

export async function ingestDocumentation(args: string[]): Promise<void> {
  const version = parseDocumentationVersion(process.env.NESTJS_VERSION);
  const { values } = parseArgs({
    args,
    options: {
      output: { type: 'string', default: documentationCorpusPath(version) },
      'max-chars': { type: 'string', default: '4000' },
    },
    allowPositionals: false,
  });
  const maxChunkChars = Number(values['max-chars']);
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error('--max-chars must be a positive integer');
  }
  const { snapshot, corpus } = await ingestNestJsDocumentation(
    version,
    fetch,
    maxChunkChars,
  );
  await writeDocumentationCorpus(corpus, values.output);
  const chunks = corpus.documents.reduce(
    (sum, doc) => sum + doc.chunks.length,
    0,
  );
  console.error(
    `Ingested ${corpus.documents.length} documents and ${chunks} chunks at ${snapshot.source.revision} into ${values.output}`,
  );
}
