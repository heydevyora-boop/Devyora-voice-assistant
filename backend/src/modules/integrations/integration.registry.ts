import { Injectable, Logger } from '@nestjs/common';
import { ConnectionProvider } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.module';
import { AssistedIntegrationProvider } from '../../providers/integrations/assisted.provider';
import { GoogleIntegrationProvider } from '../../providers/integrations/google.provider';
import { MetaIntegrationProvider } from '../../providers/integrations/meta.provider';
import { TelegramIntegrationProvider } from '../../providers/integrations/telegram.provider';
import type {
  IntegrationCapabilities,
  IntegrationProvider,
  ProviderHealth,
} from '../../providers/integrations/types';

/**
 * Every integration this backend knows, by provider and by connector kind.
 *
 * Two lookups rather than one, because a provider can have more than one
 * connector and they are not interchangeable: WhatsApp has an official API
 * connector for a business account **and** a user-assisted connector for
 * everybody else. Asking for "the WhatsApp provider" without saying which
 * is how a hand-off comes to be reported as a send.
 *
 * The set is fixed at construction. There is no registration method and
 * nothing reads configuration at request time, so what this server can
 * connect to is decided at startup and is readable in one file.
 */
@Injectable()
export class IntegrationRegistry {
  private readonly logger = new Logger(IntegrationRegistry.name);

  private readonly officialByProvider: ReadonlyMap<ConnectionProvider, IntegrationProvider>;
  private readonly assistedByProvider: ReadonlyMap<ConnectionProvider, IntegrationProvider>;

  constructor(config: AppConfigService) {
    const integrations = config.providers.integrations;

    const official: IntegrationProvider[] = [
      new GoogleIntegrationProvider(
        ConnectionProvider.GMAIL,
        integrations.googleClientId,
        integrations.googleClientSecret,
      ),
      new GoogleIntegrationProvider(
        ConnectionProvider.GOOGLE_CALENDAR,
        integrations.googleClientId,
        integrations.googleClientSecret,
      ),
      new MetaIntegrationProvider(
        ConnectionProvider.WHATSAPP,
        integrations.metaAppId,
        integrations.metaAppSecret,
        integrations.whatsappPhoneNumberId,
      ),
      new MetaIntegrationProvider(
        ConnectionProvider.INSTAGRAM,
        integrations.metaAppId,
        integrations.metaAppSecret,
        undefined,
      ),
      new MetaIntegrationProvider(
        ConnectionProvider.FACEBOOK,
        integrations.metaAppId,
        integrations.metaAppSecret,
        undefined,
      ),
      new TelegramIntegrationProvider(),
    ];

    // The assisted route exists for the providers a person can plausibly
    // have without a business account.
    const assisted: IntegrationProvider[] = [
      new AssistedIntegrationProvider(ConnectionProvider.WHATSAPP),
      new AssistedIntegrationProvider(ConnectionProvider.TELEGRAM),
      new AssistedIntegrationProvider(ConnectionProvider.GMAIL),
    ];

    this.officialByProvider = new Map(official.map((p) => [p.provider, p]));
    this.assistedByProvider = new Map(assisted.map((p) => [p.provider, p]));

    const ready = official.filter((p) => p.configured).map((p) => p.provider);
    this.logger.log(
      `Integrations: ${official.length} official connectors (${
        ready.length > 0 ? `configured: ${ready.join(', ')}` : 'none configured'
      }), ${assisted.length} assisted.`,
    );
  }

  /** The official API connector for a provider, if there is one. */
  official(provider: ConnectionProvider): IntegrationProvider | undefined {
    return this.officialByProvider.get(provider);
  }

  /** The user-assisted connector for a provider, if there is one. */
  assisted(provider: ConnectionProvider): IntegrationProvider | undefined {
    return this.assistedByProvider.get(provider);
  }

  /**
   * The connector to use for a provider the user has connected or not.
   *
   * Prefers the official connector **only when a live connection exists**.
   * Without one it falls back to the assisted route, which needs no
   * account — so a user with a personal WhatsApp gets a working draft
   * rather than an error about business verification.
   */
  forUse(
    provider: ConnectionProvider,
    hasConnection: boolean,
  ): IntegrationProvider | undefined {
    if (hasConnection) {
      const api = this.official(provider);
      if (api?.configured) return api;
    }
    return this.assisted(provider) ?? this.official(provider);
  }

  list(): readonly IntegrationProvider[] {
    return [...this.officialByProvider.values(), ...this.assistedByProvider.values()];
  }

  /** Every provider's capabilities, for the connections screen. */
  describe(): IntegrationCapabilities[] {
    return this.list().map((p) => p.capabilities());
  }

  healthAll(): Promise<ProviderHealth[]> {
    return Promise.all(this.list().map((p) => p.health()));
  }

  /** Whether any official integration is usable at all. */
  get hasConfiguredIntegration(): boolean {
    return [...this.officialByProvider.values()].some((p) => p.configured);
  }
}
