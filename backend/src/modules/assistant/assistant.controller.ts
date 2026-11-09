import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { RateLimit } from '../../security/rate-limits';
import { capabilitySummary, CAPABILITIES } from '../ai/capability-registry';
import { AssistantService } from './assistant.service';
import { AssistantTurnDto, DecideActionDto } from './dto/assistant.dto';

@ApiTags('assistant')
@Controller({ path: 'assistant', version: '1' })
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /**
   * One voice turn.
   *
   * Every platform — Windows, macOS, Android, iOS, web — posts here. The
   * transcript arrives as text, so speech recognition can live on the
   * device or on the server without this contract changing.
   */
  @Post('turn')
  // Each turn costs a provider call, so the ceiling is lower than the
  // global one and is about cost as much as abuse.
  @Throttle({ default: RateLimit.assistantTurn })
  @ApiOperation({
    summary: 'Interpret one utterance and plan a response.',
    description:
      'Returns the assistant’s reply plus, where an action is implied, a plan ' +
      'awaiting confirmation. Nothing is carried out by this route.',
  })
  turn(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @CurrentUser('sessionId') sessionId: string,
    @Body() dto: AssistantTurnDto,
    @Req() req: Request,
  ) {
    return this.assistant.handleTurn({
      userId,
      deviceId,
      sessionId,
      text: dto.text,
      conversationId: dto.conversationId,
      answersCommandId: dto.answersCommandId,
      meta: { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    });
  }

  /**
   * Approve or reject a proposed action.
   *
   * Approval carries the action out and the response describes what
   * actually happened, in the executor's own words. Rejection is permanent:
   * the action cannot be run later by a retry or a reconnect.
   */
  @Post('actions/:id/decision')
  @Throttle({ default: RateLimit.assistantDecision })
  @ApiOperation({ summary: 'Decide on a pending action, and carry it out if approved.' })
  decide(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Body() dto: DecideActionDto,
    @Req() req: Request,
  ) {
    return this.assistant.decide(userId, id, dto.approve, {
      // The device is part of ownership: a confirmation belongs to the
      // screen it appeared on, not to the account at large.
      deviceId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /**
   * Withdraw a proposal without answering it.
   *
   * Distinct from rejecting, and recorded distinctly: rejection is the user
   * saying no, cancellation is the user taking the question back. Both bar
   * execution permanently.
   */
  @Post('actions/:id/cancel')
  @Throttle({ default: RateLimit.assistantDecision })
  @ApiOperation({ summary: 'Cancel a pending action.' })
  cancel(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Req() req: Request,
  ) {
    return this.assistant.cancel(userId, id, {
      deviceId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /**
   * What the assistant can actually do.
   *
   * Served from the same table the orchestrator enforces, so a client cannot
   * end up advertising a capability the backend will refuse. Policy only —
   * no prompts and no provider details are exposed here.
   */
  @Get('capabilities')
  @ApiOperation({ summary: 'List the intents the assistant accepts.' })
  capabilities() {
    return {
      intents: Object.values(CAPABILITIES).map((c) => ({
        intent: c.intent,
        summary: c.summary,
        executionMode: c.executionMode,
        requiresConfirmation: c.requiresConfirmation,
        requiresConnection: c.requiresConnection,
        requiredEntities: c.requiredEntities,
      })),
      text: capabilitySummary(),
    };
  }
}
