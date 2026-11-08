import { localStore } from '@/services/actions/localExecutor';
import { integrationById } from './registry';
import { ConnectionError, type ConnectionState, type ConnectionsProvider } from './types';

/**
 * The connections provider for a build with no integration backend.
 *
 * It reports exactly two kinds of truth:
 *
 *  - Notes is `local`, because its capabilities genuinely run on this device
 *    and can be verified by reading the stored items back.
 *  - Everything else is `not-connected`, because no OAuth flow has happened
 *    and no service has confirmed otherwise.
 *
 * `connect` deliberately cannot succeed. Showing a switch that flips to
 * "connected" without an authorisation behind it would be a lie the rest of
 * the interface would then repeat, so the attempt fails with the reason.
 */
export const localConnectionsProvider: ConnectionsProvider = {
  id: 'none',
  configured: false,
  unavailableReason:
    'No integration service is configured for this build. Linking an account needs an OAuth backend that holds the tokens — a browser must never store them.',

  state: (appId: string): ConnectionState => {
    if (appId === 'notes') {
      const notes = localStore.notes().length;
      const reminders = localStore.reminders().length;
      const parts = [
        notes === 1 ? '1 note' : `${notes} notes`,
        reminders === 1 ? '1 reminder' : `${reminders} reminders`,
      ];
      return { status: 'local', detail: `On this device · ${parts.join(' · ')}` };
    }

    const app = integrationById(appId);
    const assisted = app?.capabilities.some((c) => c.mode === 'assisted') ?? false;
    return {
      status: 'not-connected',
      detail: assisted
        ? 'No account linked. Hand-off actions work without one.'
        : 'No account linked.',
    };
  },

  connect: async (appId: string): Promise<ConnectionState> => {
    const app = integrationById(appId);
    throw new ConnectionError(
      'no-service',
      `Linking ${app?.name ?? 'this application'} needs an OAuth backend. None is configured, so nothing was connected.`,
    );
  },

  disconnect: async (appId: string): Promise<ConnectionState> =>
    localConnectionsProvider.state(appId),
};

export function selectConnectionsProvider(): ConnectionsProvider {
  // A real provider would be chosen here once a backend exists.
  return localConnectionsProvider;
}
