import { z } from 'zod';
import { DocumentationVersionSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import { DocumentationDiscoverySettingsSchema } from '@nestjs-docs/documentation-engine/infrastructure/filesystem/documentation-discovery.js';

const directoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((path) => !path.includes('\0'), 'Paths cannot contain null bytes');

const routePrefixSchema = z
  .string()
  .trim()
  .transform((prefix) =>
    prefix.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, ''),
  )
  .refine(
    (prefix) =>
      prefix === '' ||
      (!prefix.includes('\0') &&
        !/[?#]/u.test(prefix) &&
        prefix
          .split('/')
          .every((segment) => segment && segment !== '.' && segment !== '..')),
    'Route prefixes must contain only relative path segments',
  );

const routeMappingSchema = z.strictObject({
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, 'Route baseUrl must be an HTTP(S) URL without credentials, query, or fragment'),
  pathPrefix: routePrefixSchema.default(''),
  indexFileNames: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .regex(/^[^/\\.]+$/u),
    )
    .min(1)
    .default(['index', 'readme']),
});

export const DocumentationBuildConfigSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u),
  version: DocumentationVersionSchema,
  inputDirectory: directoryPathSchema,
  discovery: DocumentationDiscoverySettingsSchema.optional(),
  routeMapping: routeMappingSchema,
  outputDirectory: directoryPathSchema,
  maxChunkChars: z.number().int().min(1).max(1_000_000).default(4000),
});

export type DocumentationBuildConfig = z.output<
  typeof DocumentationBuildConfigSchema
>;
