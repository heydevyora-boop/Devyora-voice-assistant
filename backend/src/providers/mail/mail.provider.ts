import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';

export interface VerificationEmail {
  readonly to: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface MailProvider {
  readonly id: string;
  readonly configured: boolean;
  sendEmailVerification(message: VerificationEmail): Promise<void>;
  sendPasswordReset(message: VerificationEmail): Promise<void>;
}

/**
 * Mail delivery, for a build with no mail service configured.
 *
 * No email provider has been selected or provisioned, so nothing is sent.
 * Rather than pretend otherwise, this writes the link to the server log in
 * development — which is enough to complete a real flow locally — and
 * refuses outright anywhere else.
 *
 * What it will not do is hand the token back through the API. A reset flow
 * that returns its own token to the caller is not a reset flow; it is an
 * account takeover endpoint. Verification therefore only ever succeeds when
 * a token that was genuinely delivered is presented back.
 */
@Injectable()
export class LogMailProvider implements MailProvider {
  readonly id = 'log';
  readonly configured = false;
  private readonly logger = new Logger('Mail');

  constructor(private readonly config: AppConfigService) {}

  sendEmailVerification(message: VerificationEmail): Promise<void> {
    return this.deliver('email verification', message);
  }

  sendPasswordReset(message: VerificationEmail): Promise<void> {
    return this.deliver('password reset', message);
  }

  private deliver(kind: string, message: VerificationEmail): Promise<void> {
    if (this.config.app.isProduction || this.config.app.env === 'staging') {
      // Louder than a silent no-op: a deployed environment that cannot send
      // mail has a broken flow, and the operator needs to know.
      return Promise.reject(
        new Error(
          `No mail provider is configured, so the ${kind} message to ${message.to} was not sent.`,
        ),
      );
    }

    this.logger.warn(
      `[development only] No mail provider configured. ${kind} token for ${message.to}: ` +
        `${message.token} (expires ${message.expiresAt.toISOString()})`,
    );
    return Promise.resolve();
  }
}

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');
