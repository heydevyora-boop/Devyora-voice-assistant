import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { SttError } from '../../providers/stt/errors';
import { DEFAULT_RETRY, withRetry } from '../../providers/stt/reliability';
import { SttRegistry } from '../../providers/stt/stt.module';
import type { SttCapabilities } from '../../providers/stt/types';
import { assertDurationWithinLimit, type ValidatedAudio } from './audio/audio-validation';

export interface TranscriptionResult {
  readonly text: string;
  readonly detectedLanguage: string | null;
  readonly confidence: number | null;
  readonly durationMs: number | null;
  readonly providerId: string;
  readonly model: string;
  /** True when a stand-in produced this. Carried everywhere it goes. */
  readonly isMock: boolean;
  readonly latencyMs: number;
}

/**
 * Speech recognition, with the provider chosen for us.
 *
 * It does three things: hand validated bytes to whichever recogniser is
 * active, hold the result to the duration limit that could not be checked
 * before decoding, and report what produced it. It does not store audio,
 * manage sessions or interpret anything.
 */
@Injectable()
export class SttService {
  private readonly logger = new Logger(SttService.name);

  constructor(
    private readonly registry: SttRegistry,
    private readonly config: AppConfigService,
  ) {}

  /** What the active recogniser can do, for a client to adapt to. */
  describeProvider(): {
    providerId: string;
    isMock: boolean;
    capabilities: SttCapabilities;
  } {
    const provider = this.registry.active();
    return {
      providerId: provider.id,
      isMock: provider.kind === 'mock',
      capabilities: provider.capabilities,
    };
  }

  /**
   * Transcribes a recording.
   *
   * Retried only on transient failures, and only because transcription is
   * a read: a discarded attempt leaves nothing behind at the provider and
   * nothing on our side. The audio is not re-uploaded anywhere else, and
   * nothing that writes or charges a third party is retried here.
   */
  async transcribe(
    audio: ValidatedAudio,
    languageHint: string | null,
    signal?: AbortSignal,
  ): Promise<TranscriptionResult> {
    const provider = this.registry.active();
    const settings = this.config.providers.stt;
    const startedAt = Date.now();

    if (!provider.capabilities.mimeTypes.includes(audio.mimeType)) {
      // Caught here rather than at the provider, so the message can name
      // what this recogniser accepts instead of relaying a 400.
      throw new SttError(
        'invalid_audio',
        provider.id,
        `This recogniser does not accept ${audio.mimeType}.`,
      );
    }

    const result = await withRetry(
      { ...DEFAULT_RETRY, maxAttempts: settings.maxAttempts },
      (attempt) => {
        if (attempt > 1) this.logger.warn(`Re-sending audio to ${provider.id} (attempt ${attempt})`);
        return provider.transcribe({
          audio: audio.bytes,
          mimeType: audio.mimeType,
          languageHint,
          timeoutMs: settings.timeoutMs,
          signal,
        });
      },
    );

    // The real length is only knowable once something decoded the audio, so
    // the ceiling is enforced again here. A 200 KB Opus file can hold four
    // minutes of silence, which the byte limit cannot catch.
    assertDurationWithinLimit(result.durationMs ?? audio.durationMs, {
      minBytes: this.config.providers.audio.minBytes,
      maxBytes: this.config.providers.audio.maxBytes,
      maxDurationMs: this.config.providers.audio.maxDurationMs,
    });

    return {
      text: result.text,
      // When the provider does not report a language, this stays null
      // rather than echoing back the hint the client sent. An echoed guess
      // is not a detection, and something downstream would believe it.
      detectedLanguage: provider.capabilities.languageDetection ? result.detectedLanguage : null,
      confidence: provider.capabilities.confidence ? result.confidence : null,
      durationMs: result.durationMs ?? audio.durationMs,
      providerId: provider.id,
      model: result.model,
      isMock: provider.kind === 'mock',
      latencyMs: Date.now() - startedAt,
    };
  }
}
