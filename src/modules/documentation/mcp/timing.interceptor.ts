import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { McpExecutionContext, type McpContextType } from '@nestjs/mcp';
import { finalize, tap, type Observable } from 'rxjs';

type CallOutcome = 'success' | 'error' | 'cancelled';

@Injectable()
export class McpTimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(McpTimingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<McpContextType>() !== 'mcp') return next.handle();

    const mcpContext = McpExecutionContext.create(context);
    const startedAt = performance.now();
    let outcome: CallOutcome = 'cancelled';

    return next.handle().pipe(
      tap({
        complete: () => {
          outcome = 'success';
        },
        error: () => {
          outcome = 'error';
        },
      }),
      finalize(() => {
        const elapsedMilliseconds = Math.round(performance.now() - startedAt);
        this.logger.log(
          `MCP ${mcpContext.getKind() ?? 'call'} ${mcpContext.getName() ?? 'unknown'} ${outcome} in ${elapsedMilliseconds} ms`,
        );
      }),
    );
  }
}
