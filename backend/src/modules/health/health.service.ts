import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { PrismaService } from '../../database/prisma.service';
import { LlmRegistry } from '../../providers/llm/llm.module';
import { SttRegistry } from '../../providers/stt/stt.module';
import { TtsRegistry } from '../../providers/tts/tts.module';
import { PushRegistry } from '../../providers/push/push.module';
import { QueueService } from '../../jobs/queue.service';

export type DependencyState = 'up' | 'down' | 'not-configured';

export interface DependencyReport {
  readonly status: DependencyState;
  readonly latencyMs?: number;
  /**
   * Set when the dependency is answering but is not the real thing. The
   * stand-in interpreter is the case this exists for: readiness must not
   * read as healthy in a way that hides it.
   */
  readonly degraded?: true;
  readonly detail?: string;
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
    private readonly llm: LlmRegistry,
    private readonly stt: SttRegistry,
    private readonly tts: TtsRegistry,
    private readonly push: PushRegistry,
    private readonly queue: QueueService,
  ) {}

  async checkDatabase(): Promise<DependencyReport> {
    const startedAt = Date.now();
    const ok = await this.prisma.ping();
    return ok ? { status: 'up', latencyMs: Date.now() - startedAt } : { status: 'down' };
  }

  /**
   * The interpreter the assistant would actually use.
   *
   * Reported as `up` with `degraded` set when the active provider is the
   * deterministic stand-in: the process can serve traffic, so readiness
   * passes, but anyone reading the probe can see that answers are not
   * coming from a language model. Which vendor is selected is named;
   * credentials and endpoints are not.
   */
  checkInterpreter(): DependencyReport {
    const provider = this.llm.active();
    if (provider.kind === 'mock') {
      return {
        status: 'up',
        degraded: true,
        detail: 'Deterministic stand-in: no language model is configured.',
      };
    }
    return { status: 'up', detail: `Provider "${provider.id}" is configured.` };
  }

  /**
   * The recogniser the voice pipeline would actually use.
   *
   * `degraded` while the stand-in is active, for the same reason as the
   * interpreter: the process serves traffic, so readiness passes, but a
   * deployment that meant to recognise speech can see that it does not.
   */
  checkRecogniser(): DependencyReport {
    const provider = this.stt.active();
    if (provider.kind === 'mock') {
      return {
        status: 'up',
        degraded: true,
        detail: 'Deterministic stand-in: no speech recognition is configured.',
      };
    }
    return { status: 'up', detail: `Recogniser "${provider.id}" is configured.` };
  }

  /**
   * Speech synthesis.
   *
   * Never required: a reply without a voice is still a reply, so this
   * cannot fail readiness and reports `not-configured` rather than `down`
   * when there is nothing to speak with.
   */
  checkSynthesiser(): DependencyReport {
    const provider = this.tts.active();
    if (provider.kind === 'mock') {
      return {
        status: 'not-configured',
        detail: 'No speech synthesis is configured; replies are text only.',
      };
    }
    return { status: 'up', detail: `Synthesiser "${provider.id}" is configured.` };
  }

  /**
   * Durable scheduling.
   *
   * This one **can** fail readiness, unlike the provider stand-ins. A
   * process with no queue does not deliver reminders, and a reminder that
   * never arrives is a broken promise rather than a degraded feature — so
   * an instance in that state should be taken out of rotation if another
   * can serve. It reports `not-configured` rather than `down` when no
   * REDIS_URL is set at all, because then nothing was promised.
   */
  checkScheduler(): DependencyReport {
    if (!this.config.providers.redisUrl) {
      return {
        status: 'not-configured',
        detail: 'No REDIS_URL: reminders are stored but will not be delivered.',
      };
    }
    return this.queue.available
      ? { status: 'up', detail: 'Durable scheduling is available.' }
      : { status: 'down', detail: 'Redis is configured but unreachable.' };
  }

  /**
   * Push transports.
   *
   * Never required: a notification with no transport is recorded as
   * undeliverable and still appears in-app, so this cannot hold readiness
   * down.
   */
  checkPush(): DependencyReport {
    if (!this.push.hasRealTransport) {
      return {
        status: 'not-configured',
        detail: 'No push transport; notifications are available in-app only.',
      };
    }
    return {
      status: 'up',
      detail: `Transports: ${this.push
        .list()
        .filter((p) => p.kind === 'real' && p.configured)
        .map((p) => p.id)
        .join(', ')}.`,
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const checks: Record<string, DependencyReport> = {
      database: await this.checkDatabase(),
      interpreter: this.checkInterpreter(),
      recogniser: this.checkRecogniser(),
      synthesiser: this.checkSynthesiser(),
      scheduler: this.checkScheduler(),
      push: this.checkPush(),
    };

    // Only a dependency the application actually requires can fail
    // readiness, and only by being *down* — `not-configured` means nothing
    // was promised. The scheduler is required because an instance that
    // cannot deliver reminders is not serving the product, even though it
    // can answer requests.
    const required: Array<keyof typeof checks> = ['database', 'scheduler'];
    const ready = required.every((key) => checks[key].status !== 'down');

    return { status: ready ? 'ready' : 'degraded', checks };
  }
}
