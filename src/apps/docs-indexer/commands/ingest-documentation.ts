import { parseArgs } from 'node:util';
import { parseDocumentationVersion } from '../../../modules/documentation/domain/documentation-version.js';
import { downloadDocumentation } from '../../../modules/documentation/infrastructure/github/documentation-source.js';
import { parseDocument } from '../../../modules/documentation/infrastructure/markdown/markdown-parser.js';
import { writeDocumentationCorpus } from '../../../modules/documentation/infrastructure/filesystem/documentation-corpus-store.js';
import { ingestSnapshot } from '../../../modules/documentation/application/services/documentation-ingestion.service.js';
import { documentationCorpusPath } from '../paths.js';

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
  const snapshot = await downloadDocumentation(version);
  const corpus = ingestSnapshot(snapshot, parseDocument, maxChunkChars);
  await writeDocumentationCorpus(corpus, values.output);
  const chunks = corpus.documents.reduce(
    (sum, doc) => sum + doc.chunks.length,
    0,
  );
  console.error(
    `Ingested ${corpus.documents.length} documents and ${chunks} chunks at ${snapshot.revision} into ${values.output}`,
  );
}
