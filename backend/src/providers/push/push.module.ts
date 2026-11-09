import { Global, Logger, Module } from '@nestjs/common';
import type { DevicePlatform } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.module';
import { ApnsPushProvider } from './apns.provider';
import { FcmPushProvider } from './fcm.provider';
import { MockPushProvider } from './mock.provider';
import { PUSH_PROVIDER, type PushProvider, type PushProviderHealth } from './types';

/**
 * Chooses a transport per device platform.
 *
 * Unlike the other registries this one does not pick a single provider:
 * Android and iOS need different transports, and a user's devices can span
 * both. So selection is per platform, and the same credential rule applies —
 * a provider with no credential is never selected, and the fallback is the
 * recording stand-in rather than a different vendor.
 *
 * A platform with no configured transport is reported as having none, which
 * is what makes a notification `UNDELIVERABLE` rather than silently lost.
 */
export class PushRegistry {
  private readonly logger = new Logger(PushRegistry.name);
  private readonly providers: PushProvider[];
  private readonly preferred: readonly string[];

  constructor(providers: PushProvider[], preferred: readonly string[]) {
    this.providers = providers;
    this.preferred = preferred;

    const configured = providers.filter((p) => p.kind === 'real' && p.configured);
    if (configured.length === 0) {
      this.logger.warn(
        'No push transport is configured. Reminders will still appear in-app, and ' +
          'notifications for devices with no transport are recorded as undeliverable ' +
          'rather than reported as sent.',
      );
    } else {
      this.logger.log(`Push transports: ${configured.map((p) => p.id).join(', ')}.`);
    }
  }

  /**
   * The transport for a platform, or null.
   *
   * Preference order is configuration, so a deployment registered through
   * Firebase for both platforms can say so and a deployment using APNs
   * directly for iOS can say that instead.
   */
  forPlatform(platform: DevicePlatform): PushProvider | null {
    for (const id of this.preferred) {
      const provider = this.providers.find(
        (p) => p.id === id && p.configured && p.platforms.includes(platform),
      );
      if (provider) return provider;
    }

    return (
      this.providers.find(
        (p) => p.kind === 'real' && p.configured && p.platforms.includes(platform),
      ) ??
      this.providers.find((p) => p.kind === 'mock' && p.platforms.includes(platform)) ??
      null
    );
  }

  byId(id: string): PushProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  list(): readonly PushProvider[] {
    return this.providers;
  }

  /** Whether any real transport exists at all. */
  get hasRealTransport(): boolean {
    return this.providers.some((p) => p.kind === 'real' && p.configured);
  }

  healthAll(): Promise<PushProviderHealth[]> {
    return Promise.all(this.providers.map((p) => p.health()));
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PushRegistry,
      useFactory: (config: AppConfigService) => {
        const push = config.providers.push;
        return new PushRegistry(
          [
            new MockPushProvider(),
            new FcmPushProvider(push.fcmServiceAccount),
            new ApnsPushProvider({
              keyId: push.apnsKeyId,
              teamId: push.apnsTeamId,
              bundleId: push.apnsBundleId,
              privateKey: push.apnsPrivateKey,
              sandbox: push.apnsSandbox,
            }),
          ],
          push.preferred,
        );
      },
      inject: [AppConfigService],
    },
    {
      provide: PUSH_PROVIDER,
      useFactory: (registry: PushRegistry) => registry,
      inject: [PushRegistry],
    },
  ],
  exports: [PushRegistry, PUSH_PROVIDER],
})
export class PushModule {}
