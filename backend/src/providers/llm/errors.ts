import { ProviderError, type ProviderErrorCode, type ProviderErrorOptions } from '../shared/errors';

export { codeForStatus } from '../shared/errors';

/**
 * Language-model failures.
 *
 * The vocabulary is shared with the other provider modalities (see
 * `providers/shared/errors.ts`) so retry policy and user-facing wording are
 * written once. This subclass exists so a caller can tell an interpretation
 * failure from a recognition failure by type rather than by string.
 */
export type LlmErrorCode = ProviderErrorCode;

export class LlmError extends ProviderError {
  constructor(
    code: LlmErrorCode,
    providerId: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(code, providerId, message, options);
  }
}
