import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { AppError, ErrorCode, type AppErrorDetail, type ErrorCodeValue } from '../errors/app-error';
import { requestContext } from '../request-context';

interface Normalised {
  status: number;
  code: ErrorCodeValue;
  message: string;
  details?: AppErrorDetail[];
  /** Logged, never sent. */
  internal?: string;
}

/**
 * The single place an exception becomes a response.
 *
 * Two rules it exists to enforce: every error leaves in the same shape, and
 * nothing a client sees reveals the database, the query or a stack trace —
 * in any environment, so a misconfigured deployment cannot start leaking.
 *
 * HTTP only. A socket has no response to write a status and body to, so a
 * non-HTTP exception is logged and re-thrown for the WebSocket adapter to
 * deal with rather than being half-handled here.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.logger.warn(
        `Unhandled ${host.getType()} exception: ` +
          (exception instanceof Error ? exception.message : 'unknown error'),
      );
      throw exception;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const normalised = this.normalise(exception);
    const correlationId = requestContext.correlationId();

    // `originalUrl` is what the client actually requested; `url` has had the
    // global prefix stripped by the mount and would mislead anyone reading it.
    const path = request.originalUrl ?? request.url;

    const logPayload = {
      correlationId,
      path,
      method: request.method,
      status: normalised.status,
      code: normalised.code,
      internal: normalised.internal,
    };

    if (normalised.status >= 500) {
      this.logger.error(logPayload, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(logPayload);
    }

    response.status(normalised.status).json({
      success: false,
      code: normalised.code,
      message: normalised.message,
      statusCode: normalised.status,
      ...(normalised.details ? { details: normalised.details } : {}),
      timestamp: new Date().toISOString(),
      correlationId,
      path,
    });
  }

  private normalise(exception: unknown): Normalised {
    if (exception instanceof AppError) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'A required service is unavailable. Please try again shortly.',
        internal: exception.message,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      // Deliberately generic: an unexpected failure must not describe itself
      // to a caller. The detail goes to the log with the correlation id.
      message: 'Something went wrong. The incident has been logged.',
      internal: exception instanceof Error ? exception.message : String(exception),
    };
  }

  private fromHttpException(exception: HttpException): Normalised {
    const status = exception.getStatus();
    const body = exception.getResponse();

    // Nest's ValidationPipe puts its findings in `message` as a string array.
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const raw = (body as { message: unknown }).message;
      if (Array.isArray(raw)) {
        return {
          status,
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The request is not valid.',
          details: raw.map((m) => this.toDetail(String(m))),
        };
      }
    }

    const byStatus: Partial<Record<number, ErrorCodeValue>> = {
      [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
      [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
      [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
      [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
      [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
      [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
    };

    return {
      status,
      code: byStatus[status] ?? ErrorCode.INTERNAL_ERROR,
      message: status >= 500 ? 'Something went wrong. The incident has been logged.' : exception.message,
    };
  }

  private fromPrisma(exception: Prisma.PrismaClientKnownRequestError): Normalised {
    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          // The constraint name is withheld: it leaks the schema.
          message: 'That value is already in use.',
          internal: `unique constraint: ${JSON.stringify(exception.meta?.target)}`,
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: 'Resource was not found.',
          internal: exception.message,
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'That change conflicts with related data.',
          internal: `foreign key: ${JSON.stringify(exception.meta?.field_name)}`,
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCode.INTERNAL_ERROR,
          message: 'Something went wrong. The incident has been logged.',
          internal: `prisma ${exception.code}: ${exception.message}`,
        };
    }
  }

  /** `class-validator` emits "field must be …"; split off the field name. */
  private toDetail(message: string): AppErrorDetail {
    const [field] = message.split(' ');
    return { field: field ?? 'request', message };
  }
}
