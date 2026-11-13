import { spawnSync } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { verifyPackage } from '../ci/verify-package.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundleFiles = [
  'documentation-v11.json',
  'documentation-v11.sqlite',
  'documentation-v11.manifest.json',
  'documentation-v12.json',
  'documentation-v12.sqlite',
  'documentation-v12.manifest.json',
  'manifest.json',
];

function usage() {
  return [
    'Usage:',
    '  npm run package:verify -- --bundle-dir <extracted-index-bundle>',
    '  npm run package:verify -- --regenerate',
    '',
    'Choose one source. --bundle-dir expects the seven files from',
    'documentation-indexes.tar.gz. --regenerate resolves current revisions',
    'from the configured NestJS refs and builds fresh indexes.',
  ].join('\n');
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length === 1 && args[0] === '--regenerate') {
    return { regenerate: true };
  }
  if (args.length === 2 && args[0] === '--bundle-dir' && args[1]) {
    return { bundleDirectory: resolve(args[1]) };
  }
  throw new Error(usage());
}

function run(command, args, options = {}) {
  const environment = { ...process.env };
  delete environment.npm_config_dry_run;
  delete environment.NPM_CONFIG_DRY_RUN;

  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal})`,
    );
  }
}

async function validateBundleDirectory(directory) {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Index bundle path must be a real directory: ${directory}`);
  }

  const entries = await readdir(directory);
  if (
    entries.length !== bundleFiles.length ||
    entries.some((entry) => !bundleFiles.includes(entry))
  ) {
    throw new Error(
      `Index bundle must contain exactly: ${bundleFiles.join(', ')}`,
    );
  }

  for (const file of bundleFiles) {
    const filePath = join(directory, file);
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`Index bundle entry must be a regular file: ${filePath}`);
    }
  }
}

async function createBundle(source, destination) {
  await mkdir(destination);
  await validateBundleDirectory(source);
  await Promise.all(
    bundleFiles.map((file) =>
      copyFile(join(source, file), join(destination, file)),
    ),
  );
}

async function stageDataDirectory(bundleDirectory) {
  const dataDirectory = join(root, 'data');
  const stagingDirectory = await mkdtemp(
    join(root, '.nestjs-docs-package-data-'),
  );
  const backupDirectory = join(
    root,
    `.nestjs-docs-package-data-backup-${randomUUID()}`,
  );
  let movedPreviousData = false;
  let installedStagedData = false;

  try {
    await Promise.all(
      bundleFiles.map((file) =>
        copyFile(join(bundleDirectory, file), join(stagingDirectory, file)),
      ),
    );

    try {
      const previousStat = await lstat(dataDirectory);
      if (!previousStat.isDirectory() || previousStat.isSymbolicLink()) {
        throw new Error(
          `Existing data path must be a real directory: ${dataDirectory}`,
        );
      }
      await rename(dataDirectory, backupDirectory);
      movedPreviousData = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    await rename(stagingDirectory, dataDirectory);
    installedStagedData = true;
  } catch (error) {
    if (installedStagedData) {
      await rm(dataDirectory, { recursive: true, force: true });
    }
    if (movedPreviousData) {
      await rename(backupDirectory, dataDirectory);
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    async commit() {
      if (movedPreviousData) {
        await rm(backupDirectory, { recursive: true, force: true });
      }
    },
    async rollback() {
      if (installedStagedData) {
        await rm(dataDirectory, { recursive: true, force: true });
      }
      if (movedPreviousData) {
        await rename(backupDirectory, dataDirectory);
      }
    },
  };
}

async function main(args) {
  const options = parseArguments(args);
  if (options.help) {
    console.log(usage());
    return;
  }

  const workDirectory = await mkdtemp(join(tmpdir(), 'nestjs-docs-package-'));
  let dataSwap;
  try {
    run('npm', ['run', 'build']);

    let bundleDirectory = options.bundleDirectory;
    if (options.regenerate) {
      bundleDirectory = join(workDirectory, 'generated-indexes');
      run(process.execPath, [
        join(root, 'scripts/release/synchronize-documentation-indexes.mjs'),
        '--output',
        bundleDirectory,
      ]);
    }

    const checkedBundle = join(workDirectory, 'bundle');
    await createBundle(bundleDirectory, checkedBundle);
    await verifyPackage(root, checkedBundle);

    dataSwap = await stageDataDirectory(checkedBundle);
    const packDirectory = join(workDirectory, 'packed');
    await mkdir(packDirectory);
    run('npm', ['pack', '--pack-destination', packDirectory]);
    await dataSwap.commit();
    console.log(
      `Verified npm package from ${basename(bundleDirectory)}. The validated index bundle is staged in data/.`,
    );
  } catch (error) {
    if (dataSwap) {
      await dataSwap.rollback().catch((rollbackError) => {
        console.error(
          'Failed to restore the previous data directory:',
          rollbackError,
        );
      });
    }
    throw error;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
