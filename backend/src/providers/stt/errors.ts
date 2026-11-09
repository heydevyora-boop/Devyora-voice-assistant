import { ProviderError, type ProviderErrorCode, type ProviderErrorOptions } from '../shared/errors';

export { codeForStatus } from '../shared/errors';

export type SttErrorCode = ProviderErrorCode;

/** Speech-recognition failures. */
export class SttError extends ProviderError {
  constructor(
    code: SttErrorCode,
    providerId: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(code, providerId, message, options);
  }
}
