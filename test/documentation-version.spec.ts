import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { parseDocumentationVersion } from '../src/documentation-version.js';
import { DocumentationSearchService } from '../src/search/search.service.js';
import { searchDatabasePath } from '../src/search/search.constants.js';

describe('documentation version configuration', () => {
  it('defaults to v12 and accepts only supported majors', () => {
    expect(parseDocumentationVersion(undefined)).toBe(12);
    expect(parseDocumentationVersion('11')).toBe(11);
    expect(parseDocumentationVersion('12')).toBe(12);
  });

  it.each(['', '10', '13', ' 11', '12 '])(
    'rejects unsupported NESTJS_VERSION value %j',
    (value) => {
      expect(() => parseDocumentationVersion(value)).toThrow('NESTJS_VERSION');
    },
  );

  it('validates startup configuration and captures one immutable major', async () => {
    const previousVersion = process.env.NESTJS_VERSION;
    let app:
      | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
      | undefined;
    try {
      process.env.NESTJS_VERSION = '13';
      expect(() => AppModule.register(':memory:')).toThrow('NESTJS_VERSION');

      process.env.NESTJS_VERSION = '11';
      app = await NestFactory.createApplicationContext(
        AppModule.register(searchDatabasePath(11)),
        { logger: false },
      );
      process.env.NESTJS_VERSION = '12';

      expect(app.get(DocumentationSearchService).documentationVersion).toBe(11);
    } finally {
      await app?.close();
      if (previousVersion === undefined) delete process.env.NESTJS_VERSION;
      else process.env.NESTJS_VERSION = previousVersion;
    }
  });
});
