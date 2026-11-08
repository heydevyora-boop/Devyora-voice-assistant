import type { ProviderInfo } from '../types';

export type SttErrorCode =
  | 'not-supported'
  | 'permission-denied'
  | 'audio-capture'
  | 'no-speech'
  | 'network'
  | 'aborted'
  | 'unknown';

export class SttError extends Error {
  readonly code: SttErrorCode;
  constructor(code: SttErrorCode, message: string) {
    super(message);
    this.name = 'SttError';
    this.code = code;
  }
}

/** Human-readable copy for each failure, used by the error notice. */
export const STT_ERROR_COPY: Record<SttErrorCode, { title: string; detail: string; retryable: boolean }> = {
  'not-supported': {
    title: 'Speech recognition is unavailable',
    detail: 'This browser has no speech recognition engine. You can type your command instead.',
    retryable: false,
  },
  'permission-denied': {
    title: 'Microphone blocked',
    detail: 'Devyora needs microphone access to listen. Allow it in your browser or system settings, then try again.',
    retryable: true,
  },
  'audio-capture': {
    title: 'No microphone found',
    detail: 'No input device is available. Connect a microphone and try again.',
    retryable: true,
  },
  'no-speech': {
    title: 'Nothing heard',
    detail: 'No speech was detected. Try again, a little closer to the microphone.',
    retryable: true,
  },
  network: {
    title: 'Network unavailable',
    detail: 'Speech recognition could not reach its service. Check your connection and try again.',
    retryable: true,
  },
  aborted: {
    title: 'Listening stopped',
    detail: 'The interaction was cancelled.',
    retryable: true,
  },
  unknown: {
    title: 'Speech recognition failed',
    detail: 'Something went wrong while listening. Try again.',
    retryable: true,
  },
};

export interface SttHandlers {
  /** Partial text while the user is still speaking. */
  onInterim: (text: string) => void;
  /** Settled text for an utterance. */
  onFinal: (text: string) => void;
  onError: (error: SttError) => void;
  /** Fired once the engine has stopped for any reason. */
  onEnd: () => void;
}

export interface SttSession {
  /** Finish gracefully and deliver whatever was recognised. */
  stop: () => void;
  /** Discard the utterance; no final result is delivered. */
  abort: () => void;
}

export interface SttProvider {
  readonly info: ProviderInfo;
  /** True when this provider can actually run in the current host. */
  isSupported: () => boolean;
  start: (handlers: SttHandlers) => Promise<SttSession>;
}
