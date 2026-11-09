import { Injectable, Logger } from '@nestjs/common';
import {
  AudioKind,
  AudioRetention,
  VoiceInputMode,
  VoiceSessionState as State,
  type VoiceSession,
} from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config.module';
import { PrismaService } from '../../database/prisma.service';
import { SttError } from '../../providers/stt/errors';
import { AssistantService, type AssistantTurn } from '../assistant/assistant.service';
import { AudioStoreService } from './audio/audio-store.service';
import { AudioValidationError, validateAudio, type ValidatedAudio } from './audio/audio-validation';
import { SttService, type TranscriptionResult } from './stt.service';
import { TtsService } from './tts.service';
import { VoiceEventBus, type VoiceEventTarget } from './voice-event-bus';
import type {
  ClarificationRequiredEvent,
  ConfirmationRequiredEvent,
  ResponseReadyEvent,
  SessionCreatedEvent,
  SessionFailedEvent,
  TranscriptFinalEvent,
  TranscriptPartialEvent,
} from './voice-events';
import { describeSession, VoiceSessionService } from './voice-session.service';
import { parseVoicePreferences, type VoicePreferences } from './voice-preferences';

export interface StartSessionInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly inputMode: VoiceInputMode;
  readonly wakeWordTriggered?: boolean;
  readonly languageHint?: string | null;
  readonly conversationId?: string | null;
}

export interface SubmitAudioInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly audio: Buffer;
  readonly declaredMimeType?: string;
  readonly languageHint?: string | null;
  readonly signal?: AbortSignal;
}

export interface SubmitTranscriptInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly detectedLanguage?: string | null;
  readonly meta: { ipAddress?: string; userAgent?: string };
}

export interface VoiceTurnResult {
  readonly session: ReturnType<typeof describeSession>;
  readonly transcript: {
    readonly text: string;
    readonly detectedLanguage: string | null;
    readonly confidence: number | null;
    readonly durationMs: number | null;
    readonly provider: { readonly id: string; readonly isMock: boolean };
  } | null;
  readonly assistant: AssistantTurn | null;
  readonly speech: ResponseReadyEvent['speech'];
  readonly speechUnavailable: string | null;
}

/**
 * The voice pipeline.
 *
 *   audio → recognition → transcript → assistant → clarification or
 *   confirmation → reply → optional speech
 *
 * Three things this service is careful about.
 *
 * **Audio does not outlive its use.** Every path that writes a recording
 * deletes it in a `finally`, and the retention the user chose is the only
 * thing that keeps one. A failure is not an excuse to leave bytes behind.
 *
 * **Nothing is presented as heard that was not.** Whether a stand-in
 * produced a transcript travels with it — into the event, the response and
 * the stored row — because the one thing a voice assistant must never do is
 * invent what somebody said.
 *
 * **Speech is optional, always.** A synthesis failure produces a reason
 * string and nothing else; the text reply is unaffected.
 */
@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly sessions: VoiceSessionService,
    private readonly stt: SttService,
    private readonly tts: TtsService,
    private readonly assistant: AssistantService,
    private readonly audioStore: AudioStoreService,
    private readonly bus: VoiceEventBus,
  ) {}

  // ─────────────────────────────────────────────────────────── activation

  /**
   * Opens a session.
   *
   * A wake word is honoured only when the user has enabled it, and only as
   * a *label* on an otherwise ordinary authenticated request. The claim
   * arrives from the device and is never treated as proof of anything: the
   * access token is what authorises this call, exactly as for a tap.
   */
  async startSession(input: StartSessionInput): Promise<ReturnType<typeof describeSession>> {
    const preferences = await this.preferencesFor(input.userId);

    if (input.wakeWordTriggered && !preferences.wakeWordEnabled) {
      throw AppError.forbidden('Wake-word activation is turned off for this account.');
    }

    const session = await this.sessions.create({
      ...input,
      languageHint: input.languageHint ?? preferences.languageHint,
    });

    this.emit<SessionCreatedEvent>(
      session,
      'session.created',
      {
        state: session.state,
        inputMode: session.inputMode,
        expiresAt: session.expiresAt.toISOString(),
      },
      { deviceOnly: true },
    );

    if (input.inputMode !== VoiceInputMode.TEXT) {
      await this.sessions.transitionTo(session.id, State.CREATED, State.LISTENING);
      const listening = await this.sessions.requireOwned(input.userId, session.id);
      this.emit(listening, 'listening.started', { state: listening.state }, { deviceOnly: true });
      return describeSession(listening);
    }

    return describeSession(session);
  }

  /** A partial transcript from a device doing its own recognition. */
  async pushPartialTranscript(
    userId: string,
    deviceId: string,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const session = await this.sessions.requireActive(userId, sessionId, {
      requireDevice: deviceId,
    });

    // Pushed live and then gone. Interim text is not stored: a sequence of
    // half-heard sentences is a worse thing to keep than the final one.
    this.emit<TranscriptPartialEvent>(
      session,
      'transcript.partial',
      { text: text.slice(0, 2_000), isMock: false },
      { deviceOnly: true },
    );
  }

  // ──────────────────────────────────────────────────────────── audio in

  /**
   * Takes a recording, transcribes it, and runs the turn.
   *
   * The recording is written to disk only so that a retry inside the
   * recogniser does not need it held in memory twice, and so a retention
   * preference has something to retain. On every exit — success, provider
   * failure, cancellation — it is deleted unless the user asked otherwise.
   */
  async submitAudio(input: SubmitAudioInput): Promise<VoiceTurnResult> {
    const session = await this.sessions.requireActive(input.userId, input.sessionId, {
      requireDevice: input.deviceId,
    });
    const preferences = await this.preferencesFor(input.userId);
    const limits = this.audioLimits();

    let validated: ValidatedAudio;
    try {
      validated = validateAudio(input.audio, input.declaredMimeType, limits);
    } catch (error) {
      // A rejected upload is a failed session: the user has to speak again.
      const rejection = error instanceof AudioValidationError ? error.rejection : 'audio_missing';
      await this.failSession(session, rejection, describeAudioRejection(error), true);
      throw error;
    }

    const retention = resolveRetention(preferences, this.config.providers.audio.retentionDefault);
    let storageKey: string | null = null;
    let assetId: string | null = null;

    try {
      storageKey = await this.audioStore.write(validated.bytes);

      const asset = await this.prisma.audioAsset.create({
        data: {
          userId: input.userId,
          voiceSessionId: session.id,
          kind: AudioKind.INPUT,
          mimeType: validated.mimeType,
          storageKey,
          byteSize: validated.byteSize,
          durationMs: validated.durationMs,
          sampleRate: validated.sampleRate,
          checksum: validated.checksum,
          retention,
          deleteAfter:
            retention === AudioRetention.RETAIN
              ? new Date(Date.now() + preferences.audioRetentionDays * 86_400_000)
              : null,
        },
        select: { id: true },
      });
      assetId = asset.id;

      const listening = await this.sessions.transitionTo(session.id, session.state, State.TRANSCRIBING);

      let transcription: TranscriptionResult;
      try {
        transcription = await this.stt.transcribe(
          validated,
          input.languageHint ?? session.languageHint ?? preferences.languageHint,
          input.signal,
        );
      } catch (error) {
        const code = sttFailureCode(error);
        await this.failSession(listening, code, describeSttFailure(error), isRetryable(error));
        // Re-raised as something the error filter understands. A speech
        // service being down is a dependency failure, not an internal
        // error, and the user deserves to be told which.
        throw httpErrorForStt(error);
      }

      if (!transcription.text.trim()) {
        // A real outcome, not an error: the recogniser worked and heard
        // nothing. Told apart from a failure so the user is asked to speak
        // again rather than shown something broken.
        await this.failSession(listening, 'no_speech_detected', 'Nothing was heard.', true);
        return {
          session: describeSession(
            await this.sessions.requireOwned(input.userId, session.id),
          ),
          transcript: null,
          assistant: null,
          speech: null,
          speechUnavailable: null,
        };
      }

      const withTranscript = await this.recordTranscript(listening, transcription);

      return await this.runAssistant(withTranscript, transcription.text, preferences, {
        transcription,
        meta: {},
      });
    } finally {
      // The one place audio is kept is a user asking for it to be. Every
      // other exit removes it, failures included.
      if (retention === AudioRetention.DISCARD && storageKey) {
        const removed = await this.audioStore.remove(storageKey);
        if (removed && assetId) {
          await this.prisma.audioAsset
            .update({
              where: { id: assetId },
              // `storageKey` goes null, so the row says "this existed and
              // is gone" rather than pointing at a file that is not there.
              data: { storageKey: null, deletedAt: new Date() },
            })
            .catch(() => undefined);
        }
      }
    }
  }

  // ────────────────────────────────────────────────────── transcript in

  /**
   * Takes a transcript the device recognised itself.
   *
   * This is the path the web client uses: the browser's own recogniser
   * produces text, and no audio ever leaves the device. It is the better
   * arrangement when the platform supports it, and it is a first-class
   * input mode rather than a fallback.
   */
  async submitTranscript(input: SubmitTranscriptInput): Promise<VoiceTurnResult> {
    const text = input.text.trim();
    if (!text) throw AppError.validation('The transcript is empty.');

    const session = await this.sessions.requireActive(input.userId, input.sessionId, {
      requireDevice: input.deviceId,
    });
    const preferences = await this.preferencesFor(input.userId);

    const transcription: TranscriptionResult = {
      text,
      detectedLanguage: input.detectedLanguage ?? null,
      // No server-side recogniser ran, so there is nothing to report.
      confidence: null,
      durationMs: null,
      providerId: 'device',
      model: 'device',
      isMock: false,
      latencyMs: 0,
    };

    const withTranscript = await this.recordTranscript(
      await this.sessions.transitionTo(session.id, session.state, State.TRANSCRIBING),
      transcription,
    );

    return this.runAssistant(withTranscript, text, preferences, {
      transcription,
      meta: input.meta,
    });
  }

  // ─────────────────────────────────────────────────────────── the turn

  private async recordTranscript(
    session: VoiceSession,
    transcription: TranscriptionResult,
  ): Promise<VoiceSession> {
    const updated = await this.sessions.transitionTo(session.id, session.state, State.INTERPRETING, {
      transcript: transcription.text,
      detectedLanguage: transcription.detectedLanguage,
      sttProviderId: transcription.providerId,
      sttConfidence: transcription.confidence,
      sttLatencyMs: transcription.latencyMs,
    });

    this.emit<TranscriptFinalEvent>(
      updated,
      'transcript.final',
      {
        text: transcription.text,
        detectedLanguage: transcription.detectedLanguage,
        confidence: transcription.confidence,
        durationMs: transcription.durationMs,
        provider: { id: transcription.providerId, isMock: transcription.isMock },
      },
      { deviceOnly: true },
    );

    this.emit(updated, 'processing.started', { state: updated.state }, { deviceOnly: true });
    return updated;
  }

  /**
   * Hands the transcript to the assistant and maps the answer onto the
   * session.
   *
   * The assistant decides what the request means and whether it is
   * permitted; this method only translates its answer into voice states and
   * events. In particular it does not invent an outcome: the assistant's
   * status is carried through unchanged, and it has no value meaning
   * "executed" because nothing executes yet.
   */
  private async runAssistant(
    session: VoiceSession,
    transcript: string,
    preferences: VoicePreferences,
    context: {
      transcription: TranscriptionResult;
      meta: { ipAddress?: string; userAgent?: string };
    },
  ): Promise<VoiceTurnResult> {
    let turn: AssistantTurn;
    try {
      turn = await this.assistant.handleTurn({
        userId: session.userId,
        deviceId: session.deviceId,
        text: transcript,
        conversationId: session.conversationId ?? undefined,
        meta: context.meta,
      });
    } catch (error) {
      await this.failSession(session, 'assistant_failed', 'The assistant could not process that.', true);
      throw error;
    }

    const nextState = stateForTurn(turn.status);

    const updated = await this.sessions.transitionTo(session.id, State.INTERPRETING, nextState, {
      conversationId: turn.conversationId,
      commandId: turn.commandId || null,
      pendingActionId: turn.plan?.pendingActionId ?? null,
      replyText: turn.reply,
      failureCode: turn.status === 'failed' ? (turn.problem?.code.toLowerCase() ?? 'assistant_failed') : null,
    });

    if (turn.clarification) {
      this.emit<ClarificationRequiredEvent>(
        updated,
        'clarification.required',
        {
          question: turn.clarification.question,
          reason: turn.clarification.reason,
          field: turn.clarification.field,
          options: turn.clarification.options,
          commandId: turn.clarification.commandId,
        },
        { deviceOnly: true },
      );
    }

    if (turn.plan?.requiresConfirmation) {
      // Delivered to every device on the account, not just this one: a
      // confirmation is a decision the person makes, and they may be
      // looking at a different screen. Acting on it still requires the
      // owning device — see `VoiceSessionService.requireOwned`.
      this.emit<ConfirmationRequiredEvent>(updated, 'confirmation.required', {
        pendingActionId: turn.plan.pendingActionId,
        kind: turn.plan.kind,
        intent: turn.plan.intent,
        fields: turn.plan.fields,
        expiresAt: turn.plan.expiresAt,
      });
    }

    // Speech last, and never in a way that can lose the text reply.
    const outcome = await this.tts.speak(turn.reply, preferences, turn.detectedLanguage);
    let speech: ResponseReadyEvent['speech'] = null;
    let speechUnavailable: string | null = null;

    if (outcome.spoken) {
      const stored = await this.storeSpeech(updated, outcome.speech);
      speech = {
        url: `/api/v1/voice/sessions/${updated.id}/speech`,
        mimeType: stored.mimeType,
        durationMs: stored.durationMs,
        voice: stored.voice,
        isMock: stored.isMock,
      };
    } else {
      speechUnavailable = outcome.reason;
    }

    this.emit<ResponseReadyEvent>(updated, 'response.ready', {
      text: turn.reply,
      intent: turn.intent,
      status: turn.status,
      speech,
      speechUnavailable,
    });

    if (turn.status === 'failed') {
      this.emit<SessionFailedEvent>(updated, 'session.failed', {
        code: turn.problem?.code.toLowerCase() ?? 'assistant_failed',
        detail: turn.reply,
        retryable: true,
      });
    }

    return {
      session: describeSession(updated),
      transcript: {
        text: context.transcription.text,
        detectedLanguage: context.transcription.detectedLanguage,
        confidence: context.transcription.confidence,
        durationMs: context.transcription.durationMs,
        provider: { id: context.transcription.providerId, isMock: context.transcription.isMock },
      },
      assistant: turn,
      speech,
      speechUnavailable,
    };
  }

  // ─────────────────────────────────────────────────────────────── speech

  /**
   * Keeps a synthesised reply just long enough to be played.
   *
   * This is the assistant's voice, not the user's, so it is less sensitive
   * than a recording — but it is still deleted with the session rather than
   * kept, because nothing needs it afterwards. An earlier reply's audio is
   * removed when a new one replaces it.
   */
  private async storeSpeech(
    session: VoiceSession,
    speech: { audio: Buffer; mimeType: string; durationMs: number | null; voice: string; providerId: string; isMock: boolean },
  ) {
    const previous = await this.prisma.audioAsset.findMany({
      where: { voiceSessionId: session.id, kind: AudioKind.SPEECH, deletedAt: null },
      select: { id: true, storageKey: true },
    });
    for (const old of previous) {
      await this.audioStore.remove(old.storageKey);
      await this.prisma.audioAsset.update({
        where: { id: old.id },
        data: { storageKey: null, deletedAt: new Date() },
      });
    }

    const storageKey = await this.audioStore.write(speech.audio);
    await this.prisma.audioAsset.create({
      data: {
        userId: session.userId,
        voiceSessionId: session.id,
        kind: AudioKind.SPEECH,
        mimeType: speech.mimeType,
        storageKey,
        byteSize: speech.audio.byteLength,
        durationMs: speech.durationMs,
        checksum: 'n/a',
        retention: AudioRetention.SESSION,
        deleteAfter: new Date(Date.now() + this.config.providers.voice.sessionGraceMs),
      },
    });

    return speech;
  }

  /**
   * Serves the spoken reply.
   *
   * Scoped to the owning user and device, like everything else about a
   * session: the URL is not a capability, and a leaked one reaches nothing.
   */
  async readSpeech(
    userId: string,
    sessionId: string,
    deviceId: string | null,
  ): Promise<{ audio: Buffer; mimeType: string }> {
    await this.sessions.requireOwned(userId, sessionId, { requireDevice: deviceId });

    const asset = await this.prisma.audioAsset.findFirst({
      where: {
        voiceSessionId: sessionId,
        userId,
        kind: AudioKind.SPEECH,
        deletedAt: null,
        storageKey: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { storageKey: true, mimeType: true },
    });

    if (!asset?.storageKey) throw AppError.notFound('Spoken reply');

    try {
      return { audio: await this.audioStore.read(asset.storageKey), mimeType: asset.mimeType };
    } catch {
      // The row says it should be there and it is not. Reported as missing
      // rather than as a server error: the file is gone either way, and
      // the user can simply ask again.
      throw AppError.notFound('Spoken reply');
    }
  }

  // ───────────────────────────────────────────────────── cancel & cleanup

  /**
   * Cancels a session and removes anything it was holding.
   *
   * A user who cancels expects the recording gone, not retained because a
   * preference said so for completed turns. Cancellation therefore deletes
   * input audio regardless of the retention setting.
   */
  async cancel(userId: string, sessionId: string, deviceId: string | null, by: 'user' | 'device' | 'system' = 'user') {
    const { session, alreadyEnded } = await this.sessions.cancel(userId, sessionId, deviceId);

    const removed = await this.discardSessionAudio(sessionId, { includeRetained: true });

    if (!alreadyEnded) {
      const event = await this.sessions.recordEvent(session.id, 'session.cancelled', { by });
      this.bus.publish(event, {
        userId: session.userId,
        deviceId: session.deviceId,
        sessionId: session.id,
        deviceOnly: true,
      });
    }

    return {
      session: describeSession(session),
      alreadyEnded,
      audioRemoved: removed,
      // Said plainly: cancelling stops the turn and does not undo anything
      // that was already carried out, because nothing is.
      note: 'Cancelled. The recording was deleted and nothing was carried out.',
    };
  }

  /**
   * Deletes a session's audio.
   *
   * `includeRetained` is what separates cancellation from ordinary
   * completion: retention is a choice about kept conversations, not a
   * reason to hold on to something the user just told us to drop.
   */
  async discardSessionAudio(
    sessionId: string,
    options: { includeRetained?: boolean } = {},
  ): Promise<number> {
    const assets = await this.prisma.audioAsset.findMany({
      where: {
        voiceSessionId: sessionId,
        deletedAt: null,
        ...(options.includeRetained ? {} : { retention: { not: AudioRetention.RETAIN } }),
      },
      select: { id: true, storageKey: true },
    });

    let removed = 0;
    for (const asset of assets) {
      if (await this.audioStore.remove(asset.storageKey)) removed += 1;
      await this.prisma.audioAsset.update({
        where: { id: asset.id },
        data: { storageKey: null, deletedAt: new Date() },
      });
    }
    return removed;
  }

  /**
   * The retention sweep.
   *
   * Belongs to the job scheduler that arrives with the background workers;
   * it is written here because what may be deleted is a property of this
   * data. Two passes: rows whose window has closed, then any file on disk
   * with no live row, because a lost row must not mean audio kept forever.
   */
  async applyAudioRetention(now = new Date()): Promise<{ rows: number; orphans: number }> {
    const due = await this.prisma.audioAsset.findMany({
      where: { deletedAt: null, deleteAfter: { lte: now } },
      select: { id: true, storageKey: true },
    });

    for (const asset of due) {
      await this.audioStore.remove(asset.storageKey);
      await this.prisma.audioAsset.update({
        where: { id: asset.id },
        data: { storageKey: null, deletedAt: now },
      });
    }

    const live = await this.prisma.audioAsset.findMany({
      where: { deletedAt: null, storageKey: { not: null } },
      select: { storageKey: true },
    });
    const known = new Set(live.map((a) => a.storageKey!));
    const orphans = await this.removeOrphans(known);

    return { rows: due.length, orphans };
  }

  private async removeOrphans(known: Set<string>): Promise<number> {
    // Only files old enough that no in-flight request could own them, so a
    // sweep running mid-upload does not delete audio being transcribed.
    const graceMs = 60_000;
    return this.audioStore.removeOlderThanExcept(graceMs, known);
  }

  // ──────────────────────────────────────────────────────────── failures

  private async failSession(
    session: VoiceSession,
    code: string,
    detail: string,
    retryable: boolean,
  ): Promise<void> {
    try {
      const failed = await this.sessions.transitionTo(session.id, session.state, State.FAILED, {
        failureCode: code.slice(0, 40),
      });
      this.emit<SessionFailedEvent>(failed, 'session.failed', { code, detail, retryable });
    } catch (error) {
      // The session had already moved — most likely it was cancelled while
      // the provider was working. Not worth masking the original failure.
      this.logger.warn(
        `Could not mark session ${session.id} failed: ` +
          (error instanceof Error ? error.message : 'unknown error'),
      );
    }
  }

  // ──────────────────────────────────────────────────────────── plumbing

  private emit<T extends { type: string }>(
    session: VoiceSession,
    type: T extends { type: infer K } ? K : never,
    payload: Omit<T, 'sessionId' | 'seq' | 'at' | 'type'>,
    options: { deviceOnly?: boolean } = {},
  ): void {
    const target: VoiceEventTarget = {
      userId: session.userId,
      deviceId: session.deviceId,
      sessionId: session.id,
      deviceOnly: options.deviceOnly,
    };

    // Recorded then published. The await is intentionally not held by the
    // caller: a socket write must not sit in the path of the response, and
    // a logging failure must not fail the turn.
    void this.sessions
      .recordEvent(session.id, type as never, payload as never)
      .then((event) => this.bus.publish(event, target))
      .catch((error: unknown) =>
        this.logger.error(
          `Could not record voice event ${String(type)}: ` +
            (error instanceof Error ? error.message : 'unknown error'),
        ),
      );
  }

  private async preferencesFor(userId: string): Promise<VoicePreferences> {
    const row = await this.prisma.userPreference.findUnique({
      where: { userId },
      select: { voice: true },
    });
    return parseVoicePreferences(row?.voice);
  }

  private audioLimits() {
    const audio = this.config.providers.audio;
    return {
      minBytes: audio.minBytes,
      maxBytes: audio.maxBytes,
      maxDurationMs: audio.maxDurationMs,
    };
  }
}

/**
 * The assistant's status, mapped onto a session state.
 *
 * Exhaustive by construction: a new assistant status will not compile until
 * it is given a voice state, so the two cannot drift apart silently.
 */
export function stateForTurn(status: AssistantTurn['status']): State {
  switch (status) {
    case 'needs_clarification':
      return State.AWAITING_CLARIFICATION;
    case 'awaiting_confirmation':
      return State.AWAITING_CONFIRMATION;
    case 'queued_for_execution':
      return State.QUEUED;
    case 'answered':
    case 'unsupported':
      // Understood and finished talking about. `unsupported` is a complete
      // outcome, not a failure: the assistant did its job and said no.
      return State.COMPLETED;
    case 'failed':
      return State.FAILED;
  }
}

function resolveRetention(
  preferences: VoicePreferences,
  fallback: 'DISCARD' | 'SESSION' | 'RETAIN',
): AudioRetention {
  const choice = preferences.audioRetention ?? fallback;
  return AudioRetention[choice];
}

function sttFailureCode(error: unknown): string {
  if (error instanceof AudioValidationError) return error.rejection;
  if (error instanceof SttError) return `stt_${error.code}`;
  return 'stt_unknown';
}

function isRetryable(error: unknown): boolean {
  return error instanceof SttError ? error.retryable : false;
}

/**
 * Turns a provider failure into the error the client should see.
 *
 * Without this an `SttError` would reach the exception filter unrecognised
 * and become a 500, which would be both unhelpful and untrue: nothing in
 * this service went wrong. The distinction that matters to a caller is
 * whether retrying could work, so a dependency problem is a 503 and a
 * problem with the recording itself is a 400.
 */
function httpErrorForStt(error: unknown): unknown {
  if (error instanceof AudioValidationError) return error;
  if (!(error instanceof SttError)) return error;

  switch (error.code) {
    case 'invalid_audio':
    case 'content_filtered':
      // The recording is the problem; sending it again will not help.
      return AppError.validation(describeSttFailure(error));
    default:
      return AppError.dependencyUnavailable(describeSttFailure(error));
  }
}

function describeSttFailure(error: unknown): string {
  if (!(error instanceof SttError)) return 'Speech recognition failed.';
  switch (error.code) {
    case 'timeout':
      return 'Speech recognition took too long.';
    case 'rate_limited':
      return 'The speech service is busy. Try again shortly.';
    case 'auth':
      return 'Speech recognition is not configured.';
    case 'invalid_audio':
      return 'That recording could not be read.';
    case 'content_filtered':
      return 'The speech service refused that recording.';
    default:
      return 'Speech recognition failed.';
  }
}

function describeAudioRejection(error: unknown): string {
  return error instanceof AudioValidationError ? error.message : 'The recording was rejected.';
}
