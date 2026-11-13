import {
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { jest } from '@jest/globals';
import { AppModule } from '../../src/app.module.js';
import { McpTimingInterceptor } from '../../src/mcp/timing.interceptor.js';
import { lastValueFrom, NEVER, of, throwError } from 'rxjs';

describe('MCP timing interceptor', () => {
  const originalDebug = process.env.DEBUG;
  let log: jest.SpiedFunction<Logger['log']>;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
  });

  it('registers globally only when DEBUG is exactly 1', () => {
    for (const debugValue of [undefined, '0', 'true']) {
      if (debugValue === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = debugValue;

      expect(AppModule.register().providers).not.toContainEqual({
        provide: APP_INTERCEPTOR,
        useClass: McpTimingInterceptor,
      });
    }

    process.env.DEBUG = '1';
    expect(AppModule.register().providers).toContainEqual({
      provide: APP_INTERCEPTOR,
      useClass: McpTimingInterceptor,
    });
  });

  it('logs successful MCP call kind, name, and elapsed time', async () => {
    const result = await lastValueFrom(
      new McpTimingInterceptor().intercept(
        createExecutionContext(),
        createCallHandler(() => of('result')),
      ),
    );

    expect(result).toBe('result');
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^MCP tool search_docs success in \d+ ms$/u),
    );
  });

  it('logs errors without including their details', async () => {
    const result = lastValueFrom(
      new McpTimingInterceptor().intercept(
        createExecutionContext(),
        createCallHandler(() =>
          throwError(() => new Error('private failure detail')),
        ),
      ),
    );

    await expect(result).rejects.toThrow('private failure detail');
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^MCP tool search_docs error in \d+ ms$/u),
    );
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining('private failure detail'),
    );
  });

  it('logs cancellation when an MCP call is unsubscribed', () => {
    const subscription = new McpTimingInterceptor()
      .intercept(
        createExecutionContext(),
        createCallHandler(() => NEVER),
      )
      .subscribe();

    subscription.unsubscribe();

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^MCP tool search_docs cancelled in \d+ ms$/u),
    );
  });

  it('passes through non-MCP contexts without logging', async () => {
    const result = await lastValueFrom(
      new McpTimingInterceptor().intercept(
        createExecutionContext('http'),
        createCallHandler(() => of('http result')),
      ),
    );

    expect(result).toBe('http result');
    expect(log).not.toHaveBeenCalled();
  });
});

function createExecutionContext(type = 'mcp'): ExecutionContext {
  return {
    getArgs: () => [{}, { kind: 'tool', name: 'search_docs' }],
    getClass: () => undefined,
    getHandler: () => undefined,
    getType: () => type,
  } as unknown as ExecutionContext;
}

function createCallHandler(
  createResult: () => ReturnType<CallHandler['handle']>,
) {
  return { handle: createResult };
}
