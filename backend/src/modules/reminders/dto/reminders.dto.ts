import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReminderStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const toOptionalBoolean = () =>
  Transform(({ value }): boolean | undefined => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  });

/**
 * A date and time, either as a wall-clock reading or as an instant.
 *
 * `2026-11-10T08:00` is read in the reminder's zone — what a date picker
 * produces. `2026-11-10T08:00:00+05:30` is already absolute, which is what
 * the AI layer produces. Both are accepted because both are legitimate, and
 * mixing them up is how a reminder ends up five and a half hours out.
 */
const DUE_AT_EXAMPLE = '2026-11-10T08:00';

export class CreateReminderDto {
  @ApiProperty({ example: 'Gym' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text!: string;

  @ApiProperty({
    example: DUE_AT_EXAMPLE,
    description:
      'Wall-clock time in the reminder’s zone, or an instant with an offset. A time ' +
      'that does not exist or happens twice because of a daylight-saving change is ' +
      'resolved and reported, never silently moved.',
  })
  @IsISO8601()
  dueAt!: string;

  @ApiPropertyOptional({
    example: 'Asia/Kolkata',
    description: 'IANA zone. Defaults to the account’s own.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    example: 'FREQ=WEEKLY;BYDAY=MO',
    description:
      'RFC 5545 recurrence rule. Parsed and bounded: a rule that repeats more often ' +
      'than every 15 minutes, or never produces an occurrence, is refused.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  rrule?: string;

  @ApiPropertyOptional({
    description: 'Client-generated id. Makes the create idempotent for an offline device.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;
}

export class UpdateReminderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text?: string;

  @ApiPropertyOptional({ example: DUE_AT_EXAMPLE })
  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @ApiPropertyOptional({ example: 'Europe/London' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    example: 'FREQ=DAILY',
    description: 'Send an empty string to stop a reminder recurring.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  rrule?: string;

  @ApiPropertyOptional({
    description:
      'The version this edit was based on. A mismatch is reported as a conflict and ' +
      'nothing is overwritten.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class SnoozeReminderDto {
  @ApiProperty({
    example: 10,
    description:
      'Minutes from now — not from the time that was missed, which is what pressing ' +
      'snooze actually means.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_080)
  minutes!: number;
}

export class DeleteReminderQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class ListRemindersQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ enum: ReminderStatus })
  @IsOptional()
  @IsEnum(ReminderStatus)
  status?: ReminderStatus;

  @ApiPropertyOptional({ example: '2026-11-01T00:00:00+05:30' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30T23:59:59+05:30' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive search of the reminder text.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional()
  @IsOptional()
  @toOptionalBoolean()
  includeDeleted?: boolean;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

export class UpcomingQueryDto {
  @ApiPropertyOptional({ default: 30, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}
