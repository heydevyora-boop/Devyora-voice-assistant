import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { buildConfiguration, CONFIG_NAMESPACE, type Configuration } from './configuration';
import { validateEnv } from './env.validation';

/**
 * Typed access to configuration, available everywhere without re-importing.
 *
 * `AppConfigService.get()` returns the whole validated document, so callers
 * read `config.app.port` rather than guessing at a key string.
 */
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get(): Configuration {
    const value = this.configService.get<Configuration>(CONFIG_NAMESPACE);
    /* istanbul ignore next — unreachable once validation has run */
    if (!value) throw new Error('Configuration was not registered');
    return value;
  }

  get app() {
    return this.get().app;
  }
  get database() {
    return this.get().database;
  }
  get logging() {
    return this.get().logging;
  }
  get docs() {
    return this.get().docs;
  }
  get providers() {
    return this.get().providers;
  }
}

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // `.env` for local work; real deployments inject real environment
      // variables and this file simply will not exist.
      envFilePath: ['.env'],
      validate: validateEnv,
      load: [
        () => {
          const env = validateEnv(process.env as unknown as Record<string, unknown>);
          return { [CONFIG_NAMESPACE]: buildConfiguration(env) };
        },
      ],
    }),
  ],
  providers: [
    {
      provide: AppConfigService,
      useFactory: (configService: ConfigService) => new AppConfigService(configService),
      inject: [ConfigService],
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
