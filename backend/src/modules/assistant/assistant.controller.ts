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
    @Body() dto: AssistantTurnDto,
    @Req() req: Request,
  ) {
    return this.assistant.handleTurn({
      userId,
      deviceId,
      text: dto.text,
      conversationId: dto.conversationId,
      answersCommandId: dto.answersCommandId,
      meta: { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    });
  }

  /**
   * Approve or reject a proposed action.
   *
   * Approval records the decision and queues the action. It does not run it,
   * and the response says so in as many words, because an executor does not
   * exist in this build.
   */
  @Post('actions/:id/decision')
  @Throttle({ default: RateLimit.assistantDecision })
  @ApiOperation({ summary: 'Decide on a pending action.' })
  decide(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Body() dto: DecideActionDto,
    @Req() req: Request,
  ) {
    return this.assistant.decide(userId, id, dto.approve, {
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
