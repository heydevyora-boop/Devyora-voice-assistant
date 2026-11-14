import { Global, Module } from '@nestjs/common';
import { ConnectionsService } from './connections.service';
import { IntegrationRegistry } from './integration.registry';
import { IntegrationsController } from './integrations.controller';
import { OAuthService } from './oauth.service';

/**
 * Third-party integrations.
 *
 * Global because the action layer and the maintenance workers both need the
 * connections service, and a feature module importing the whole integration
 * module to reach it would create a cycle.
 */
@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationRegistry, OAuthService, ConnectionsService],
  exports: [IntegrationRegistry, OAuthService, ConnectionsService],
})
export class IntegrationsModule {}
