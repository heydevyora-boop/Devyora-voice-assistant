import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction, AuditService } from '../../security/services/audit.service';
import type { RequestMeta } from '../auth/auth.service';
import type { RegisterDeviceDto, UpdateDeviceDto } from './dto/devices.dto';

const DEVICE_SELECT = {
  id: true,
  publicId: true,
  platform: true,
  name: true,
  deviceType: true,
  model: true,
  appVersion: true,
  wakeWordCapable: true,
  pushToken: true,
  lastSeenAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Shaped for a response. `pushToken` is a routing credential for a push
   * service, so it is reported as present or absent rather than echoed.
   */
  private present(device: { pushToken: string | null } & Record<string, unknown>) {
    const { pushToken, ...rest } = device;
    return { ...rest, notificationsEnabled: pushToken !== null };
  }

  async list(userId: string, currentDeviceId: string) {
    const devices = await this.prisma.device.findMany({
      where: { userId },
      select: { ...DEVICE_SELECT, _count: { select: { sessions: { where: { endedAt: null } } } } },
      orderBy: [{ revokedAt: 'asc' }, { lastSeenAt: 'desc' }],
    });

    return devices.map(({ _count, ...device }) => ({
      ...this.present(device),
      activeSessions: _count.sessions,
      current: device.id === currentDeviceId,
      status: device.revokedAt ? ('revoked' as const) : ('active' as const),
    }));
  }

  /**
   * Registers an additional device for an already-authenticated user.
   *
   * This does not authenticate anything. The caller is identified by their
   * access token; the new record simply gives a future login something to
   * attach to.
   */
  async register(userId: string, dto: RegisterDeviceDto, meta: RequestMeta) {
    const device = await this.prisma.device.create({
      data: {
        userId,
        publicId: randomBytes(16).toString('base64url'),
        platform: dto.platform,
        name: dto.name,
        deviceType: dto.deviceType,
        model: dto.model,
        appVersion: dto.appVersion,
        wakeWordCapable: dto.wakeWordCapable ?? false,
        pushToken: dto.pushToken,
      },
      select: DEVICE_SELECT,
    });

    await this.audit.record({
      action: AuditAction.DEVICE_REGISTERED,
      userId,
      resource: 'device',
      resourceId: device.id,
      metadata: { platform: dto.platform },
      ...meta,
    });

    return this.present(device);
  }

  async update(userId: string, deviceId: string, dto: UpdateDeviceDto, meta: RequestMeta) {
    await this.requireOwned(userId, deviceId);

    const device = await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        name: dto.name,
        deviceType: dto.deviceType,
        appVersion: dto.appVersion,
        wakeWordCapable: dto.wakeWordCapable,
        // Explicit null clears the registration; undefined leaves it alone.
        pushToken: dto.pushToken === null ? null : dto.pushToken,
      },
      select: DEVICE_SELECT,
    });

    await this.audit.record({
      action: AuditAction.DEVICE_UPDATED,
      userId,
      resource: 'device',
      resourceId: deviceId,
      metadata: { fields: Object.keys(dto) },
      ...meta,
    });

    return this.present(device);
  }

  /**
   * Revokes a device and ends every session that belongs to it.
   *
   * The guard re-checks the device on each request, so a token already
   * issued to this device stops working on its next call rather than
   * lingering until it expires.
   */
  async revoke(userId: string, deviceId: string, meta: RequestMeta) {
    await this.requireOwned(userId, deviceId);
    const now = new Date();

    const sessionsEnded = await this.prisma.transaction(async (tx) => {
      const sessions = await tx.session.findMany({
        where: { deviceId, endedAt: null },
        select: { id: true },
      });
      const ids = sessions.map((s) => s.id);

      if (ids.length > 0) {
        await tx.refreshToken.updateMany({
          where: { sessionId: { in: ids }, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.session.updateMany({ where: { id: { in: ids } }, data: { endedAt: now } });
      }

      await tx.device.update({
        where: { id: deviceId },
        // The push token goes too: a revoked device must stop receiving
        // notifications, not just stop making requests.
        data: { revokedAt: now, pushToken: null },
      });

      return ids.length;
    });

    await this.audit.record({
      action: AuditAction.DEVICE_REVOKED,
      userId,
      resource: 'device',
      resourceId: deviceId,
      metadata: { sessionsEnded },
      ...meta,
    });

    return { revoked: true, sessionsEnded };
  }

  /** 404 rather than 403 — see tenant-scope for why. */
  private async requireOwned(userId: string, deviceId: string): Promise<void> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId },
      select: { id: true },
    });
    if (!device) throw AppError.notFound('Device');
  }
}
