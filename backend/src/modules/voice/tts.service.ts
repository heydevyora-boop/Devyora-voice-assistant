import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { TtsError } from '../../providers/tts/errors';
import { TtsRegistry } from '../../providers/tts/tts.module';
import type { TtsVoice } from '../../providers/tts/types';
import type { VoicePreferences } from './voice-preferences';

export interface SpeechResult {
  readonly audio: Buffer;
  readonly mimeType: string;
  readonly durationMs: number | null;
  readonly voice: string;
  readonly providerId: string;
  readonly isMock: boolean;
}

/**
 * The outcome of asking for speech.
 *
 * A result object rather than an exception, because every caller's correct
 * response to a failure is identical: send the text and say speech is
 * unavailable. Making that an exception would invite someone to let it
 * propagate, and a user would lose their answer because a voice service
 * was busy.
 */
export type SpeechOutcome =
  | { readonly spoken: true; readonly speech: SpeechResult }
  | { readonly spoken: false; readonly reason: string };

/**
 * Speech synthesis, with the user's preferences applied.
 *
 * Nothing here is allowed to fail a turn. The text reply is the product;
 * a spoken version is an enhancement, and the one rule that follows from
 * that is enforced at this boundary rather than trusted to callers.
 */
@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  constructor(
    private readonly registry: TtsRegistry,
    private readonly config: AppConfigService,
  ) {}

  /** The voices a client can offer, from whichever provider is active. */
  catalogue(): { providerId: string; isMock: boolean; voices: readonly TtsVoice[] } {
    const provider = this.registry.active();
    return {
      providerId: provider.id,
      isMock: provider.kind === 'mock',
      voices: provider.voices(),
    };
  }

  /**
   * Speaks a reply, if the user asked for that and it is possible.
   *
   * Four ways this declines, each reported distinctly so a user who
   * expected a voice can be told which it was: the preference is off, the
   * text is empty, no provider is configured, or the provider failed.
   */
  async speak(
    text: string,
    preferences: VoicePreferences,
    language: string | null,
    signal?: AbortSignal,
  ): Promise<SpeechOutcome> {
    if (!preferences.speakReplies) {
      return { spoken: false, reason: 'Spoken replies are turned off.' };
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return { spoken: false, reason: 'There was nothing to speak.' };
    }

    const provider = this.registry.active();

    try {
      const audio = await provider.synthesize({
        text: trimmed,
        voice: preferences.voiceId,
        language,
        rate: provider.capabilities.rate ? preferences.rate : null,
        mimeType: null,
        timeoutMs: this.config.providers.tts.timeoutMs,
        signal,
      });

      return {
        spoken: true,
        speech: {
          audio: audio.audio,
          mimeType: audio.mimeType,
          durationMs: audio.durationMs,
          voice: audio.voice,
          providerId: provider.id,
          // Passed through, so a client can say the reply is not actually
          // being spoken rather than playing silence and looking broken.
          isMock: provider.kind === 'mock',
        },
      };
    } catch (error) {
      const code = error instanceof TtsError ? error.code : 'unknown';
      // The reply text is not logged: it is the user's conversation.
      this.logger.warn(`Speech synthesis failed (${code}) via ${provider.id}`);

      return {
        spoken: false,
        reason:
          code === 'auth'
            ? 'No speech service is configured.'
            : code === 'timeout'
              ? 'The speech service took too long.'
              : code === 'rate_limited'
                ? 'The speech service is busy.'
                : 'The reply could not be spoken.',
      };
    }
  }
}
