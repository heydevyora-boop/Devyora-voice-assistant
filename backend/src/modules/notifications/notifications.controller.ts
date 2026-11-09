import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { PrismaService } from '../../database/prisma.service';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { PushRegistry } from '../../providers/push/push.module';
import { NotificationsService } from './notifications.service';
import { ListNotificationsQueryDto, RegisterPushTokenDto } from './dto/notifications.dto';

@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly push: PushRegistry,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * This account's notifications.
   *
   * The in-app channel, and the one that always works: a notification whose
   * push could not be delivered is still here, marked `UNDELIVERABLE`, so a
   * user who opens the app sees what they missed.
   */
  @Get()
  @ApiOperation({ summary: 'List notifications, newest first.' })
  list(
    @CurrentUser('userId') userId: string,
    @Query() page: PaginationQueryDto,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notifications.list(userId, page, query.unreadOnly ?? false);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many are unread.' })
  unread(@CurrentUser('userId') userId: string) {
    return this.notifications.unreadCount(userId);
  }

  /**
   * What transports exist.
   *
   * Served so a client can tell the user that push is not set up, rather
   * than leaving them to wonder why a reminder never arrived.
   */
  @Get('transports')
  @ApiOperation({ summary: 'Which push transports are configured.' })
  async transports(@CurrentUser('userId') userId: string) {
    const devices = await this.prisma.device.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, platform: true, name: true, pushToken: true },
    });

    return {
      hasRealTransport: this.push.hasRealTransport,
      providers: this.push.list().map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        configured: p.configured,
        platforms: p.platforms,
      })),
      devices: devices.map((d) => {
        const provider = this.push.forPlatform(d.platform);
        return {
          deviceId: d.id,
          name: d.name,
          platform: d.platform,
          registered: d.pushToken !== null,
          provider: provider ? { id: provider.id, isMock: provider.kind === 'mock' } : null,
          // Stated per device, because this is the thing a user actually
          // needs to know.
          reachable: d.pushToken !== null && provider !== null,
        };
      }),
    };
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register or clear this device’s push token.',
    description: 'The token is stored on the device record; it is not duplicated elsewhere.',
  })
  async registerToken(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() dto: RegisterPushTokenDto,
  ) {
    await this.prisma.device.updateMany({
      where: { id: deviceId, userId },
      data: { pushToken: dto.pushToken ?? null },
    });
    return { registered: dto.pushToken ? true : false };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one as read.' })
  markRead(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.notifications.markRead(userId, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every notification read.' })
  markAllRead(@CurrentUser('userId') userId: string) {
    return this.notifications.markAllRead(userId);
  }
}
