import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { LogMailProvider, MAIL_PROVIDER } from '../../providers/mail/mail.provider';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      // One seam for mail. A real provider is registered here when one is
      // chosen; nothing else in the codebase changes.
      provide: MAIL_PROVIDER,
      useFactory: (config: AppConfigService) => new LogMailProvider(config),
      inject: [AppConfigService],
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
