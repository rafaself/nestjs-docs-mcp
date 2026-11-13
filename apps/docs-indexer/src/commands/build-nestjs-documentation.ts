import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildNestJsDocumentationSet } from '../integrations/nestjs/documentation.integration.js';

export async function buildNestJsDocumentationCommand(
  args: string[],
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: 'string', default: 'data/nestjs-documentation' },
      clean: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const summary = await buildNestJsDocumentationSet(
    resolve(values.output),
    fetch,
    { mode: values.clean ? 'clean' : 'incremental' },
  );
  console.error(
    `Built both official NestJS documentation majors into ${summary.outputDirectory}`,
  );
  for (const version of summary.versions) {
    console.error(
      `  v${version.version}: ${version.documentCount} documents, ${version.chunkCount} chunks; ${version.changes.added} added, ${version.changes.modified} modified, ${version.changes.unchanged} unchanged, ${version.changes.removed} removed; revision ${version.sourceRevision}`,
    );
  }
  if (summary.cleanupWarning) {
    console.error(`Warning ${summary.cleanupWarning}`);
  }
}
