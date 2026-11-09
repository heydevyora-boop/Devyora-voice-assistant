import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/app-error';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { AppConfigService } from '../../config/app-config.module';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { RateLimit } from '../../security/rate-limits';
import { SUPPORTED_FORMATS } from './audio/audio-format';
import {
  ResumeVoiceSessionDto,
  StartVoiceSessionDto,
  SubmitAudioDto,
  SubmitTranscriptDto,
} from './dto/voice.dto';
import { SttService } from './stt.service';
import { TtsService } from './tts.service';
import { VoiceSessionService } from './voice-session.service';
import { VoiceService } from './voice.service';
import { VOICE_EVENTS } from './voice-events';

@ApiTags('voice')
@Controller({ path: 'voice', version: '1' })
export class VoiceController {
  constructor(
    private readonly voice: VoiceService,
    private readonly sessions: VoiceSessionService,
    private readonly stt: SttService,
    private readonly tts: TtsService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * What this backend can do with voice.
   *
   * Served so a client can adapt rather than guess: which formats to
   * encode, whether a transcript will be real or scripted, whether replies
   * can be spoken. A native client reads this at startup and picks its
   * input mode from it.
   */
  @Get('capabilities')
  @ApiOperation({ summary: 'Audio formats, recogniser and synthesiser capabilities.' })
  capabilities() {
    const audio = this.config.providers.audio;
    return {
      audio: {
        formats: Object.values(SUPPORTED_FORMATS),
        maxBytes: audio.maxBytes,
        maxDurationMs: audio.maxDurationMs,
        minBytes: audio.minBytes,
        retentionDefault: audio.retentionDefault,
      },
      stt: this.stt.describeProvider(),
      tts: this.tts.catalogue(),
      events: VOICE_EVENTS,
      realtime: {
        namespace: '/assistant',
        // Stated so a client does not try: continuous audio does not come
        // through here. Wake-word detection is the device's job.
        acceptsAudioFrames: false,
      },
    };
  }

  /**
   * Opens a voice session.
   *
   * This is the activation point a wake word reaches: the device detects
   * locally, then makes this ordinary authenticated call. Nothing listens
   * on the server's behalf before it.
   */
  @Post('sessions')
  @Throttle({ default: RateLimit.voiceSessionStart })
  @ApiOperation({ summary: 'Start a voice session.' })
  start(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() dto: StartVoiceSessionDto,
  ) {
    return this.voice.startSession({
      userId,
      deviceId,
      inputMode: dto.inputMode,
      wakeWordTriggered: dto.wakeWordTriggered,
      languageHint: dto.languageHint,
      conversationId: dto.conversationId,
    });
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: 'Where a session currently stands.' })
  session(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.sessions.snapshot(userId, id, deviceId);
  }

  /**
   * Reconnection over HTTP, for a client with no socket.
   *
   * The same replay the socket's `voice.resume` performs. Nothing is
   * re-run: the events were recorded as they happened.
   */
  @Get('sessions/:id/events')
  @ApiOperation({ summary: 'Replay a session’s events after a given sequence.' })
  async events(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Query() query: ResumeVoiceSessionDto,
  ) {
    const { session, events } = await this.sessions.eventsSince(
      userId,
      id,
      query.afterSeq ?? 0,
      deviceId,
    );
    return { session: { id: session.id, state: session.state, lastEventSeq: session.lastEventSeq }, events };
  }

  /**
   * A transcript the device recognised itself.
   *
   * The web client's path, and the better arrangement wherever the platform
   * supports it: no audio leaves the device at all.
   */
  @Post('sessions/:id/transcript')
  @Throttle({ default: RateLimit.voiceTurn })
  @ApiOperation({ summary: 'Submit a device-recognised transcript and run the turn.' })
  transcript(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Body() dto: SubmitTranscriptDto,
    @Req() req: Request,
  ) {
    return this.voice.submitTranscript({
      userId,
      deviceId,
      sessionId: id,
      text: dto.text,
      detectedLanguage: dto.detectedLanguage,
      meta: { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    });
  }

  /**
   * A recording, for a device with no local recogniser.
   *
   * Held in memory rather than written by the upload layer, so the bytes
   * are validated before this service decides where — or whether — to put
   * them. The multer ceiling is a second line after the body limit, not the
   * only one: `validateAudio` re-checks the size it actually received.
   */
  @Post('sessions/:id/audio')
  @Throttle({ default: RateLimit.voiceAudioUpload })
  @UseInterceptors(
    FileInterceptor('audio', {
      // 12 MB: above the configured audio ceiling so the service's own
      // check produces the error message, rather than multer's.
      limits: { fileSize: 12 * 1_024 * 1_024, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        audio: { type: 'string', format: 'binary' },
        languageHint: { type: 'string', example: 'hi-IN' },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload a recording, transcribe it and run the turn.',
    description:
      'The recording is deleted as soon as it has been transcribed, unless the ' +
      'account’s retention preference says otherwise.',
  })
  audio(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @UploadedFile() file: { buffer?: Buffer; mimetype?: string } | undefined,
    @Body() dto: SubmitAudioDto,
  ) {
    if (!file?.buffer) throw AppError.validation('No audio file was attached.');

    return this.voice.submitAudio({
      userId,
      deviceId,
      sessionId: id,
      audio: file.buffer,
      // The declared type is checked against the bytes, not trusted. The
      // uploaded filename is discarded entirely.
      declaredMimeType: file.mimetype,
      languageHint: dto.languageHint,
    });
  }

  /**
   * The spoken reply.
   *
   * Scoped to the owning user and device: the URL is not a capability, and
   * a leaked one reaches nothing.
   */
  @Get('sessions/:id/speech')
  @RawResponse()
  @ApiOperation({ summary: 'Fetch the synthesised reply for a session.' })
  async speech(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { audio, mimeType } = await this.voice.readSpeech(userId, id, deviceId);
    res
      .status(HttpStatus.OK)
      .setHeader('Content-Type', mimeType)
      .setHeader('Content-Length', String(audio.byteLength))
      // Never cached by a shared proxy: it is one account's reply.
      .setHeader('Cache-Control', 'private, no-store')
      .send(audio);
  }

  /**
   * Cancellation.
   *
   * Deletes the recording whatever the retention preference says: a user
   * who cancels expects it gone, not kept because a setting about completed
   * turns said so.
   */
  @Post('sessions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a voice session and delete its audio.' })
  cancel(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.voice.cancel(userId, id, deviceId);
  }
}
