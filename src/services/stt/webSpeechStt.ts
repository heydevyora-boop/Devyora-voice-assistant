import type { ProviderInfo } from '../types';
import { SttError, type SttErrorCode, type SttHandlers, type SttProvider, type SttSession } from './types';

/* The Web Speech API is not in lib.dom for every TS version, so the shapes
   this adapter relies on are declared locally rather than cast to `any`. */
interface SpeechRecognitionAlternativeLike { transcript: string; confidence: number }
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike { readonly error: string; readonly message?: string }
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Map the spec's error strings onto our codes. */
function mapError(raw: string): SttErrorCode {
  switch (raw) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'permission-denied';
    case 'audio-capture':
      return 'audio-capture';
    case 'no-speech':
      return 'no-speech';
    case 'network':
      return 'network';
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

const INFO: ProviderInfo = {
  id: 'web-speech',
  label: 'Browser speech recognition',
  kind: 'real',
  note: 'Uses the Web Speech API. On Chrome and Edge this sends audio to Google for transcription.',
};

/**
 * Real speech-to-text through the browser's own engine.
 *
 * Nothing here synthesises text: if the engine returns no result, the session
 * ends with `no-speech` rather than a transcript.
 */
export const webSpeechStt: SttProvider = {
  info: INFO,

  isSupported: () => getCtor() !== null,

  // Starting the engine is synchronous; the contract is a promise so a
  // network-backed provider can slot in unchanged.
  start: (handlers: SttHandlers): Promise<SttSession> => {
    const Ctor = getCtor();
    if (!Ctor) throw new SttError('not-supported', 'No speech recognition engine in this browser.');

    const recognition = new Ctor();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let settled = false;
    let aborted = false;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          settled = true;
          handlers.onFinal(text.trim());
        } else {
          interim += text;
        }
      }
      if (interim) handlers.onInterim(interim.trim());
    };

    recognition.onerror = (event) => {
      if (aborted && event.error === 'aborted') return;
      handlers.onError(new SttError(mapError(event.error), event.message || event.error));
    };

    recognition.onend = () => {
      // The engine can end without ever producing a final result.
      if (!settled && !aborted) handlers.onError(new SttError('no-speech', 'No speech was recognised.'));
      handlers.onEnd();
    };

    try {
      recognition.start();
    } catch (cause) {
      throw new SttError('unknown', cause instanceof Error ? cause.message : 'Could not start listening.');
    }

    return Promise.resolve({
      stop: () => recognition.stop(),
      abort: () => {
        aborted = true;
        recognition.abort();
      },
    });
  },
};
