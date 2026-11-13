import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestSnapshot } from '@nestjs-docs/documentation-engine/application/services/documentation-ingestion.service.js';
import { transformNestJsDocument } from '../../../../../apps/docs-indexer/src/integrations/nestjs/nestjs-documentation-transformer.js';
import { writeDocumentationCorpus } from '@nestjs-docs/documentation-engine/infrastructure/filesystem/documentation-corpus-store.js';
import type { DocumentationSnapshot } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { loadIngestionFixtures } from '../../../../fixtures/ingestion.fixtures.js';
let snapshot: DocumentationSnapshot;
beforeAll(async () => {
  ({ snapshot } = await loadIngestionFixtures());
});

describe('corpus output', () => {
  it('writes reproducible JSON and cleans staging files if replacement fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestjs-ingestion-test-'));
    try {
      const corpus = ingestSnapshot(snapshot, transformNestJsDocument);
      const output = join(directory, 'nested', 'documentation.json');
      await writeDocumentationCorpus(corpus, output);
      const first = await readFile(output, 'utf8');
      await writeDocumentationCorpus(corpus, output);
      expect(await readFile(output, 'utf8')).toBe(first);
      const parsed: unknown = JSON.parse(first);
      expect(parsed).toEqual(corpus);

      const occupied = join(directory, 'occupied');
      await mkdir(occupied);
      await writeFile(join(occupied, 'keep.txt'), 'keep');
      await expect(
        writeDocumentationCorpus(corpus, occupied),
      ).rejects.toThrow();
      expect(await readFile(join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
      expect((await readdir(directory)).sort()).toEqual(['nested', 'occupied']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
