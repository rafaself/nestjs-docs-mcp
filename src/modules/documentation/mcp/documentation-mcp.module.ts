import { DynamicModule, Module } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';
import type { DocumentationIndexRuntimeManifest } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
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
    indexManifest: DocumentationIndexRuntimeManifest,
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
            'This server reads one validated documentation index, fixed at startup. Use search_docs, then fetch_docs with a returned document ID for more detail. Continue truncated results with the same ID and cursor. Ground answers in returned content and cite its source URL and revision.',
          http: {
            allowedHosts,
          },
        }),
        DocumentationModule.register(databasePath, indexManifest),
      ],
      providers: [DocumentationTools],
    };
  }
}
