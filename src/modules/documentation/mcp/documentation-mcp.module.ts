import { DynamicModule, Module } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';
import type { NestJsDocumentationVersion } from '../domain/documentation-version.js';
import { DocumentationModule } from '../documentation.module.js';
import { DocumentationTools } from './documentation.tools.js';
import {
  PACKAGE_DESCRIPTION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from '../../../shared/config/package-metadata.js';

@Module({})
export class DocumentationMcpModule {
  static register(
    databasePath: string,
    documentationVersion: NestJsDocumentationVersion,
    allowedHosts: string[],
  ): DynamicModule {
    return {
      module: DocumentationMcpModule,
      imports: [
        McpModule.forRoot({
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          description: PACKAGE_DESCRIPTION,
          instructions:
            'Search the documentation version selected for this server; the version is fixed at startup. Use search_docs first, then fetch_docs with the returned IDs for more detail. Continue truncated results with the same IDs and returned cursor. Ground answers in the returned content and cite its URL and source revision; these indexes are snapshots, not live documentation.',
          http: {
            allowedHosts,
          },
        }),
        DocumentationModule.register(databasePath, documentationVersion),
      ],
      providers: [DocumentationTools],
    };
  }
}
