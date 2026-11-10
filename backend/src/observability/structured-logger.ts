import type { LoggerService } from '@nestjs/common';
import { RequestContext } from './request-context.js';

type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

/** Emite logs JSON sem anexar stack traces ou payloads das requisições. */
export class StructuredLogger implements LoggerService {
  constructor(private readonly requestContext: RequestContext) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  info(event: string, fields: Record<string, string | number>): void {
    this.emit('info', event, fields);
  }

  private write(
    level: Exclude<LogLevel, 'log'> | 'info',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const context = optionalParams.find(
      (value): value is string => typeof value === 'string',
    );
    this.emit(level, 'nestjs_log', {
      message: this.safeMessage(message),
      ...(context ? { context } : {}),
    });
  }

  private emit(
    level: string,
    event: string,
    fields: Record<string, string | number>,
  ): void {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(this.requestContext.correlationId
        ? { correlationId: this.requestContext.correlationId }
        : {}),
      ...fields,
    };
    const output = `${JSON.stringify(record)}\n`;
    if (level === 'error' || level === 'fatal') {
      process.stderr.write(output);
      return;
    }
    process.stdout.write(output);
  }

  private safeMessage(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.name;
    return typeof message;
  }
}
