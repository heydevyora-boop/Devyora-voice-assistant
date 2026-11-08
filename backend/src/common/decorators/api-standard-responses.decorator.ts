import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ApiErrorResponse } from '../dto/api-response.dto';

/**
 * Documents the error envelope once instead of on every route.
 */
export function ApiStandardErrors() {
  return applyDecorators(
    ApiExtraModels(ApiErrorResponse),
    ApiResponse({
      status: 400,
      description: 'The request failed validation.',
      schema: { $ref: getSchemaPath(ApiErrorResponse) },
    }),
    ApiResponse({
      status: 500,
      description: 'Unexpected failure. The response carries a correlation id.',
      schema: { $ref: getSchemaPath(ApiErrorResponse) },
    }),
  );
}
