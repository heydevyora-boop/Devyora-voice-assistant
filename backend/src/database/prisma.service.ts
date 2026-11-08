import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfigService } from '../config/app-config.module';

/**
 * The Prisma client, owned by Nest's lifecycle.
 *
 * Connects on module init so a bad DATABASE_URL fails at boot rather than on
 * the first request, and disconnects on shutdown so the pool is released
 * cleanly instead of being torn down with the process.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      datasources: { db: { url: config.database.url } },
      log: config.app.isDevelopment
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /** Cheap liveness probe for the readiness endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(
        `Database ping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Run work in a single transaction.
   *
   * Thin on purpose: it exists so call sites read as `prisma.transaction(...)`
   * and so the isolation level is set in one place rather than guessed at per
   * use. `ReadCommitted` is Postgres's default; a caller that genuinely needs
   * `Serializable` passes it explicitly.
   */
  transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    return this.$transaction(work, {
      timeout: options?.timeoutMs ?? 10_000,
      isolationLevel: options?.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  /**
   * Development helper. Refuses to run anywhere else, because an accidental
   * truncate against a real database is unrecoverable.
   */
  async truncateAllTables(): Promise<void> {
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
      throw new Error('Refusing to truncate tables outside development and test.');
    }

    const tables = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;

    if (tables.length === 0) return;

    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}
