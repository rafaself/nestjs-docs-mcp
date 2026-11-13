#!/usr/bin/env node
import { indexDocumentation } from './commands/index-documentation.js';
import { ingestDocumentation } from './commands/ingest-documentation.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'ingest') {
    await ingestDocumentation(args);
    return;
  }
  if (command === 'index') {
    await indexDocumentation(args);
    return;
  }
  throw new Error('Expected a docs-indexer command: ingest or index');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
