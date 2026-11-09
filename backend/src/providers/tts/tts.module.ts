import { Global, Logger, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { GoogleTtsProvider } from './google.provider';
import { MockTtsProvider } from './mock.provider';
import { OpenAiTtsProvider } from './openai.provider';
import { TTS_PROVIDER, type TtsProvider, type TtsProviderHealth } from './types';

/**
 * Chooses the synthesiser.
 *
 * Same credential rule as the other registries. The consequence of falling
 * back here is mild — the stand-in produces silence, and the text reply is
 * unaffected — but it is still reported rather than hidden, so a deployment
 * that meant to have a voice can tell that it does not.
 */
export class TtsRegistry {
  private readonly logger = new Logger(TtsRegistry.name);
  private readonly providers: TtsProvider[];
  private readonly selected: TtsProvider;

  constructor(providers: TtsProvider[], requested: string) {
    this.providers = providers;

    const match = providers.find((p) => p.id === requested);
    if (match?.configured) {
      this.selected = match;
    } else {
      this.selected = providers.find((p) => p.id === 'mock')!;
      this.logger.warn(
        match
          ? `TTS_PROVIDER is "${requested}" but it has no credential; replies will ` +
              'not be spoken. Text responses are unaffected.'
          : `TTS_PROVIDER "${requested}" is unknown; replies will not be spoken.`,
      );
    }
  }

  active(): TtsProvider {
    return this.selected;
  }

  byId(id: string): TtsProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  list(): readonly TtsProvider[] {
    return this.providers;
  }

  healthAll(): Promise<TtsProviderHealth[]> {
    return Promise.all(this.providers.map((p) => p.health()));
  }
}

@Global()
@Module({
  providers: [
    {
      provide: TtsRegistry,
      useFactory: (config: AppConfigService) => {
        const tts = config.providers.tts;
        return new TtsRegistry(
          [
            new MockTtsProvider(),
            new OpenAiTtsProvider(
              config.providers.ai.openAiApiKey,
              tts.model,
              tts.defaultVoice,
              tts.timeoutMs,
            ),
            new GoogleTtsProvider(tts.googleApiKey, tts.timeoutMs),
          ],
          tts.provider,
        );
      },
      inject: [AppConfigService],
    },
    {
      provide: TTS_PROVIDER,
      useFactory: (registry: TtsRegistry) => registry.active(),
      inject: [TtsRegistry],
    },
  ],
  exports: [TtsRegistry, TTS_PROVIDER],
})
export class TtsModule {}
