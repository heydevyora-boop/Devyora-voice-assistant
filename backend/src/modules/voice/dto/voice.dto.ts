import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum VoiceInputModeDto {
  TEXT = 'TEXT',
  UPLOAD = 'UPLOAD',
  STREAM = 'STREAM',
}

export class StartVoiceSessionDto {
  @ApiProperty({
    enum: VoiceInputModeDto,
    description:
      'TEXT when the device recognises speech itself, UPLOAD when it will send a ' +
      'recording, STREAM when audio arrives over the socket.',
  })
  @IsEnum(VoiceInputModeDto)
  inputMode!: VoiceInputModeDto;

  @ApiPropertyOptional({
    description:
      'Set when a local wake word started this. A label for the user’s own activity ' +
      'view — the access token is what authorises the request, exactly as for a tap.',
  })
  @IsOptional()
  @IsBoolean()
  wakeWordTriggered?: boolean;

  @ApiPropertyOptional({ example: 'hi-IN', description: 'BCP-47 hint. Advisory.' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  languageHint?: string;

  @ApiPropertyOptional({ description: 'Continue an existing conversation.' })
  @IsOptional()
  @IsUUID('4')
  conversationId?: string;
}

export class SubmitTranscriptDto {
  @ApiProperty({
    example: 'kal subah 8 baje gym ka reminder laga do',
    description:
      'Text the device recognised. Treated as untrusted data: it is content to ' +
      'interpret, never an instruction to the backend.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;

  @ApiPropertyOptional({ example: 'hi-Latn-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  detectedLanguage?: string;
}

export class SubmitAudioDto {
  @ApiPropertyOptional({ example: 'hi-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  languageHint?: string;
}

export class ResumeVoiceSessionDto {
  @ApiPropertyOptional({
    description: 'The last event sequence this client saw. Everything after it is returned.',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  afterSeq?: number;
}
