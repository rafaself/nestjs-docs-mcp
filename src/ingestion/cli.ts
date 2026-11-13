import { parseArgs } from 'node:util';
import {
  documentationCorpusPath,
  parseDocumentationVersion,
} from '../documentation-version.js';
import { downloadDocumentation } from './source.js';
import { ingestSnapshot, writeCorpus } from './pipeline.js';

async function main(): Promise<void> {
  const version = parseDocumentationVersion(process.env.NESTJS_VERSION);
  const { values } = parseArgs({
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
  const snapshot = await downloadDocumentation(version);
  const corpus = ingestSnapshot(snapshot, maxChunkChars);
  await writeCorpus(corpus, values.output);
  const chunks = corpus.documents.reduce(
    (sum, doc) => sum + doc.chunks.length,
    0,
  );
  console.error(
    `Ingested ${corpus.documents.length} documents and ${chunks} chunks at ${snapshot.revision} into ${values.output}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
