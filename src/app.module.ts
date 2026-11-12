import { Module } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'nestjs-docs-mcp',
      version: '0.0.1',
    }),
  ],
})
export class AppModule {}
