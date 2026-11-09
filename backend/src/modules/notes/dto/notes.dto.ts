import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoteSource } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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

/**
 * `?flag=true` arrives as a string; this makes it a boolean, or leaves it
 * absent so an omitted filter is distinguishable from `false`.
 */
const toOptionalBoolean = () =>
  Transform(({ value }): boolean | undefined => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  });

export class CreateNoteDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({ example: 'Buy oat milk on the way home' })
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({
    enum: NoteSource,
    description:
      'Advisory. A client saying VOICE does not make a note dictated — it records what ' +
      'the client reports, for the user’s own benefit.',
  })
  @IsOptional()
  @IsEnum(NoteSource)
  source?: NoteSource;

  @ApiPropertyOptional({ example: 'hi-Latn-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  language?: string;

  @ApiPropertyOptional({
    description:
      'Client-generated id. Sending one makes the create idempotent: a replayed ' +
      'request updates that note rather than making a second one.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;
}

export class UpdateNoteDto {
  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ example: 'hi-Latn-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  language?: string;

  @ApiPropertyOptional({
    description:
      'The version this edit was based on. If the stored version has moved on, the ' +
      'request is refused as a conflict and nothing is overwritten. Omitting it is a ' +
      'deliberate "take mine".',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class DeleteNoteQueryDto {
  @ApiPropertyOptional({ description: 'Refuse the delete if the note has changed since.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class ListNotesQueryDto {
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

  @ApiPropertyOptional({ description: 'Case-insensitive search of title and content.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: ['updatedAt', 'createdAt', 'title'], default: 'updatedAt' })
  @IsOptional()
  @IsIn(['updatedAt', 'createdAt', 'title'])
  sortBy?: 'updatedAt' | 'createdAt' | 'title';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: true, description: 'Pinned notes first.' })
  @IsOptional()
  @toOptionalBoolean()
  @IsBoolean()
  pinnedFirst?: boolean;

  @ApiPropertyOptional({ description: 'Only pinned, or only unpinned.' })
  @IsOptional()
  @toOptionalBoolean()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ enum: NoteSource })
  @IsOptional()
  @IsEnum(NoteSource)
  source?: NoteSource;

  @ApiPropertyOptional({ example: 'hi-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  language?: string;

  @ApiPropertyOptional({ description: 'Which date the range applies to.', enum: ['updatedAt', 'createdAt'] })
  @IsOptional()
  @IsIn(['updatedAt', 'createdAt'])
  dateField?: 'updatedAt' | 'createdAt';

  @ApiPropertyOptional({ example: '2026-11-01T00:00:00+05:30' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30T23:59:59+05:30' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Include soft-deleted notes.' })
  @IsOptional()
  @toOptionalBoolean()
  @IsBoolean()
  includeDeleted?: boolean;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}
