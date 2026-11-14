import { ConnectionProvider } from '@prisma/client';
import { z } from 'zod';
import {
  findMessagingSurface,
  isUsableAddress,
} from '../../modules/actions/handlers/launch-catalog';
import { IntegrationError } from './errors';
import type {
  ConnectionContext,
  IntegrationCapabilities,
  IntegrationProvider,
  OperationRequest,
  OperationResult,
  ProviderHealth,
} from './types';

const prepareInput = z.object({
  recipient: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5_000),
});

/** Which allow-listed surface each provider maps onto. */
const SURFACE: Partial<Record<ConnectionProvider, string>> = {
  [ConnectionProvider.WHATSAPP]: 'whatsapp',
  [ConnectionProvider.TELEGRAM]: 'telegram',
  [ConnectionProvider.GMAIL]: 'email',
};

/**
 * The user-assisted connector.
 *
 * This is the honest route for the common case: somebody with a personal
 * WhatsApp account who wants the assistant to message a friend. There is no
 * official API for that and no supported way to automate the app on a
 * phone — so instead of pretending, this prepares a draft and the device
 * opens it. The person presses send.
 *
 * Three consequences, all deliberate:
 *
 * **It needs no account.** `requiresConnection` is absent and
 * `supportsOAuth` is false: there is nothing to authorise, because nothing
 * acts on the user's behalf. That is why this works today while the
 * official connectors wait on app review.
 *
 * **Its fidelity is `prepared`, never `accepted`.** A deep link exists. No
 * message does. The result says `sentByServer: false` and names the step
 * the person still has to take.
 *
 * **The link comes from a template.** `launch-catalog.ts` holds the host and
 * path; only the address and the message vary, and both are escaped. There
 * is no path by which a recipient or a message becomes a different
 * destination.
 */
export class AssistedIntegrationProvider implements IntegrationProvider {
  readonly kind = 'user-assisted' as const;
  /** Nothing to configure: no credential, no app registration. */
  readonly configured = true;

  constructor(readonly provider: ConnectionProvider) {}

  capabilities(): IntegrationCapabilities {
    const surfaceId = SURFACE[this.provider];
    const surface = surfaceId ? findMessagingSurface(surfaceId) : null;

    return {
      provider: this.provider,
      label: `${surface?.label ?? this.provider} (assisted)`,
      kind: this.kind,
      configured: Boolean(surface),
      // Nothing is authorised, because nothing acts on the user's behalf.
      supportsOAuth: false,
      supportsRefresh: false,
      supportsRevoke: false,
      operations: surface
        ? [
            {
              operation: 'messages.prepare',
              fidelity: 'prepared',
              scopes: [],
              // The user is about to see the draft, and nothing leaves the
              // account until they act — but the assistant still confirms
              // the text first, because the recipient is a real person.
              requiresConfirmation: true,
              limitations: [
                'Prepares a draft and hands a link to the device. Nothing is sent, and ' +
                  'whether the person pressed send is not observable from here.',
                surface.addressKind === 'phone'
                  ? 'Needs a phone number. A name cannot be resolved without a contact list.'
                  : 'Needs an email address.',
              ],
            },
          ]
        : [],
      limitations: [
        'Works without any account connection, which is why it is available when the ' +
          'official API is not.',
        'The outcome is always "prepared". This connector cannot report a delivery, ' +
          'because it does not perform one.',
      ],
      documentationUrl: null,
    };
  }

  // `async`, not a function returning `Promise.resolve(...)`: every
  // caller of this interface is entitled to assume a rejection, not a
  // thrown exception, when something is wrong — `provider.execute(...)`
  // has to be safe to `.catch()` directly, and a synchronous throw from a
  // non-async function skips that entirely.
  async execute(_context: ConnectionContext, request: OperationRequest): Promise<OperationResult> {
    if (request.operation !== 'messages.prepare') {
      throw new IntegrationError(
        'unsupported',
        this.provider,
        'The assisted connector only prepares messages.',
      );
    }

    const surfaceId = SURFACE[this.provider];
    const surface = surfaceId ? findMessagingSurface(surfaceId) : null;
    if (!surface) {
      throw new IntegrationError(
        'unsupported',
        this.provider,
        `There is no assisted route for ${this.provider}.`,
      );
    }

    const input = prepareInput.parse(request.input);

    // Checked again at the last point before a draft is built for a real
    // person. A check that only runs upstream stops running the moment
    // somebody adds another caller.
    if (!isUsableAddress(input.recipient, surface.addressKind)) {
      throw new IntegrationError(
        'invalid_request',
        this.provider,
        surface.addressKind === 'phone'
          ? 'That does not look like a phone number.'
          : 'That does not look like an email address.',
      );
    }

    return Promise.resolve({
      fidelity: 'prepared',
      detail: `Draft ready in ${surface.label}.`,
      // No provider handle, because no provider was involved.
      providerRef: null,
      data: {
        composeUrl: surface.compose(input.recipient, input.message),
        surface: surface.label,
        sentByServer: false as const,
        remainingStep: `Open ${surface.label} and press send.`,
      },
    });
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({
      provider: this.provider,
      configured: this.configured,
      reachable: null,
      checkedAt: new Date().toISOString(),
      detail: 'Needs no credential; prepares a draft for the device to open.',
    });
  }
}
