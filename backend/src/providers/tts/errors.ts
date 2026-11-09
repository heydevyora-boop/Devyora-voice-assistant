import { ProviderError, type ProviderErrorCode, type ProviderErrorOptions } from '../shared/errors';

export { codeForStatus } from '../shared/errors';

export type TtsErrorCode = ProviderErrorCode;

/**
 * Speech-synthesis failures.
 *
 * Every one of these is non-fatal by design. A spoken reply is an
 * enhancement; the text reply is the product. Callers catch these and carry
 * on — see `TtsService.synthesize`, which returns a result object rather
 * than throwing.
 */
export class TtsError extends ProviderError {
  constructor(
    code: TtsErrorCode,
    providerId: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(code, providerId, message, options);
  }
}
