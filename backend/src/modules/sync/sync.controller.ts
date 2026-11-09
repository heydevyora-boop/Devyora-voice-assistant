import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { RateLimit } from '../../security/rate-limits';
import { SyncService } from './sync.service';
import { PullQueryDto, SyncPushDto } from './dto/sync.dto';

/**
 * Offline-first synchronisation.
 *
 * Both routes are scoped to the authenticated user *and* the calling device:
 * the cursor belongs to a device, and a record belongs to an account. There
 * is no path here that reaches another account's data, and a client id is
 * not a capability — one user's `note-1` is a different row from another's.
 */
@ApiTags('sync')
@Controller({ path: 'sync', version: '1' })
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('status')
  @ApiOperation({
    summary: 'What this device has seen, and roughly how far behind it is.',
  })
  status(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
  ) {
    return this.sync.status({ userId, deviceId });
  }

  @Get('pull')
  @Throttle({ default: RateLimit.syncPull })
  @ApiOperation({
    summary: 'Everything changed since the cursor, tombstones included.',
    description:
      'A deleted record arrives with `deleted: true` rather than being absent, because ' +
      'a device that was offline has to learn that it went.',
  })
  pull(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Query() query: PullQueryDto,
  ) {
    return this.sync.pull({ userId, deviceId }, query);
  }

  @Post('push')
  @Throttle({ default: RateLimit.syncPush })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upload locally-changed records.',
    description:
      'Per-record outcomes: one conflict does not fail the batch. A record reported as ' +
      '`conflict` was NOT applied, and the server’s copy is returned with it.',
  })
  push(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() body: SyncPushDto,
  ) {
    return this.sync.push({ userId, deviceId }, body);
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Forget this device’s cursor, so the next pull is a full one.',
    description: 'Touches no data — only this device’s watermark.',
  })
  reset(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
  ) {
    return this.sync.reset({ userId, deviceId });
  }
}
