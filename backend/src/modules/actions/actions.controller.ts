import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { RateLimit } from '../../security/rate-limits';
import { LAUNCHABLE_APPLICATIONS } from './handlers/apps.actions';
import { MESSAGING_PLATFORMS } from './handlers/messaging.actions';
import { ActionExecutorService } from './action-executor.service';
import { PermissionsService } from './permissions.service';
import { ActionRegistry } from './registry/action.registry';
import { ActionHistoryQueryDto, ExecuteActionDto } from './dto/actions.dto';

@ApiTags('actions')
@Controller({ path: 'actions', version: '1' })
export class ActionsController {
  constructor(
    private readonly registry: ActionRegistry,
    private readonly executor: ActionExecutorService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * The allow-list, as the server sees it.
   *
   * Served from the same definitions the executor runs, so a client cannot
   * end up offering something the backend will refuse. No schemas, no
   * handlers: what an action needs and whether it must be confirmed, and
   * nothing about how it is implemented.
   */
  @Get()
  @ApiOperation({ summary: 'List the actions this backend can perform.' })
  list() {
    return {
      actions: this.registry.describe(),
      applications: LAUNCHABLE_APPLICATIONS,
      messaging: MESSAGING_PLATFORMS,
    };
  }

  /**
   * What this user and device may currently do.
   *
   * Useful to a client that wants to hide a control rather than let the
   * user discover a refusal — and it is only a view. The permission check
   * that matters runs again at execution time.
   */
  @Get('permissions')
  @ApiOperation({ summary: 'Permissions currently granted to this user and device.' })
  async granted(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
  ) {
    const { granted, denial } = await this.permissions.resolve({ userId, deviceId });
    return {
      granted: [...granted].sort(),
      denial: denial ? { code: denial.code, detail: denial.detail } : null,
    };
  }

  /**
   * Runs an approved action.
   *
   * The route exists for a client that confirmed through a different
   * surface and now wants the action carried out — the assistant's own
   * `decide` route does both in one call. Either way the executor applies
   * the same checks: ownership, device, expiry, confirmation policy,
   * authorization, and a single claim.
   */
  @Post(':id/execute')
  @Throttle({ default: RateLimit.actionExecute })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Execute a pending action that has been approved.',
    description:
      'Idempotent: a replayed request is handed the original outcome rather than ' +
      'running the action a second time.',
  })
  execute(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @CurrentUser('sessionId') sessionId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Body() dto: ExecuteActionDto,
    @Req() req: Request,
  ) {
    return this.executor.execute({
      userId,
      deviceId,
      sessionId,
      pendingActionId: id,
      clientIdempotencyKey: dto.idempotencyKey,
      meta: { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    });
  }

  /**
   * What this account has had carried out.
   *
   * Outcomes only. Parameters are not stored on an execution record, so
   * there is nothing here to leak: the message someone wrote lives on the
   * pending action and goes when that is purged.
   */
  @Get('history')
  @ApiOperation({ summary: 'Recent action executions for this account.' })
  history(@CurrentUser('userId') userId: string, @Query() query: ActionHistoryQueryDto) {
    return this.executor.history(userId, query.limit ?? 20);
  }
}
