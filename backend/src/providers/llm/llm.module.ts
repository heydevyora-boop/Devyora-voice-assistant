import { Global, Logger, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { GeminiProvider } from './gemini.provider';
import { MockLlmProvider } from './mock.provider';
import { OpenAiProvider } from './openai.provider';
import { LLM_PROVIDER, type LlmProvider, type LlmProviderHealth } from './types';

/**
 * Chooses the provider and keeps the alternatives addressable.
 *
 * Selection is explicit configuration, with one safety rule: a provider that
 * has no credential is never selected, however it is configured. Falling
 * back silently to a different vendor would change where a user's words are
 * sent without anyone deciding that, so the fallback here is to the local
 * stand-in — which cannot leak anything — and it is reported, not hidden.
 */
export class LlmRegistry {
  private readonly logger = new Logger(LlmRegistry.name);
  private readonly providers: LlmProvider[];
  private readonly selected: LlmProvider;

  constructor(providers: LlmProvider[], requested: string) {
    this.providers = providers;

    const match = providers.find((p) => p.id === requested);
    if (match?.configured) {
      this.selected = match;
    } else {
      this.selected = providers.find((p) => p.id === 'mock')!;
      this.logger.warn(
        match
          ? `AI_PROVIDER is "${requested}" but it has no credential; using the ` +
              'deterministic stand-in. Responses are not from a language model.'
          : `AI_PROVIDER "${requested}" is unknown; using the deterministic stand-in.`,
      );
    }
  }

  active(): LlmProvider {
    return this.selected;
  }

  byId(id: string): LlmProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  list(): readonly LlmProvider[] {
    return this.providers;
  }

  /** Health of every registered provider, for the readiness endpoint. */
  healthAll(): Promise<LlmProviderHealth[]> {
    return Promise.all(this.providers.map((p) => p.health()));
  }
}

@Global()
@Module({
  providers: [
    {
      provide: LlmRegistry,
      useFactory: (config: AppConfigService) => {
        const ai = config.providers.ai;
        return new LlmRegistry(
          [
            new MockLlmProvider(),
            new OpenAiProvider(ai.openAiApiKey, ai.openAiModel, ai.timeoutMs),
            new GeminiProvider(ai.geminiApiKey, ai.geminiModel, ai.timeoutMs),
          ],
          ai.provider,
        );
      },
      inject: [AppConfigService],
    },
    {
      // The active provider, injectable directly where the registry itself
      // is not needed.
      provide: LLM_PROVIDER,
      useFactory: (registry: LlmRegistry) => registry.active(),
      inject: [LlmRegistry],
    },
  ],
  exports: [LlmRegistry, LLM_PROVIDER],
})
export class LlmModule {}
