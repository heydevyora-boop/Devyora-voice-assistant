import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AppError } from '../../common/errors/app-error';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { RateLimit } from '../../security/rate-limits';
import type { IntegrationOperation } from '../../providers/integrations/types';
import { ConnectionsService } from './connections.service';
import { IntegrationRegistry } from './integration.registry';
import { OAuthService } from './oauth.service';
import {
  ConnectWithSecretDto,
  ExecuteOperationDto,
  OAuthCallbackDto,
  StartAuthorizationDto,
} from './dto/integrations.dto';

/**
 * Third-party connections.
 *
 * No route on this controller can return a credential: `ConnectionView` has
 * no token field, and the only place a plaintext token exists is inside
 * `ConnectionsService` for the duration of one provider call.
 */
@ApiTags('integrations')
@Controller({ path: 'integrations', version: '1' })
export class IntegrationsController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly connections: ConnectionsService,
    private readonly registry: IntegrationRegistry,
  ) {}

  /**
   * What can be connected, and what each would actually give this user.
   *
   * Includes providers this deployment has not configured, marked as such —
   * a user should be able to see that Instagram exists and that it is not
   * available here, rather than wondering why it is missing.
   */
  @Get()
  @ApiOperation({ summary: 'Available integrations, their real capabilities and limitations.' })
  catalogue(@CurrentUser('userId') userId: string) {
    return this.connections.catalogue(userId);
  }

  @Get('connections')
  @ApiOperation({ summary: 'This account’s live connections. Never includes credentials.' })
  list(@CurrentUser('userId') userId: string) {
    return this.connections.list(userId);
  }

  /**
   * Starts an OAuth authorisation.
   *
   * Returns a URL for the client to open. Nothing is connected until the
   * user finishes on the provider's page and the callback arrives on the
   * same session.
   */
  @Post('authorize')
  @Throttle({ default: RateLimit.integrationAuthorize })
  @ApiOperation({ summary: 'Begin an OAuth flow.' })
  authorize(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() dto: StartAuthorizationDto,
    @Req() req: Request,
  ) {
    return this.oauth.start({
      userId,
      deviceId,
      provider: dto.provider,
      scopes: dto.scopes,
      meta: { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    });
  }

  /**
   * Completes an OAuth authorisation.
   *
   * Authenticated, and checked against the device that began the flow: a
   * code delivered to another browser is useless, which is the CSRF
   * defence. The state record is consumed once, so a replayed callback is
   * refused.
   */
  @Post('callback')
  @Throttle({ default: RateLimit.integrationAuthorize })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish an OAuth flow and store the connection.' })
  callback(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() dto: OAuthCallbackDto,
    @Req() req: Request,
  ) {
    return this.oauth.callback({
      userId,
      deviceId,
      state: dto.state,
      code: dto.code,
      meta: { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    });
  }

  /**
   * Connects a provider that uses a supplied credential rather than OAuth.
   *
   * Telegram is the case: a bot token from BotFather. Verified against the
   * provider before it is stored, so a typo is a failed attempt rather than
   * a connection that fails on first use.
   */
  @Post('connect')
  @Throttle({ default: RateLimit.integrationAuthorize })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Connect with a provider-issued token.' })
  connect(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() dto: ConnectWithSecretDto,
    @Req() req: Request,
  ) {
    return this.oauth.connectWithSecret(userId, deviceId, dto.provider, dto.secret, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /**
   * Disconnects, revoking at the provider where that is possible.
   *
   * The response says whether the provider was actually told. Deleting our
   * row alone would leave the grant live in the user's account.
   */
  @Delete('connections/:id')
  @ApiOperation({ summary: 'Disconnect an account and revoke the authorisation.' })
  disconnect(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Req() req: Request,
  ) {
    return this.connections.disconnect(userId, id, {
      deviceId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /** Renews an access token now, rather than waiting for the sweep. */
  @Post('connections/:id/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renew a connection’s access token.' })
  async refresh(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    // Ownership first: a connection id alone must not be enough to act.
    await this.connections.requireOwned(userId, id);
    return this.connections.refresh(id, { force: true });
  }

  /**
   * Performs a provider operation.
   *
   * The result carries `fidelity`, which is the field that matters:
   * `verified` means the effect was read back, `accepted` means the provider
   * took it, and `prepared` means a person still has to act.
   */
  @Post('operations')
  @Throttle({ default: RateLimit.integrationOperation })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run a supported operation through a connected provider.' })
  async execute(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() dto: ExecuteOperationDto,
    @Req() req: Request,
  ) {
    const known = new Set(
      this.registry.describe().flatMap((c) => c.operations.map((o) => o.operation)),
    );
    if (!known.has(dto.operation as IntegrationOperation)) {
      throw AppError.validation(`"${dto.operation}" is not an operation this server knows.`);
    }

    return this.connections.execute(
      userId,
      dto.provider,
      dto.operation as IntegrationOperation,
      dto.input ?? {},
      { deviceId, ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );
  }
}
