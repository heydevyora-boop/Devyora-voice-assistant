import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { HealthService } from './health.service';

/**
 * Liveness and readiness, kept separate on purpose.
 *
 * Liveness answers "is this process wedged" — an orchestrator restarts the
 * container when it fails. Readiness answers "can it serve traffic" — a load
 * balancer removes the instance but leaves it running, which is what you want
 * while a database blips.
 */
@ApiTags('health')
// VERSION_NEUTRAL, not a default version: probes must keep working
// unchanged when the API moves to v2.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @Public()
  @RawResponse()
  @ApiOperation({ summary: 'Liveness probe. True whenever the process is running.' })
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  @RawResponse()
  @ApiOperation({ summary: 'Readiness probe. Checks required dependencies.' })
  @ApiOkResponse({
    schema: { example: { status: 'ready', checks: { database: { status: 'up', latencyMs: 2 } } } },
  })
  @ApiServiceUnavailableResponse({ description: 'A required dependency is unavailable.' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.readiness();
    res.status(report.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
