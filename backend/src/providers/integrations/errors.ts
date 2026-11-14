import { ProviderError, type ProviderErrorCode, type ProviderErrorOptions } from '../shared/errors';
import type { ConnectionProvider } from '@prisma/client';

export { codeForStatus } from '../shared/errors';

/**
 * Integration failures.
 *
 * Extends the shared vocabulary with two codes that only mean something
 * here, and that callers genuinely need to tell apart:
 *
 * `unsupported` — the provider does not do this at all. Not a failure to
 * retry; a capability that does not exist. The honest answer is to say so,
 * which is why it is distinct from `invalid_request`.
 *
 * `scope_missing` — the provider does it, but this connection was not
 * granted the access. The fix is a reconnection with wider consent, not a
 * retry, and the user needs to be told which.
 */
export type IntegrationErrorCode = ProviderErrorCode | 'unsupported' | 'scope_missing';

export class IntegrationError extends ProviderError {
  readonly integrationCode: IntegrationErrorCode;
  readonly provider: ConnectionProvider;

  constructor(
    code: IntegrationErrorCode,
    provider: ConnectionProvider,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    // The shared base only knows its own codes; the two extra ones map onto
    // `invalid_request`, which is non-retryable — correct for both.
    super(
      code === 'unsupported' || code === 'scope_missing' ? 'invalid_request' : code,
      provider,
      message,
      options,
    );
    this.integrationCode = code;
    this.provider = provider;
  }

  /** Whether reconnecting with wider consent would help. */
  get needsReauthorisation(): boolean {
    return this.integrationCode === 'scope_missing' || this.integrationCode === 'auth';
  }
}
