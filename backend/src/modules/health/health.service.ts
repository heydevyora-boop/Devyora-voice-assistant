import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { PrismaService } from '../../database/prisma.service';
import { LlmRegistry } from '../../providers/llm/llm.module';
import { SttRegistry } from '../../providers/stt/stt.module';
import { TtsRegistry } from '../../providers/tts/tts.module';

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

  async readiness(): Promise<ReadinessReport> {
    const checks: Record<string, DependencyReport> = {
      database: await this.checkDatabase(),
      redis: this.checkRedis(),
      interpreter: this.checkInterpreter(),
      recogniser: this.checkRecogniser(),
      synthesiser: this.checkSynthesiser(),
    };

    // Only a dependency the application actually requires can fail readiness.
    const required: Array<keyof typeof checks> = ['database'];
    const ready = required.every((key) => checks[key].status === 'up');

    return { status: ready ? 'ready' : 'degraded', checks };
  }
}
