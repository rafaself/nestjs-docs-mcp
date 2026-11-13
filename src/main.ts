import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { McpStdioLogger, McpStdioServer } from '@nestjs/mcp';
import { AppModule } from './app.module.js';

const logger = new McpStdioLogger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.register(), {
    logger,
    abortOnError: false,
  });

  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  try {
    await app.get(McpStdioServer).listen();
  } finally {
    await app.close();
  }
}

bootstrap().catch((error: unknown) => {
  logger.error(error);
  process.exitCode = 1;
});
