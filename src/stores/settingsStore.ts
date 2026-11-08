import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SttChoice = 'browser' | 'scripted';

interface SettingsStore {
  /** Which speech source to use. `scripted` is an explicit opt-in for testing. */
  sttChoice: SttChoice;
  /** Script replayed by the scripted source. */
  scriptedPhrase: string;
  /** Speak replies aloud when a synthesiser exists. */
  speakReplies: boolean;
  /** Seconds a pending confirmation stays open. 0 disables the timeout. */
  confirmTimeoutSeconds: number;

  setSttChoice: (choice: SttChoice) => void;
  setScriptedPhrase: (phrase: string) => void;
  setSpeakReplies: (on: boolean) => void;
  setConfirmTimeoutSeconds: (seconds: number) => void;
}

export const DEFAULT_SCRIPT = 'Send a WhatsApp message to Rahul saying I will reach in 10 minutes';

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      sttChoice: 'browser',
      scriptedPhrase: DEFAULT_SCRIPT,
      speakReplies: true,
      confirmTimeoutSeconds: 90,

      setSttChoice: (sttChoice) => set({ sttChoice }),
      setScriptedPhrase: (scriptedPhrase) => set({ scriptedPhrase }),
      setSpeakReplies: (speakReplies) => set({ speakReplies }),
      setConfirmTimeoutSeconds: (confirmTimeoutSeconds) => set({ confirmTimeoutSeconds }),
    }),
    {
      name: 'devyora.settings',
      version: 1,
      // Browser storage can be unavailable or cleared; the defaults above
      // must always be enough on their own.
      storage: {
        getItem: (name) => {
          try {
            const raw = localStorage.getItem(name);
            return raw ? (JSON.parse(raw) as never) : null;
          } catch {
            return null;
          }
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, JSON.stringify(value));
          } catch {
            /* storage unavailable — settings stay in memory for this session */
          }
        },
        removeItem: (name) => {
          try {
            localStorage.removeItem(name);
          } catch {
            /* nothing to do */
          }
        },
      },
    },
  ),
);
