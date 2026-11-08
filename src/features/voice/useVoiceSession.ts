import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useOrbStore } from '@/stores/orbStore';
import { useVoiceStore, type VoiceError, type VoiceInputSource } from '@/stores/voiceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { startMicMeter, MicError, type MicMeter } from '@/services/audio/micMeter';
import { publishLevels } from '@/services/audio/levelBus';
import { webSpeechStt } from '@/services/stt/webSpeechStt';
import { createMockStt } from '@/services/stt/mockStt';
import { STT_ERROR_COPY, SttError, type SttProvider, type SttSession } from '@/services/stt/types';
import { ruleInterpreter } from '@/services/nlu/ruleInterpreter';
import type { Clarification } from '@/services/nlu/types';
import { localExecutor } from '@/services/actions/localExecutor';
import { withField, type CommandPlan } from '@/services/actions/types';
import { selectTts } from '@/services/tts';
import { selectWakeWord } from '@/services/wakeWord';
import { WAVEFORM_BAR_COUNT } from './constants';

/** How long to wait for a recogniser to finish after being asked to stop. */
const STOP_GRACE_MS = 6000;

/** A tap this soon after starting is treated as part of the same press. */
const ACTIVATION_GUARD_MS = 600;

const MIC_ERROR_COPY: Record<MicError['code'], { title: string; detail: string; retryable: boolean }> = {
  'not-supported': {
    title: 'Audio capture unavailable',
    detail: 'This browser cannot open a microphone. You can type your command instead.',
    retryable: false,
  },
  'permission-denied': {
    title: 'Microphone blocked',
    detail: 'Devyora needs microphone access to listen. Allow it in your browser or system settings, then try again.',
    retryable: true,
  },
  'audio-capture': {
    title: 'No microphone available',
    detail: 'No working input device was found. Connect a microphone and try again.',
    retryable: true,
  },
  unknown: {
    title: 'Microphone error',
    detail: 'The microphone could not be opened. Try again.',
    retryable: true,
  },
};

/**
 * Orchestrates one voice turn.
 *
 * This hook owns the side effects — microphone, recognition, interpretation,
 * execution, speech output — and translates their real results into events on
 * the existing orb state machine. It adds no second state machine: `orbStore`
 * remains the only place the phase lives, and `voiceStore` holds the content.
 *
 * No step is simulated. The orb advances past `listening` only when the
 * recognition engine delivers text, and past `executing` only when an executor
 * reports what it actually observed.
 */
export function useVoiceSession() {
  const orbState = useOrbStore((s) => s.state);
  const send = useOrbStore((s) => s.send);
  const voice = useVoiceStore;
  // Field-level selectors: a whole-store subscription re-rendered every
  // consumer of this hook whenever any unrelated setting changed.
  const sttChoice = useSettingsStore((s) => s.sttChoice);
  const scriptedPhrase = useSettingsStore((s) => s.scriptedPhrase);
  const speakReplies = useSettingsStore((s) => s.speakReplies);
  const confirmTimeoutSeconds = useSettingsStore((s) => s.confirmTimeoutSeconds);

  const sttSession = useRef<SttSession | null>(null);
  const micMeter = useRef<MicMeter | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the current listening turn began, for the double-tap guard. */
  const listenStartedAt = useRef(0);
  /** True between asking the engine to stop and it actually delivering. */
  const stopping = useRef(false);
  /** Fires if the engine never finishes after being asked to stop. */
  const stopWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against results arriving after the user moved on. */
  const turnId = useRef(0);

  const tts = useMemo(() => selectTts(), []);
  const wakeWord = useMemo(() => selectWakeWord(), []);

  const stt: SttProvider = useMemo(
    () => (sttChoice === 'scripted' ? createMockStt(scriptedPhrase) : webSpeechStt),
    [sttChoice, scriptedPhrase],
  );

  /* ------------------------------------------------------------ teardown */

  const clearStopWatchdog = useCallback(() => {
    if (stopWatchdog.current !== null) clearTimeout(stopWatchdog.current);
    stopWatchdog.current = null;
    stopping.current = false;
  }, []);

  const stopCapture = useCallback((abort: boolean) => {
    clearStopWatchdog();
    if (sttSession.current) {
      if (abort) sttSession.current.abort();
      else sttSession.current.stop();
      sttSession.current = null;
    }
    micMeter.current?.stop();
    micMeter.current = null;
    publishLevels(null);
    voice.getState().setMicActive(false);
  }, [voice, clearStopWatchdog]);

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    voice.getState().setConfirmDeadline(null);
  }, [voice]);

  // Nothing may outlive the component: no timer, no stream, no recogniser.
  useEffect(
    () => () => {
      turnId.current += 1;
      stopCapture(true);
      clearConfirmTimer();
      tts.cancel();
    },
    [stopCapture, clearConfirmTimer, tts],
  );

  const fail = useCallback(
    (error: VoiceError) => {
      stopCapture(true);
      clearConfirmTimer();
      voice.getState().setError(error);
      send({ type: 'FAILED', reason: error.detail });
    },
    [send, stopCapture, clearConfirmTimer, voice],
  );

  /* --------------------------------------------------------- execution */

  const execute = useCallback(
    async (plan: CommandPlan) => {
      const myTurn = turnId.current;
      clearConfirmTimer();
      voice.getState().setPlan(plan);

      if (plan.execution === 'unsupported') {
        fail({
          code: 'execute',
          title: 'Not supported yet',
          detail: `Devyora cannot carry out ${plan.title.toLowerCase()} from this build.`,
          retryable: false,
        });
        return;
      }

      send({ type: 'RUN' });

      let outcome;
      try {
        outcome = await localExecutor.run(plan);
      } catch (cause) {
        outcome = {
          status: 'failed' as const,
          detail: cause instanceof Error ? cause.message : 'The action could not be carried out.',
        };
      }
      if (myTurn !== turnId.current) return; // the user moved on

      voice.getState().setOutcome(outcome);

      if (outcome.status === 'failed') {
        fail({ code: 'execute', title: 'Action failed', detail: outcome.detail, retryable: true });
        return;
      }

      if (outcome.status === 'handoff') {
        // Something verifiable happened, but the task is not finished, so this
        // is not reported as success.
        send({ type: 'DISMISS' });
        return;
      }

      send({ type: 'COMPLETED' });
      if (speakReplies && plan.spokenReply) void tts.speak(plan.spokenReply);
    },
    [send, fail, clearConfirmTimer, voice, speakReplies, tts],
  );

  /* ------------------------------------------------------ confirmation */

  const openConfirmation = useCallback(
    (plan: CommandPlan | null, clarification: Clarification | null) => {
      voice.getState().setPlan(plan);
      voice.getState().setClarification(clarification);
      send({ type: 'NEEDS_APPROVAL' });

      const seconds = confirmTimeoutSeconds;
      if (seconds > 0) {
        const myTurn = turnId.current;
        voice.getState().setConfirmDeadline(Date.now() + seconds * 1000);
        confirmTimer.current = setTimeout(() => {
          confirmTimer.current = null;
          if (myTurn !== turnId.current) return;
          voice.getState().setConfirmDeadline(null);
          voice.getState().setError({
            code: 'timeout',
            title: 'Confirmation expired',
            detail: 'Nothing was sent. The request was left unanswered, so Devyora stopped.',
            retryable: true,
          });
          send({ type: 'CANCEL' });
        }, seconds * 1000);
      }
    },
    [send, confirmTimeoutSeconds, voice],
  );

  /* ------------------------------------------------- interpret a phrase */

  const interpret = useCallback(
    async (text: string) => {
      const myTurn = turnId.current;
      let result;
      try {
        result = await ruleInterpreter.interpret(text);
      } catch (cause) {
        fail({
          code: 'interpret',
          title: 'Could not process the command',
          detail: cause instanceof Error ? cause.message : 'The command could not be processed.',
          retryable: true,
        });
        return;
      }
      if (myTurn !== turnId.current) return;

      if (result.type === 'unsupported') {
        voice.getState().setUnsupported({ heard: result.heard, reason: result.reason });
        send({ type: 'FAILED', reason: result.reason });
        return;
      }

      if (result.type === 'clarify') {
        openConfirmation(null, result.clarification);
        return;
      }

      if (result.plan.requiresConfirmation) {
        openConfirmation(result.plan, null);
        return;
      }
      void execute(result.plan);
    },
    [send, fail, execute, openConfirmation, voice],
  );

  /* ------------------------------------------------------------- input */

  const acceptUtterance = useCallback(
    (text: string, source: VoiceInputSource) => {
      const clean = text.trim();
      stopping.current = false;
      stopCapture(false);
      if (!clean) {
        fail({ code: 'no-speech', ...STT_ERROR_COPY['no-speech'] });
        return;
      }
      voice.getState().setTranscript(clean, source);
      send({ type: 'SPEECH_CAPTURED' });
      void interpret(clean);
    },
    [send, fail, interpret, stopCapture, voice],
  );

  const startListening = useCallback(async () => {
    turnId.current += 1;
    const myTurn = turnId.current;

    clearConfirmTimer();
    voice.getState().resetTurn();
    send({ type: 'ACTIVATE' });
    listenStartedAt.current = Date.now();

    if (!stt.isSupported()) {
      fail({ code: 'not-supported', ...STT_ERROR_COPY['not-supported'] });
      return;
    }

    // Real microphone levels. The scripted source has no audio to meter, so
    // the waveform stays at rest rather than pretending to hear something.
    if (stt.info.kind === 'real') {
      try {
        micMeter.current = await startMicMeter({
          barCount: WAVEFORM_BAR_COUNT,
          onLevels: (levels) => {
            // Straight to the visualiser; costs no render.
            if (myTurn === turnId.current) publishLevels(levels);
          },
          onError: (error) => {
            if (myTurn === turnId.current) fail({ code: 'mic', ...MIC_ERROR_COPY[error.code] });
          },
        });
        if (myTurn !== turnId.current) {
          micMeter.current.stop();
          micMeter.current = null;
          return;
        }
        voice.getState().setMicActive(true);
      } catch (cause) {
        const code = cause instanceof MicError ? cause.code : 'unknown';
        fail({ code: 'mic', ...MIC_ERROR_COPY[code] });
        return;
      }
    }

    try {
      sttSession.current = await stt.start({
        onInterim: (text) => {
          if (myTurn === turnId.current) voice.getState().setInterim(text);
        },
        onFinal: (text) => {
          if (myTurn === turnId.current) acceptUtterance(text, stt.info.kind === 'mock' ? 'scripted' : 'speech');
        },
        onError: (error) => {
          if (myTurn !== turnId.current) return;
          if (error.code === 'aborted') return;
          fail({ code: error.code, ...STT_ERROR_COPY[error.code] });
        },
        onEnd: () => {
          if (myTurn === turnId.current) {
            micMeter.current?.stop();
            micMeter.current = null;
            publishLevels(null);
            voice.getState().setMicActive(false);
          }
        },
      });
    } catch (cause) {
      const code = cause instanceof SttError ? cause.code : 'unknown';
      fail({ code, ...STT_ERROR_COPY[code] });
    }
  }, [send, fail, stt, acceptUtterance, clearConfirmTimer, voice]);

  /* ------------------------------------------------------------ actions */

  const stopListening = useCallback(() => {
    if (!sttSession.current) {
      send({ type: 'CANCEL' });
      return;
    }
    // Graceful stop: deliver whatever was heard.
    stopping.current = true;
    sttSession.current.stop();

    // Some engines never call back after `stop()` — a lost network leg, a
    // suspended tab. Without this the orb would sit in `listening` forever
    // and the user would have no way out but the Cancel control.
    const myTurn = turnId.current;
    if (stopWatchdog.current !== null) clearTimeout(stopWatchdog.current);
    stopWatchdog.current = setTimeout(() => {
      stopWatchdog.current = null;
      if (myTurn !== turnId.current || !stopping.current) return;
      stopping.current = false;
      fail({ code: 'no-speech', ...STT_ERROR_COPY['no-speech'] });
    }, STOP_GRACE_MS);
  }, [send, fail]);

  const cancel = useCallback(() => {
    turnId.current += 1;
    clearStopWatchdog();
    stopCapture(true);
    clearConfirmTimer();
    tts.cancel();
    voice.getState().resetTurn();
    send({ type: 'CANCEL' });
  }, [send, stopCapture, clearConfirmTimer, clearStopWatchdog, tts, voice]);

  // `toggle` is declared before `cancel`, so it reaches it through a ref.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  /** The orb's own tap: start, stop, or abandon, depending on the phase. */
  const toggle = useCallback(() => {
    if (orbState === 'listening') {
      // A tap landing within the activation window is the tail of a
      // double-tap, not a decision to stop. Ignoring it keeps an accidental
      // second press from cutting the turn off before a word is spoken.
      if (Date.now() - listenStartedAt.current < ACTIVATION_GUARD_MS) return;
      // Already waiting on the engine: a second tap means "forget it".
      if (stopping.current) cancelRef.current();
      else stopListening();
      return;
    }
    void startListening();
  }, [orbState, startListening, stopListening]);

  const submitTypedCommand = useCallback(
    (text: string) => {
      turnId.current += 1;
      clearConfirmTimer();
      stopCapture(true);
      voice.getState().resetTurn();
      const clean = text.trim();
      if (!clean) return;
      voice.getState().setTranscript(clean, 'typed');
      send({ type: 'ACTIVATE' });
      send({ type: 'SPEECH_CAPTURED' });
      void interpret(clean);
    },
    [send, interpret, clearConfirmTimer, stopCapture, voice],
  );

  const approve = useCallback(
    (plan: CommandPlan) => {
      clearConfirmTimer();
      send({ type: 'APPROVE' });
      void execute(plan);
    },
    [send, execute, clearConfirmTimer],
  );

  const reject = useCallback(() => {
    clearConfirmTimer();
    voice.getState().setConfirmDeadline(null);
    send({ type: 'REJECT' });
  }, [send, clearConfirmTimer, voice]);

  /** Re-record the same request. */
  const revise = useCallback(() => {
    clearConfirmTimer();
    void startListening();
  }, [clearConfirmTimer, startListening]);

  const answerClarification = useCallback(
    (value: string) => {
      const current = voice.getState().clarification;
      if (!current) return;
      const resolved = withField(current.draft, current.field, value);
      clearConfirmTimer();
      voice.getState().setClarification(null);
      if (resolved.requiresConfirmation) openConfirmation(resolved, null);
      else void execute(resolved);
    },
    [voice, clearConfirmTimer, openConfirmation, execute],
  );

  const retry = useCallback(() => {
    void startListening();
  }, [startListening]);

  const dismiss = useCallback(() => {
    turnId.current += 1;
    clearConfirmTimer();
    voice.getState().resetTurn();
    send({ type: 'DISMISS' });
  }, [send, clearConfirmTimer, voice]);

  return {
    toggle,
    startListening,
    stopListening,
    cancel,
    submitTypedCommand,
    approve,
    reject,
    revise,
    answerClarification,
    retry,
    dismiss,
    providers: {
      stt: stt.info,
      sttSupported: stt.isSupported(),
      tts: tts.info,
      interpreter: ruleInterpreter.info,
      wakeWord: { info: wakeWord.info, phrase: wakeWord.phrase, status: wakeWord.status() },
    },
  };
}

export type VoiceSession = ReturnType<typeof useVoiceSession>;
