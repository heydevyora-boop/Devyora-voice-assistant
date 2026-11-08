import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import type { AuthenticatedPrincipal } from '../../security/guards/jwt-auth.guard';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto, UpdateDeviceDto } from './dto/devices.dto';

@ApiTags('devices')
@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({ summary: 'List this account’s devices.' })
  list(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.devices.list(principal.userId, principal.deviceId);
  }

  @Post()
  @ApiOperation({
    summary: 'Register another device.',
    description:
      'Requires an existing session. Registration does not authenticate anything — the ' +
      'returned identifier lets a later login reuse this record.',
  })
  register(
    @CurrentUser('userId') userId: string,
    @Body() dto: RegisterDeviceDto,
    @Req() req: Request,
  ) {
    return this.devices.register(userId, dto, meta(req));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update device metadata or its push registration.' })
  update(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) deviceId: string,
    @Body() dto: UpdateDeviceDto,
    @Req() req: Request,
  ) {
    return this.devices.update(userId, deviceId, dto, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a device and end its sessions.',
    description: 'Tokens already issued to that device stop working on their next request.',
  })
  revoke(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) deviceId: string,
    @Req() req: Request,
  ) {
    return this.devices.revoke(userId, deviceId, meta(req));
  }
}

function meta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}
