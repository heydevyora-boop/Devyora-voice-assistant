import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AssistantTurnDto {
  @ApiProperty({
    example: 'Kal subah 8 baje gym ka reminder laga do',
    description:
      'What the user said. Treated as untrusted data throughout: it is never ' +
      'interpreted as an instruction to the backend, only as content to interpret.',
  })
  @IsString()
  @MinLength(1)
  // Long enough for a real dictated paragraph, short enough that a pasted
  // document cannot be used to flood the context window.
  @MaxLength(4000)
  text!: string;

  @ApiPropertyOptional({ description: 'Continue an existing conversation.' })
  @IsOptional()
  @IsUUID('4')
  conversationId?: string;

  @ApiPropertyOptional({
    description: 'The command this turn answers, when replying to a clarification.',
  })
  @IsOptional()
  @IsUUID('4')
  answersCommandId?: string;
}

export class DecideActionDto {
  @ApiProperty({
    example: true,
    description:
      'The user’s decision. Approval queues the action; it does not perform it, ' +
      'and the response never reports success.',
  })
  @IsBoolean()
  approve!: boolean;
}
