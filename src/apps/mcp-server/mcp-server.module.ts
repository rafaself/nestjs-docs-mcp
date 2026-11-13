import { DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { parseDocumentationVersion } from '../../modules/documentation/domain/documentation-version.js';
import { DocumentationMcpModule } from '../../modules/documentation/mcp/documentation-mcp.module.js';
import { McpTimingInterceptor } from '../../modules/documentation/mcp/timing.interceptor.js';
import { searchDatabasePath } from '../../modules/documentation/infrastructure/sqlite/index-paths.js';
import { resolveMcpAllowedHosts } from './allowed-hosts.js';

@Module({})
export class McpServerModule {
  static register(databasePath?: string): DynamicModule {
    const documentationVersion = parseDocumentationVersion(
      process.env.NESTJS_VERSION,
    );
    const resolvedDatabasePath =
      databasePath ??
      process.env.NESTJS_DOCS_SEARCH_DB ??
      searchDatabasePath(documentationVersion);
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
          documentationVersion,
          resolveMcpAllowedHosts(),
        ),
      ],
      providers,
    };
  }
}
