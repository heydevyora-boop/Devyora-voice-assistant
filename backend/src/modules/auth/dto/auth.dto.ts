import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DevicePlatform } from '@prisma/client';

/** How the caller wants its credentials delivered. */
export type ClientType = 'browser' | 'native';

export class DeviceRegistrationDto {
  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  @ApiProperty({ example: 'Pixel 8' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'phone' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  deviceType?: string;

  @ApiPropertyOptional({ example: '1.2.0' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;

  @ApiPropertyOptional({ description: 'True if the device runs a native wake-word engine.' })
  @IsOptional()
  wakeWordCapable?: boolean;
}

export class RegisterDto {
  @ApiProperty({ example: 'person@example.com' })
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 12, example: 'a sufficiently long passphrase' })
  @IsString()
  @MaxLength(256)
  password!: string;

  @ApiPropertyOptional({ example: 'Alex' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiProperty({ type: DeviceRegistrationDto })
  @ValidateNested()
  @Type(() => DeviceRegistrationDto)
  device!: DeviceRegistrationDto;

  @ApiPropertyOptional({
    enum: ['browser', 'native'],
    default: 'native',
    description:
      'Browser clients receive HttpOnly cookies and a CSRF token. Native clients receive tokens in the body.',
  })
  @IsOptional()
  @IsIn(['browser', 'native'])
  clientType?: ClientType;
}

export class LoginDto {
  @ApiProperty({ example: 'person@example.com' })
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  password!: string;

  @ApiProperty({ type: DeviceRegistrationDto })
  @ValidateNested()
  @Type(() => DeviceRegistrationDto)
  device!: DeviceRegistrationDto;

  @ApiPropertyOptional({
    description:
      'Identifier of a device already registered to this account. Reuses the device record ' +
      'instead of creating another. It is not a credential: it is only honoured after the ' +
      'password has been verified, and only if it belongs to this user.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  devicePublicId?: string;

  @ApiPropertyOptional({ enum: ['browser', 'native'], default: 'native' })
  @IsOptional()
  @IsIn(['browser', 'native'])
  clientType?: ClientType;
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Omit when the refresh token is sent as a cookie.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}

export class RequestPasswordResetDto {
  @ApiProperty()
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  email!: string;
}

export class ConfirmPasswordResetDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  token!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MaxLength(256)
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  currentPassword!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MaxLength(256)
  newPassword!: string;
}

export class VerifyEmailDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  token!: string;
}

export class AuthTokensDto {
  @ApiPropertyOptional({ description: 'Omitted for browser clients, which receive cookies.' })
  accessToken?: string;

  @ApiPropertyOptional({ description: 'Omitted for browser clients.' })
  refreshToken?: string;

  @ApiProperty({ example: 600 })
  expiresIn!: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiPropertyOptional({ description: 'Present for browser clients; echo it in X-CSRF-Token.' })
  csrfToken?: string;
}

export class AuthResultDto {
  @ApiProperty() user!: { id: string; email: string; displayName: string | null; emailVerified: boolean };
  @ApiProperty() device!: { id: string; publicId: string; platform: DevicePlatform; name: string };
  @ApiProperty({ type: AuthTokensDto }) tokens!: AuthTokensDto;
}
