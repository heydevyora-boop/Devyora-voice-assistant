import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ExecuteActionDto {
  @ApiPropertyOptional({
    description:
      'A client-chosen key, so a deliberate retry is distinguishable from a duplicate. ' +
      'Ignored by actions whose idempotency is the confirmation itself — for those, ' +
      '"the client asked twice" is not a reason to do it twice.',
    maxLength: 80,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;
}

export class ActionHistoryQueryDto {
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
