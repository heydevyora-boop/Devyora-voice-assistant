import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoteSource } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One locally-changed record.
 *
 * `baseVersion` is the whole conflict story: the version this edit was built
 * on. Omitting it is a deliberate "take mine" and is the only way to win a
 * conflict — which is what makes overwriting somebody's work an explicit
 * act rather than the side effect of a race.
 */
class PushRecordBase {
  @ApiProperty({
    description:
      'Client-generated id, stable for the life of the record. Unique per account by a ' +
      'database constraint, which is what makes a replayed push idempotent.',
    maxLength: 64,
  })
  @IsString()
  @MaxLength(64)
  clientId!: string;

  @ApiPropertyOptional({
    description:
      'The version this change was based on. If the server has moved on, the push is ' +
      'refused as a conflict and nothing is overwritten.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  baseVersion?: number;

  @ApiPropertyOptional({ description: 'Delete this record on the server.' })
  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}

export class PushNoteDto extends PushRecordBase {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 10_000 })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ enum: NoteSource })
  @IsOptional()
  @IsEnum(NoteSource)
  source?: NoteSource;

  @ApiPropertyOptional({ example: 'hi-Latn-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  language?: string;
}

export class PushReminderDto extends PushRecordBase {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  text?: string;

  @ApiPropertyOptional({
    example: '2026-11-10T08:00',
    description:
      'Wall-clock time in the reminder’s zone, or an instant with an offset. ' +
      'Validated per record rather than by this schema: an unreadable date is ' +
      'reported as a `rejected` record, not as a rejected batch.',
  })
  @IsOptional()
  // Deliberately a bounded string rather than @IsISO8601(). A strict
  // check here would make one corrupt date reject the whole batch — which
  // is the failure that permanently wedges a device holding fifty queued
  // changes. The wrong *type* is still a 400, because that is a client
  // bug; unreadable *content* is a per-record outcome with a reason.
  @IsString()
  @MaxLength(40)
  dueAt?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ example: 'FREQ=WEEKLY;BYDAY=MO' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  rrule?: string;
}

export class SyncPushDto {
  @ApiPropertyOptional({ type: [PushNoteDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushNoteDto)
  notes?: PushNoteDto[];

  @ApiPropertyOptional({ type: [PushReminderDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushReminderDto)
  reminders?: PushReminderDto[];
}

export class PullQueryDto {
  @ApiPropertyOptional({
    description:
      'Server timestamp from a previous pull’s cursor. Omit to use the cursor the ' +
      'server holds for this device, or to get everything if there is none.',
  })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({ default: 200, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
