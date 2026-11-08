import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable machine-readable error codes.
 *
 * Clients branch on these, not on HTTP status or message text, so wording can
 * be improved without breaking anyone.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorDetail {
  field: string;
  message: string;
}

/**
 * The error type application code throws.
 *
 * Carrying the code explicitly means the exception filter never has to infer
 * intent from a status number.
 */
export class AppError extends HttpException {
  readonly code: ErrorCodeValue;
  readonly details?: AppErrorDetail[];

  constructor(
    code: ErrorCodeValue,
    message: string,
    status: HttpStatus,
    details?: AppErrorDetail[],
  ) {
    super(message, status);
    this.code = code;
    this.details = details;
  }

  static validation(message: string, details?: AppErrorDetail[]): AppError {
    return new AppError(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }

  static unauthenticated(message = 'Authentication is required.'): AppError {
    return new AppError(ErrorCode.UNAUTHENTICATED, message, HttpStatus.UNAUTHORIZED);
  }

  static forbidden(message = 'You do not have access to this resource.'): AppError {
    return new AppError(ErrorCode.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }

  /**
   * Used for another user's resource as well as a genuinely absent one.
   * Returning 404 rather than 403 avoids confirming that an id exists.
   */
  static notFound(resource = 'Resource'): AppError {
    return new AppError(ErrorCode.NOT_FOUND, `${resource} was not found.`, HttpStatus.NOT_FOUND);
  }

  static conflict(message: string): AppError {
    return new AppError(ErrorCode.CONFLICT, message, HttpStatus.CONFLICT);
  }

  static dependencyUnavailable(message: string): AppError {
    return new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
