import { NO_PROVIDER, type ProviderInfo } from '../types';

export interface TtsProvider {
  readonly info: ProviderInfo;
  isSupported: () => boolean;
  speak: (text: string) => Promise<void>;
  cancel: () => void;
}

const INFO: ProviderInfo = {
  id: 'web-speech-synthesis',
  label: 'Browser speech synthesis',
  kind: 'real',
  note: 'Speaks replies with a voice installed on this device.',
};

/** Real text-to-speech through the browser's own synthesiser. */
export const webSpeechTts: TtsProvider = {
  info: INFO,

  isSupported: () =>
    typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,

  speak: (text: string) =>
    new Promise<void>((resolve) => {
      if (!webSpeechTts.isSupported() || !text.trim()) {
        resolve();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = navigator.language || 'en-US';
      utterance.rate = 1.02;
      // Resolve on error too: a failed spoken reply must not stall the flow.
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    }),

  cancel: () => {
    if (webSpeechTts.isSupported()) window.speechSynthesis.cancel();
  },
};

export const silentTts: TtsProvider = {
  info: NO_PROVIDER('No speech output', 'This device has no speech synthesiser, so replies are shown as text only.'),
  isSupported: () => false,
  speak: async () => undefined,
  cancel: () => undefined,
};

export function selectTts(): TtsProvider {
  return webSpeechTts.isSupported() ? webSpeechTts : silentTts;
}
