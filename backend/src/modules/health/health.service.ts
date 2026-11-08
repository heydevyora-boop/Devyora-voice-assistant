import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { PrismaService } from '../../database/prisma.service';

export type DependencyState = 'up' | 'down' | 'not-configured';

export interface DependencyReport {
  readonly status: DependencyState;
  readonly latencyMs?: number;
}

export interface ReadinessReport {
  readonly status: 'ready' | 'degraded';
  readonly checks: Record<string, DependencyReport>;
}

/**
 * Dependency checks behind the health endpoints.
 *
 * Reports state and latency only. Hostnames, versions, connection strings and
 * driver errors stay in the logs — a public probe should not describe the
 * infrastructure to whoever calls it.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async checkDatabase(): Promise<DependencyReport> {
    const startedAt = Date.now();
    const ok = await this.prisma.ping();
    return ok ? { status: 'up', latencyMs: Date.now() - startedAt } : { status: 'down' };
  }

  /**
   * Redis arrives with the background-job work. Until it is configured this
   * reports `not-configured`, which is honest and does not fail readiness —
   * nothing depends on it yet.
   */
  checkRedis(): DependencyReport {
    return this.config.providers.redisUrl ? { status: 'down' } : { status: 'not-configured' };
  }

  async readiness(): Promise<ReadinessReport> {
    const checks: Record<string, DependencyReport> = {
      database: await this.checkDatabase(),
      redis: this.checkRedis(),
    };

    // Only a dependency the application actually requires can fail readiness.
    const required: Array<keyof typeof checks> = ['database'];
    const ready = required.every((key) => checks[key].status === 'up');

    return { status: ready ? 'ready' : 'degraded', checks };
  }
}
