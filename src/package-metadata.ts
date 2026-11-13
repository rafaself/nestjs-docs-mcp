import { createRequire } from 'node:module';
import * as z from 'zod';

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: 'must not be blank',
  });

export const packageMetadataSchema = z.looseObject({
  name: nonBlankStringSchema,
  version: nonBlankStringSchema,
  description: nonBlankStringSchema,
});

const packageMetadata = packageMetadataSchema.parse(
  createRequire(import.meta.url)('../package.json'),
);

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;
export const PACKAGE_DESCRIPTION = packageMetadata.description;
