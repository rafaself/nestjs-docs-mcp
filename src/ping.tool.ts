import { Injectable } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';

@Injectable()
export class PingTool {
  @Tool({
    name: 'ping',
    description:
      'Verify MCP connectivity. Returns pong without accessing external services or changing state.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  ping(): string {
    return 'pong';
  }
}
