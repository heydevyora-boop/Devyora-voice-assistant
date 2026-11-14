import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConnectionProvider } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class StartAuthorizationDto {
  @ApiProperty({ enum: ConnectionProvider })
  @IsEnum(ConnectionProvider)
  provider!: ConnectionProvider;

  @ApiPropertyOptional({
    description:
      'Scopes to request, from those the provider declares. Omit to request everything ' +
      'the provider supports, so the user consents once rather than per feature.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  scopes?: string[];
}

export class OAuthCallbackDto {
  @ApiProperty({ description: 'The opaque value the authorisation URL carried.' })
  @IsString()
  @MaxLength(64)
  state!: string;

  @ApiProperty({ description: 'The authorisation code from the provider.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2_048)
  code!: string;
}

export class ConnectWithSecretDto {
  @ApiProperty({ enum: ConnectionProvider })
  @IsEnum(ConnectionProvider)
  provider!: ConnectionProvider;

  @ApiProperty({
    description:
      'The credential the provider issued — a Telegram bot token, for example. Sent ' +
      'once, verified against the provider, then stored encrypted. It is never ' +
      'returned by any route.',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  secret!: string;
}

export class ExecuteOperationDto {
  @ApiProperty({ enum: ConnectionProvider })
  @IsEnum(ConnectionProvider)
  provider!: ConnectionProvider;

  @ApiProperty({
    example: 'email.draft',
    description:
      'An operation the provider declares. One it does not is refused as unsupported, ' +
      'which is a different answer from a failure.',
  })
  @IsString()
  @MaxLength(60)
  operation!: string;

  @ApiPropertyOptional({
    description: 'Validated by the provider against its own schema for that operation.',
  })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
