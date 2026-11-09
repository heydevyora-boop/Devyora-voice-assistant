import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateConversationDto {
  @ApiPropertyOptional({ example: 'Monday planning' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;
}

export class RenameConversationDto {
  @ApiPropertyOptional({ example: 'Monday planning' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;
}
