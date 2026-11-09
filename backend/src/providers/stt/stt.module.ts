import { Global, Logger, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { GoogleSttProvider } from './google.provider';
import { MockSttProvider } from './mock.provider';
import { WhisperSttProvider } from './whisper.provider';
import { STT_PROVIDER, type SttProvider, type SttProviderHealth } from './types';

/**
 * Chooses the recogniser and keeps the alternatives addressable.
 *
 * The same rule as the language-model registry, and it matters more here:
 * a provider with no credential is never selected, and the fallback is the
 * local stand-in rather than a different vendor. Audio is the user's own
 * voice, so quietly sending it somewhere nobody chose is not a fallback,
 * it is a disclosure.
 */
export class SttRegistry {
  private readonly logger = new Logger(SttRegistry.name);
  private readonly providers: SttProvider[];
  private readonly selected: SttProvider;

  constructor(providers: SttProvider[], requested: string) {
    this.providers = providers;

    const match = providers.find((p) => p.id === requested);
    if (match?.configured) {
      this.selected = match;
    } else {
      this.selected = providers.find((p) => p.id === 'mock')!;
      this.logger.warn(
        match
          ? `STT_PROVIDER is "${requested}" but it has no credential; using the ` +
              'deterministic stand-in. No speech will be recognised.'
          : `STT_PROVIDER "${requested}" is unknown; using the deterministic stand-in.`,
      );
    }
  }

  active(): SttProvider {
    return this.selected;
  }

  byId(id: string): SttProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  list(): readonly SttProvider[] {
    return this.providers;
  }

  healthAll(): Promise<SttProviderHealth[]> {
    return Promise.all(this.providers.map((p) => p.health()));
  }
}

@Global()
@Module({
  providers: [
    {
      provide: SttRegistry,
      useFactory: (config: AppConfigService) => {
        const stt = config.providers.stt;
        return new SttRegistry(
          [
            new MockSttProvider(),
            new WhisperSttProvider(
              config.providers.ai.openAiApiKey,
              stt.model,
              stt.timeoutMs,
              stt.baseUrl,
            ),
            new GoogleSttProvider(stt.googleApiKey, stt.googleModel, stt.timeoutMs),
          ],
          stt.provider,
        );
      },
      inject: [AppConfigService],
    },
    {
      provide: STT_PROVIDER,
      useFactory: (registry: SttRegistry) => registry.active(),
      inject: [SttRegistry],
    },
  ],
  exports: [SttRegistry, STT_PROVIDER],
})
export class SttModule {}
