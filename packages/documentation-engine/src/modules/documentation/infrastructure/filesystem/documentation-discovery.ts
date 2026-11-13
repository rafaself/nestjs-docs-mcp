import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { opendir, open, realpath, stat } from 'node:fs/promises';
import {
  isAbsolute,
  join,
  posix as posixPath,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  DocumentationSnapshotSchema,
  DocumentationVersionSchema,
} from '../../domain/documentation.schemas.js';
import type { DocumentationSnapshot } from '../../domain/documentation.types.js';

const DEFAULT_INCLUDE = ['**/*.md', '**/*.mdx'];
const DEFAULT_EXCLUDE = ['**/.git/**', '**/node_modules/**'];
const DIRECTORY_PROBE = '__documentation_discovery_probe__.md';
const READ_CHUNK_BYTES = 64 * 1024;

const MAX_DEPTH = 256;
const MAX_ENTRIES = 1_000_000;
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const globPatternSchema = z
  .string()
  .trim()
  .min(1)
  .transform((pattern) => pattern.replaceAll('\\', '/'))
  .refine(
    (pattern) =>
      !pattern.startsWith('/') &&
      !/^[a-z]:/iu.test(pattern) &&
      !pattern.includes('\0') &&
      !pattern.split('/').includes('..'),
    'Patterns must be relative and cannot traverse above the documentation root',
  );

export const DocumentationDiscoverySettingsSchema = z.strictObject({
  include: z.array(globPatternSchema).min(1).default(DEFAULT_INCLUDE),
  exclude: z.array(globPatternSchema).default(DEFAULT_EXCLUDE),
  followSymlinks: z.boolean().default(false),
  maxDepth: z.number().int().min(0).max(MAX_DEPTH).default(32),
  maxEntries: z.number().int().min(1).max(MAX_ENTRIES).default(100_000),
  maxFiles: z.number().int().min(1).max(MAX_FILES).default(10_000),
  maxFileBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_FILE_BYTES)
    .default(4 * 1024 * 1024),
  maxTotalBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOTAL_BYTES)
    .default(64 * 1024 * 1024),
});

const discoveryOptionsSchema = DocumentationDiscoverySettingsSchema.extend({
  root: z.string().refine((path) => path.trim().length > 0),
  version: DocumentationVersionSchema,
});

export type DocumentationDiscoverySettings = z.input<
  typeof DocumentationDiscoverySettingsSchema
>;
export type DocumentationDiscoveryOptions = z.input<
  typeof discoveryOptionsSchema
>;

interface FileCandidate {
  path: string;
  absolutePath: string;
}

interface DirectoryCandidate extends FileCandidate {
  depth: number;
}

/**
 * Discover Markdown and MDX files as a generic local documentation snapshot.
 * Relative file paths are stable document IDs; canonical and source locations
 * are file URLs. Include and exclude globs match portable relative paths. The
 * local revision hashes the ordered relative paths and file contents. Defaults
 * scan Markdown and MDX, skip `.git`, `node_modules`, and symlinks, and cap
 * traversal at depth 32, 100,000 entries, 10,000 files, 4 MiB per file, and
 * 64 MiB total content. Followed links must resolve within the real root;
 * directory aliases are visited once and duplicate file targets are rejected.
 */
export async function discoverLocalDocumentation(
  input: DocumentationDiscoveryOptions,
): Promise<DocumentationSnapshot> {
  const options = discoveryOptionsSchema.parse(input);
  const configuredRoot = resolve(options.root);
  const root = await realpath(configuredRoot).catch((cause: unknown) => {
    throw new Error(`Unable to resolve documentation root "${options.root}"`, {
      cause,
    });
  });
  const rootStat = await stat(root).catch((cause: unknown) => {
    throw new Error(`Unable to inspect documentation root "${root}"`, {
      cause,
    });
  });
  if (!rootStat.isDirectory()) {
    throw new Error(`Documentation root is not a directory: "${root}"`);
  }

  const candidates = await collectCandidates(root, options);
  candidates.sort((left, right) => compareStrings(left.path, right.path));
  if (candidates.length === 0) {
    throw new Error(`No Markdown or MDX files found under "${root}"`);
  }

  const seenPaths = new Set<string>();
  const seenTargets = new Map<string, string>();
  let totalBytes = 0;
  const revisionEntries: [string, string][] = [];
  const documents: DocumentationSnapshot['documents'] = [];

  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) {
      throw new Error(`Duplicate documentation path: "${candidate.path}"`);
    }
    seenPaths.add(candidate.path);

    const previousPath = seenTargets.get(candidate.absolutePath);
    if (previousPath) {
      throw new Error(
        `Duplicate documentation file target: "${previousPath}" and "${candidate.path}"`,
      );
    }
    seenTargets.set(candidate.absolutePath, candidate.path);

    const content = await readMarkdownFile(
      candidate,
      options,
      options.maxTotalBytes - totalBytes,
    );
    totalBytes += content.byteLength;
    if (totalBytes > options.maxTotalBytes) {
      throw new Error(
        `Documentation snapshot exceeds maxTotalBytes (${options.maxTotalBytes})`,
      );
    }

    const sourceLocation = pathToFileURL(candidate.absolutePath).href;
    revisionEntries.push([candidate.path, content.contentHash]);
    documents.push({
      id: candidate.path,
      version: options.version,
      path: candidate.path,
      canonicalUrl: sourceLocation,
      sourceLocation,
      markdown: content.markdown,
    });
  }

  const revision = createHash('sha256')
    .update(JSON.stringify(revisionEntries), 'utf8')
    .digest('hex');

  return DocumentationSnapshotSchema.parse({
    version: options.version,
    source: { kind: 'local', root, revision },
    documents,
  });
}

async function collectCandidates(
  root: string,
  options: z.output<typeof discoveryOptionsSchema>,
): Promise<FileCandidate[]> {
  const directories: DirectoryCandidate[] = [
    { path: '', absolutePath: root, depth: 0 },
  ];
  const visitedDirectories = new Set([root]);
  const candidates: FileCandidate[] = [];
  let visitedEntries = 0;

  while (directories.length > 0) {
    const directory = directories.pop()!;
    const entries = await readDirectory(
      directory.absolutePath,
      options.maxEntries - visitedEntries,
      options.maxEntries,
    );
    visitedEntries += entries.length;
    entries.sort((left, right) => compareStrings(left.name, right.name));

    const childDirectories: DirectoryCandidate[] = [];
    for (const entry of entries) {
      if (entry.name.includes('\\')) {
        throw new Error(
          `Documentation path cannot be represented portably: "${entry.name}"`,
        );
      }

      const path = directory.path
        ? `${directory.path}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        const target = await resolveWithinRoot(
          join(directory.absolutePath, entry.name),
          root,
          path,
        );
        const targetStat = await stat(target).catch((cause: unknown) => {
          throw new Error(`Unable to inspect documentation path "${path}"`, {
            cause,
          });
        });
        if (targetStat.isDirectory()) {
          addDirectoryCandidate(
            childDirectories,
            visitedDirectories,
            { path, absolutePath: target, depth: directory.depth + 1 },
            options,
          );
        } else if (
          targetStat.isFile() &&
          isIncludedFile(path, options.include, options.exclude)
        ) {
          addFileCandidate(candidates, path, target, options.maxFiles);
        }
        continue;
      }

      const absolutePath = join(directory.absolutePath, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDirectory(path, options.exclude)) continue;
        const target = await resolveWithinRoot(absolutePath, root, path);
        addDirectoryCandidate(
          childDirectories,
          visitedDirectories,
          { path, absolutePath: target, depth: directory.depth + 1 },
          options,
        );
      } else if (
        entry.isFile() &&
        isIncludedFile(path, options.include, options.exclude)
      ) {
        const target = await resolveWithinRoot(absolutePath, root, path);
        addFileCandidate(candidates, path, target, options.maxFiles);
      }
    }

    // Stack traversal visits directory entries in lexical order.
    directories.push(...childDirectories.reverse());
  }

  return candidates;
}

function addDirectoryCandidate(
  directories: DirectoryCandidate[],
  visitedDirectories: Set<string>,
  candidate: DirectoryCandidate,
  options: z.output<typeof discoveryOptionsSchema>,
): void {
  if (isExcludedDirectory(candidate.path, options.exclude)) return;
  if (visitedDirectories.has(candidate.absolutePath)) return;
  if (candidate.depth > options.maxDepth) {
    throw new Error(
      `Documentation discovery exceeds maxDepth (${options.maxDepth}) at "${candidate.path}"`,
    );
  }
  visitedDirectories.add(candidate.absolutePath);
  directories.push(candidate);
}

function addFileCandidate(
  candidates: FileCandidate[],
  path: string,
  absolutePath: string,
  maxFiles: number,
): void {
  if (candidates.length >= maxFiles) {
    throw new Error(`Documentation discovery exceeds maxFiles (${maxFiles})`);
  }
  candidates.push({ path, absolutePath });
}

async function readDirectory(
  directory: string,
  remainingEntries: number,
  maxEntries: number,
): Promise<Dirent[]> {
  const handle = await opendir(directory).catch((cause: unknown) => {
    throw new Error(`Unable to read documentation directory "${directory}"`, {
      cause,
    });
  });
  const entries: Dirent[] = [];
  try {
    for await (const entry of handle) {
      if (entries.length >= remainingEntries) {
        throw new Error(
          `Documentation discovery exceeds maxEntries (${maxEntries})`,
        );
      }
      entries.push(entry);
    }
  } finally {
    await handle.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  return entries;
}

async function resolveWithinRoot(
  path: string,
  root: string,
  displayPath: string,
): Promise<string> {
  const target = await realpath(path).catch((cause: unknown) => {
    throw new Error(`Unable to resolve documentation path "${displayPath}"`, {
      cause,
    });
  });
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(
      `Documentation path "${displayPath}" resolves outside configured root`,
    );
  }
  return target;
}

function isIncludedFile(
  path: string,
  include: string[],
  exclude: string[],
): boolean {
  if (!/\.mdx?$/u.test(path)) return false;
  return matchesAny(path, include) && !matchesAny(path, exclude);
}

function isExcludedDirectory(path: string, exclude: string[]): boolean {
  return exclude.some(
    (pattern) =>
      matchesPattern(path, pattern) ||
      matchesPattern(`${path}/${DIRECTORY_PROBE}`, pattern),
  );
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(path, pattern));
}

function matchesPattern(path: string, pattern: string): boolean {
  try {
    return posixPath.matchesGlob(path, pattern);
  } catch (cause) {
    throw new Error(`Invalid documentation pattern "${pattern}"`, { cause });
  }
}

async function readMarkdownFile(
  candidate: FileCandidate,
  options: z.output<typeof discoveryOptionsSchema>,
  remainingTotalBytes: number,
): Promise<{ byteLength: number; contentHash: string; markdown: string }> {
  const handle = await open(candidate.absolutePath, 'r').catch(
    (cause: unknown) => {
      throw new Error(`Unable to read documentation file "${candidate.path}"`, {
        cause,
      });
    },
  );
  try {
    const info = await handle.stat().catch((cause: unknown) => {
      throw new Error(
        `Unable to inspect documentation file "${candidate.path}"`,
        { cause },
      );
    });
    if (!info.isFile()) {
      throw new Error(
        `Documentation path is no longer a regular file: "${candidate.path}"`,
      );
    }
    await verifyDiscoveredFilePath(candidate, info);
    if (info.size > options.maxFileBytes) {
      throw new Error(
        `Documentation file "${candidate.path}" exceeds maxFileBytes (${options.maxFileBytes})`,
      );
    }
    if (info.size > remainingTotalBytes) {
      throw new Error(
        `Documentation snapshot exceeds maxTotalBytes (${options.maxTotalBytes}) at "${candidate.path}"`,
      );
    }

    const buffer = Buffer.allocUnsafe(options.maxFileBytes + 1);
    let byteLength = 0;
    while (byteLength < buffer.length) {
      const length = Math.min(READ_CHUNK_BYTES, buffer.length - byteLength);
      const result = await handle
        .read(buffer, byteLength, length, byteLength)
        .catch((cause: unknown) => {
          throw new Error(
            `Unable to read documentation file "${candidate.path}"`,
            { cause },
          );
        });
      if (result.bytesRead === 0) break;
      byteLength += result.bytesRead;
    }
    if (byteLength > options.maxFileBytes) {
      throw new Error(
        `Documentation file "${candidate.path}" exceeds maxFileBytes (${options.maxFileBytes})`,
      );
    }
    if (byteLength > remainingTotalBytes) {
      throw new Error(
        `Documentation snapshot exceeds maxTotalBytes (${options.maxTotalBytes}) at "${candidate.path}"`,
      );
    }
    await verifyDiscoveredFilePath(candidate, info);
    const bytes = buffer.subarray(0, byteLength);
    return {
      byteLength,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      markdown: bytes.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

async function verifyDiscoveredFilePath(
  candidate: FileCandidate,
  openedFile: { dev: number; ino: number },
): Promise<void> {
  const currentPath = await realpath(candidate.absolutePath).catch(
    (cause: unknown) => {
      throw new Error(
        `Documentation file path changed during discovery: "${candidate.path}"`,
        { cause },
      );
    },
  );
  if (currentPath !== candidate.absolutePath) {
    throw new Error(
      `Documentation file path changed during discovery: "${candidate.path}"`,
    );
  }
  const currentFile = await stat(currentPath).catch((cause: unknown) => {
    throw new Error(`Unable to verify documentation file "${candidate.path}"`, {
      cause,
    });
  });
  if (
    currentFile.dev !== openedFile.dev ||
    currentFile.ino !== openedFile.ino
  ) {
    throw new Error(
      `Documentation file path changed during discovery: "${candidate.path}"`,
    );
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
