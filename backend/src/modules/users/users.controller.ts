import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import type { AuthenticatedPrincipal } from '../../security/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/users.dto';

/**
 * Everything here acts on the authenticated user and only on them.
 *
 * There is no `/users/:id`. The identity comes from the verified token, so
 * no route can be pointed at another account by changing a path parameter.
 */
@ApiTags('users')
@Controller({ path: 'me', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Current user profile.' })
  profile(@CurrentUser('userId') userId: string) {
    return this.users.profile(userId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update display name, locale or time zone.' })
  update(@CurrentUser('userId') userId: string, @Body() dto: UpdateProfileDto, @Req() req: Request) {
    return this.users.updateProfile(userId, dto, requestMeta(req));
  }

  @Post('deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend the account and end every session.' })
  deactivate(@CurrentUser('userId') userId: string, @Req() req: Request) {
    return this.users.deactivate(userId, requestMeta(req));
  }

  @Delete()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request account deletion.',
    description:
      'Access ends immediately. Stored data is removed permanently after a grace period, ' +
      'by a background job.',
  })
  requestDeletion(@CurrentUser('userId') userId: string, @Req() req: Request) {
    return this.users.requestDeletion(userId, requestMeta(req));
  }

  @Get('export')
  @ApiOperation({ summary: 'Export everything held about this account, as JSON.' })
  exportData(@CurrentUser('userId') userId: string, @Req() req: Request) {
    return this.users.exportData(userId, requestMeta(req));
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List sessions, marking the current one.' })
  sessions(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.users.listSessions(principal.userId, principal.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one session.' })
  revokeSession(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) sessionId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.users.revokeSession(userId, sessionId, requestMeta(req));
  }
}

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}
