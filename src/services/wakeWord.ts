import { capabilities } from '@/platform/capabilities';
import { NO_PROVIDER, type ProviderInfo } from './types';

export type WakeWordStatus =
  /** No engine exists in this build for this platform. */
  | 'unavailable'
  /** An engine could run here, but the user has not enabled it. */
  | 'available-off'
  /** Enabled and armed. */
  | 'armed';

export interface WakeWordProvider {
  readonly info: ProviderInfo;
  readonly phrase: string;
  status: () => WakeWordStatus;
  /** Resolves to the status actually reached, never to an assumed one. */
  arm: () => Promise<WakeWordStatus>;
  disarm: () => void;
}

/**
 * Wake-word readiness.
 *
 * Deliberately not implemented in the frontend. A browser `getUserMedia` loop
 * that stays open to listen for a phrase would hold the microphone, drain the
 * battery, and stream audio continuously — and it would still not work when
 * the app is closed, which is the only time a wake word is useful.
 *
 * Real detection belongs to an on-device model in the native shell. This
 * provider exposes the contract and reports, honestly, that nothing is
 * listening.
 */
export const unavailableWakeWord: WakeWordProvider = {
  info: NO_PROVIDER(
    'Wake word',
    'No wake-word engine is bundled. Always-on detection needs an on-device model in the native shell, so nothing is listening in the background.',
  ),
  phrase: 'Hey Devyora',
  status: () => 'unavailable',
  arm: () => Promise.resolve<WakeWordStatus>('unavailable'),
  disarm: () => undefined,
};

export function selectWakeWord(): WakeWordProvider {
  // `capabilities.wakeWord` is 'unavailable' until a native shell overrides it.
  return capabilities.wakeWord === 'unavailable' ? unavailableWakeWord : unavailableWakeWord;
}
