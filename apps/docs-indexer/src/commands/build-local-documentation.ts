import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { DocumentationBuildConfigSchema } from '../config/documentation-build-config.js';
import { buildLocalDocumentation } from '../services/build-local-documentation.js';

export async function buildLocalDocumentationCommand(
  args: string[],
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      clean: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (!values.config) {
    throw new Error(
      'The build command requires --config <path> to a JSON documentation configuration',
    );
  }

  const configPath = resolve(values.config);
  let rawConfiguration: unknown;
  try {
    rawConfiguration = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (cause) {
    throw new Error(
      `Unable to read JSON documentation config "${configPath}"`,
      {
        cause,
      },
    );
  }

  const parsed = DocumentationBuildConfigSchema.safeParse(rawConfiguration);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid documentation config:\n${details}`);
  }

  const configDirectory = dirname(configPath);
  const summary = await buildLocalDocumentation(
    {
      ...parsed.data,
      inputDirectory: resolve(configDirectory, parsed.data.inputDirectory),
      outputDirectory: resolve(configDirectory, parsed.data.outputDirectory),
    },
    { mode: values.clean ? 'clean' : 'incremental' },
  );
  console.error(
    [
      `Built documentation ${summary.id}@${summary.version}`,
      `  mode: ${summary.mode}`,
      `  changes: ${summary.changes.added} added, ${summary.changes.modified} modified, ${summary.changes.unchanged} unchanged, ${summary.changes.removed} removed`,
      `  source revision: ${summary.sourceRevision}`,
      `  documents: ${summary.documentCount}`,
      `  chunks: ${summary.chunkCount}`,
      `  output: ${summary.outputDirectory}`,
    ].join('\n'),
  );
  for (const diagnostic of summary.diagnostics) {
    console.error(
      `Warning ${diagnostic.path}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
    );
  }
  if (summary.cleanupWarning) {
    console.error(`Warning ${summary.cleanupWarning}`);
  }
}
