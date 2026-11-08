import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The single success envelope.
 *
 * Every endpoint returns the same outer shape, so a client writes one
 * unwrapper and one error path instead of one per route.
 */
export class ApiSuccessResponse<T> {
  @ApiProperty({ example: true }) readonly success = true as const;
  @ApiProperty() readonly data!: T;
  @ApiProperty({ example: '2026-01-01T12:00:00.000Z' }) readonly timestamp!: string;
  @ApiProperty({ example: '6f1d…', description: 'Echoes the x-correlation-id header.' })
  readonly correlationId!: string;

  constructor(data: T, correlationId: string) {
    this.data = data;
    this.timestamp = new Date().toISOString();
    this.correlationId = correlationId;
  }
}

export class ApiErrorDetail {
  @ApiProperty({ example: 'email' }) readonly field!: string;
  @ApiProperty({ example: 'must be an email address' }) readonly message!: string;
}

/** The single error envelope. */
export class ApiErrorResponse {
  @ApiProperty({ example: false }) readonly success = false as const;
  @ApiProperty({ example: 'VALIDATION_FAILED' }) readonly code!: string;
  @ApiProperty({ example: 'The request body is not valid.' }) readonly message!: string;
  @ApiProperty({ example: 400 }) readonly statusCode!: number;
  @ApiPropertyOptional({ type: [ApiErrorDetail] }) readonly details?: ApiErrorDetail[];
  @ApiProperty() readonly timestamp!: string;
  @ApiProperty() readonly correlationId!: string;
  @ApiProperty({ example: '/api/v1/notes' }) readonly path!: string;
}
