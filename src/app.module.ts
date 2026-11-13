import { Module } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';
import { PingTool } from './ping.tool.js';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'nestjs-docs-mcp',
      version: '0.0.1',
      path: false,
    }),
  ],
  providers: [PingTool],
})
export class AppModule {}
