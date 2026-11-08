import { create } from 'zustand';
import type { CommandPlan, ActionOutcome } from '@/services/actions/types';
import type { Clarification } from '@/services/nlu/types';
import type { SttErrorCode } from '@/services/stt/types';

export type VoiceInputSource = 'speech' | 'typed' | 'scripted';

export interface VoiceError {
  readonly code: SttErrorCode | 'mic' | 'interpret' | 'execute' | 'timeout';
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
}

/**
 * Everything the voice turn knows, except the orb's state.
 *
 * The orb's state machine stays in `orbStore` and is not duplicated here:
 * this store holds the *content* of the current turn, `orbStore` holds the
 * *phase*. `useVoiceSession` is the only thing that writes to both.
 */
interface VoiceStore {
  /** Partial text while the user is still speaking. */
  interim: string;
  /** The settled utterance for this turn. */
  transcript: string;
  transcriptSource: VoiceInputSource | null;
  /**
   * True while the microphone is open.
   *
   * The per-frame amplitudes are NOT held here: they travel on
   * `services/audio/levelBus` straight to the visualiser, because sixty store
   * updates a second would re-render the whole screen for nine transforms.
   */
  micActive: boolean;

  plan: CommandPlan | null;
  clarification: Clarification | null;
  /** Present only after an executor reported what actually happened. */
  outcome: ActionOutcome | null;
  /** Plain-language reason a command could not be handled. */
  unsupported: { heard: string; reason: string } | null;
  error: VoiceError | null;
  /** Deadline for an unanswered confirmation, as an epoch ms timestamp. */
  confirmDeadline: number | null;

  setInterim: (text: string) => void;
  setTranscript: (text: string, source: VoiceInputSource) => void;
  setMicActive: (active: boolean) => void;
  setPlan: (plan: CommandPlan | null) => void;
  setClarification: (c: Clarification | null) => void;
  setOutcome: (outcome: ActionOutcome | null) => void;
  setUnsupported: (u: { heard: string; reason: string } | null) => void;
  setError: (error: VoiceError | null) => void;
  setConfirmDeadline: (at: number | null) => void;
  /** Clear everything for a fresh turn. */
  resetTurn: () => void;
}

const EMPTY = {
  interim: '',
  transcript: '',
  transcriptSource: null,
  micActive: false,
  plan: null,
  clarification: null,
  outcome: null,
  unsupported: null,
  error: null,
  confirmDeadline: null,
} as const;

export const useVoiceStore = create<VoiceStore>((set) => ({
  ...EMPTY,

  setInterim: (interim) => set({ interim }),
  setTranscript: (transcript, transcriptSource) => set({ transcript, transcriptSource, interim: '' }),
  setMicActive: (micActive) => set({ micActive }),
  setPlan: (plan) => set({ plan }),
  setClarification: (clarification) => set({ clarification }),
  setOutcome: (outcome) => set({ outcome }),
  setUnsupported: (unsupported) => set({ unsupported }),
  setError: (error) => set({ error }),
  setConfirmDeadline: (confirmDeadline) => set({ confirmDeadline }),
  resetTurn: () => set({ ...EMPTY }),
}));
