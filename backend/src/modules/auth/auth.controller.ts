import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RateLimit } from '../../security/rate-limits';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AppError } from '../../common/errors/app-error';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import type { AuthenticatedPrincipal } from '../../security/guards/jwt-auth.guard';
import { AppConfigService } from '../../config/app-config.module';
import {
  ACCESS_TOKEN_COOKIE,
  CSRF_COOKIE,
  REFRESH_TOKEN_COOKIE,
  accessCookieOptions,
  clearAuthCookies,
  csrfCookieOptions,
  readCookie,
  refreshCookieOptions,
} from '../../security/cookies';
import { AuthService, type AuthOutcome, type RequestMeta } from './auth.service';
import {
  AuthResultDto,
  ChangePasswordDto,
  ConfirmPasswordResetDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestPasswordResetDto,
  VerifyEmailDto,
} from './dto/auth.dto';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Post('register')
  @Public()
  // Registration is cheap to abuse; the limit is per source address.
  @Throttle({ default: RateLimit.register })
  @ApiOperation({ summary: 'Create an account and open the first session.' })
  @ApiOkResponse({ type: AuthResultDto })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const outcome = await this.auth.register(dto, meta(req));
    return this.present(outcome, res);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Tight: brute force is the realistic threat here. The account-level
  // lockout in AuthService complements it, so rotating addresses does not help.
  @Throttle({ default: RateLimit.login })
  @ApiOperation({ summary: 'Authenticate and open a session for a device.' })
  @ApiOkResponse({ type: AuthResultDto })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const outcome = await this.auth.login(dto, meta(req));
    return this.present(outcome, res);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: RateLimit.refresh })
  @ApiOperation({ summary: 'Rotate the refresh token and mint a new access token.' })
  @ApiBody({ type: RefreshDto, required: false })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Body for native clients, cookie for browsers.
    const fromCookie = readCookie(req, REFRESH_TOKEN_COOKIE);
    const token = dto.refreshToken ?? fromCookie;
    if (!token) throw AppError.unauthenticated('No refresh token was supplied.');

    const outcome = await this.auth.refresh(token, meta(req));
    // Keep the transport the caller used.
    return this.present({ ...outcome, clientType: fromCookie ? 'browser' : 'native' }, res);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the current session on this device.' })
  async logout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(principal.sessionId, principal.userId, meta(req));
    clearAuthCookies(res, { secure: this.secure });
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End every session on every device and invalidate issued tokens.' })
  async logoutAll(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const sessionsEnded = await this.auth.logoutEverywhere(principal.userId, meta(req));
    clearAuthCookies(res, { secure: this.secure });
    return { sessionsEnded };
  }

  @Post('password/change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change the password. Ends every session, including this one.' })
  async changePassword(
    @CurrentUser('userId') userId: string,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.changePassword(userId, dto, meta(req));
    clearAuthCookies(res, { secure: this.secure });
  }

  @Post('password/reset/request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: RateLimit.passwordResetRequest })
  @ApiOperation({
    summary: 'Request a reset link.',
    description:
      'Always reports acceptance, whether or not the address is registered, so the endpoint ' +
      'cannot be used to discover which addresses exist.',
  })
  async requestReset(@Body() dto: RequestPasswordResetDto, @Req() req: Request) {
    await this.auth.requestPasswordReset(dto.email, meta(req));
    return { accepted: true };
  }

  @Post('password/reset/confirm')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: RateLimit.passwordResetConfirm })
  @ApiOperation({ summary: 'Set a new password using a token from the reset email.' })
  async confirmReset(@Body() dto: ConfirmPasswordResetDto, @Req() req: Request): Promise<void> {
    await this.auth.confirmPasswordReset(dto.token, dto.newPassword, meta(req));
  }

  @Post('email/verify')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: RateLimit.emailVerify })
  @ApiOperation({ summary: 'Verify an email address using a token from the verification email.' })
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request): Promise<void> {
    await this.auth.verifyEmail(dto.token, meta(req));
  }

  @Post('email/verify/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: RateLimit.emailVerifyResend })
  @ApiOperation({ summary: 'Send the verification email again.' })
  async resendVerification(@CurrentUser() principal: AuthenticatedPrincipal) {
    await this.auth.sendEmailVerification({
      id: principal.userId,
      email: principal.email,
      emailVerifiedAt: null,
    });
    return { accepted: true };
  }

  @Get('session')
  @ApiOperation({ summary: 'Describe the session the current credentials belong to.' })
  session(@CurrentUser() principal: AuthenticatedPrincipal) {
    return {
      userId: principal.userId,
      sessionId: principal.sessionId,
      deviceId: principal.deviceId,
      transport: principal.viaCookie ? 'cookie' : 'bearer',
    };
  }

  // ───────────────────────────────────────────────────────────── helpers

  private get secure(): boolean {
    // A Secure cookie is dropped by browsers over plain http://localhost,
    // which would make local development impossible.
    return !this.config.app.isDevelopment;
  }

  /**
   * Shapes the response for the transport the client asked for.
   *
   * Browser: tokens go into HttpOnly cookies and are deliberately absent
   * from the body, so script cannot read them even if the page is
   * compromised. A readable CSRF cookie is set alongside.
   *
   * Native: tokens are returned in the body, because a native client has no
   * cookie jar and stores them in the platform keychain.
   */
  private present(outcome: AuthOutcome, res: Response): AuthResultDto {
    const { credentials, clientType } = outcome;
    const ctx = { secure: this.secure };
    const refreshMaxAge = Math.max(
      1,
      Math.floor((credentials.refreshExpiresAt.getTime() - Date.now()) / 1000),
    );

    if (clientType === 'browser') {
      res.cookie(ACCESS_TOKEN_COOKIE, credentials.accessToken, accessCookieOptions(ctx, credentials.expiresIn));
      res.cookie(REFRESH_TOKEN_COOKIE, credentials.refreshToken, refreshCookieOptions(ctx, refreshMaxAge));
      res.cookie(CSRF_COOKIE, credentials.csrfToken, csrfCookieOptions(ctx, refreshMaxAge));
    }

    return {
      user: {
        id: outcome.user.id,
        email: outcome.user.email,
        displayName: outcome.user.displayName,
        emailVerified: outcome.user.emailVerifiedAt !== null,
      },
      device: {
        id: outcome.device.id,
        publicId: outcome.device.publicId,
        platform: outcome.device.platform as AuthResultDto['device']['platform'],
        name: outcome.device.name,
      },
      tokens: {
        ...(clientType === 'browser'
          ? { csrfToken: credentials.csrfToken }
          : { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken }),
        expiresIn: credentials.expiresIn,
        tokenType: 'Bearer',
      },
    };
  }
}

function meta(req: Request): RequestMeta {
  return {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  };
}
