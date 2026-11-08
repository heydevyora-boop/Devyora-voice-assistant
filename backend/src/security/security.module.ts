import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditService } from './services/audit.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';

/**
 * Cross-cutting security services.
 *
 * Global because auditing and token handling are needed by several feature
 * modules, and duplicating the providers would duplicate their state.
 *
 * `JwtModule` is registered without a secret on purpose: the secret is
 * resolved per call in TokenService, which keeps access and refresh signing
 * keys genuinely separate instead of sharing one module-level default.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [PasswordService, TokenService, AuditService],
  exports: [PasswordService, TokenService, AuditService],
})
export class SecurityModule {}
