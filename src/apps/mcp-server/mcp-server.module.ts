import { DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { accessSync, constants, statSync } from 'node:fs';
import { DocumentationMcpModule } from '../../modules/documentation/mcp/documentation-mcp.module.js';
import { McpTimingInterceptor } from '../../modules/documentation/mcp/timing.interceptor.js';
import { loadDocumentationIndexManifest } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/documentation-index-manifest.js';
import { resolveMcpAllowedHosts } from './allowed-hosts.js';

@Module({})
export class McpServerModule {
  static register(databasePath?: string, manifestPath?: string): DynamicModule {
    const resolvedDatabasePath =
      databasePath ?? process.env.DOCUMENTATION_INDEX_PATH;
    if (!resolvedDatabasePath) {
      throw new Error(
        'DOCUMENTATION_INDEX_PATH is required and must name an existing SQLite index',
      );
    }
    assertReadableIndexFile(resolvedDatabasePath);
    const resolvedManifestPath =
      manifestPath ?? process.env.DOCUMENTATION_INDEX_MANIFEST_PATH;
    const indexManifest = loadDocumentationIndexManifest(
      resolvedDatabasePath,
      resolvedManifestPath,
    );
    const providers: Provider[] = [];

    if (process.env.DEBUG === '1') {
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: McpTimingInterceptor,
      });
    }

    return {
      module: McpServerModule,
      imports: [
        DocumentationMcpModule.register(
          resolvedDatabasePath,
          indexManifest,
          resolveMcpAllowedHosts(),
        ),
      ],
      providers,
    };
  }
}

function assertReadableIndexFile(databasePath: string): void {
  try {
    if (!statSync(databasePath).isFile()) {
      throw new Error('path is not a regular file');
    }
    accessSync(databasePath, constants.R_OK);
  } catch (error) {
    throw new Error(
      `Documentation index is missing or unreadable: "${databasePath}"`,
      { cause: error },
    );
  }
}
