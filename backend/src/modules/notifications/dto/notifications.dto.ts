import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ description: 'Only those not yet marked read.' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : undefined))
  @IsBoolean()
  unreadOnly?: boolean;
}

export class RegisterPushTokenDto {
  @ApiPropertyOptional({
    description:
      'The transport token for this device. Send null to stop push for it — a device ' +
      'with no token is not a delivery failure, it simply has no transport.',
    maxLength: 4096,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  pushToken?: string | null;
}
