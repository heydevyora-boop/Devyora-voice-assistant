import {
  CallHandler,
  ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { ApiSuccessResponse } from '../dto/api-response.dto';
import { RAW_RESPONSE } from '../decorators/raw-response.decorator';
import { Reflector } from '@nestjs/core';
import { requestContext } from '../request-context';

/**
 * Wraps every successful HTTP payload in the standard envelope.
 *
 * Routes that must return something else — a health probe read by a load
 * balancer, a file stream — opt out with `@RawResponse()`.
 *
 * WebSocket handlers are left alone. A socket acknowledgement has its own
 * contract, agreed with the client in `voice-events.ts`, and wrapping it in
 * an HTTP envelope would mean the same reply had two shapes depending on
 * which transport it arrived over.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T> | T> {
    if (context.getType() !== 'http') return next.handle();

    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (raw) return next.handle();

    return next
      .handle()
      .pipe(map((data) => new ApiSuccessResponse(data, requestContext.correlationId())));
  }
}
