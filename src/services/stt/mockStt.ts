import type { ProviderInfo } from '../types';
import type { SttHandlers, SttProvider, SttSession } from './types';

const INFO: ProviderInfo = {
  id: 'mock',
  label: 'Scripted test transcript',
  kind: 'mock',
  note: 'Replays a fixed sentence. Nothing is recorded and no speech is recognised.',
};

/**
 * A scripted stand-in for speech recognition, used to exercise the pipeline
 * where no engine exists.
 *
 * It is never selected automatically. The user has to choose it on the Voice
 * screen, and while it is active the interface labels every transcript as
 * scripted, so its output cannot be mistaken for something that was heard.
 */
export function createMockStt(script: string): SttProvider {
  return {
    info: INFO,
    isSupported: () => true,

    start: async (handlers: SttHandlers): Promise<SttSession> => {
      const words = script.split(' ');
      let index = 0;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const step = () => {
        if (cancelled) return;
        index += 1;
        if (index < words.length) {
          handlers.onInterim(words.slice(0, index).join(' '));
          timer = setTimeout(step, 110);
        } else {
          handlers.onFinal(script);
          handlers.onEnd();
        }
      };
      timer = setTimeout(step, 180);

      const clear = () => {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };

      return {
        stop: () => {
          if (cancelled) return;
          clear();
          handlers.onFinal(words.slice(0, Math.max(index, 1)).join(' '));
          handlers.onEnd();
        },
        abort: () => {
          clear();
          handlers.onEnd();
        },
      };
    },
  };
}
