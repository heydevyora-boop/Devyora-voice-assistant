import { ProviderError, type ProviderErrorCode, type ProviderErrorOptions } from '../shared/errors';

export { codeForStatus } from '../shared/errors';

export type PushErrorCode = ProviderErrorCode;

/** Push delivery failures. */
export class PushError extends ProviderError {
  constructor(
    code: PushErrorCode,
    providerId: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(code, providerId, message, options);
  }
}

/**
 * Whether a failure means the token is dead.
 *
 * Worth separating from an ordinary failure: a rejected token should be
 * cleared from the device row so nothing keeps trying it, whereas a rate
 * limit should not.
 */
export function isTokenRejection(error: unknown): boolean {
  return (
    error instanceof PushError &&
    (error.code === 'invalid_request' || error.code === 'auth') &&
    (error.status === 400 || error.status === 404 || error.status === 410)
  );
}
