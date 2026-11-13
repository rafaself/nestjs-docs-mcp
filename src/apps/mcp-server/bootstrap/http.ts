#!/usr/bin/env node
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { McpServerModule } from '../mcp-server.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(McpServerModule.register(), {
    abortOnError: false,
  });

  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  try {
    await app.listen(process.env.PORT ?? 3000, '127.0.0.1');
  } catch (error) {
    await app.close();
    throw error;
  }
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start documentation MCP over HTTP:', error);
  process.exitCode = 1;
});
