import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';
import { requestContext } from '../request-context';

/**
 * One structured line per completed request.
 *
 * Deliberately records method, route, status and duration only. Bodies and
 * query values can carry a transcript or a message, so they are never logged
 * here.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => this.write(request, context, startedAt),
        error: () => this.write(request, context, startedAt),
      }),
    );
  }

  private write(request: Request, context: ExecutionContext, startedAt: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const { statusCode } = context.switchToHttp().getResponse<{ statusCode: number }>();
    const ctx = requestContext.get();

    // Prefer the matched route pattern over the concrete URL: logging
    // `/notes/:id` keeps ids out of the logs and keeps cardinality low.
    // Express types `route` as `any`, so it is narrowed through `unknown`
    // rather than trusted.
    const route = (request as unknown as { route?: { path?: unknown } }).route;
    const matched = typeof route?.path === 'string' ? route.path : undefined;

    this.logger.log({
      method: request.method,
      route: matched ?? request.url,
      statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      correlationId: ctx?.correlationId,
      userId: ctx?.userId,
    });
  }
}
