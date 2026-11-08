import { Injectable, type PipeTransform } from '@nestjs/common';
import { AppError } from '../errors/app-error';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Rejects a malformed id before it reaches the database.
 *
 * Nest's built-in pipe raises a generic 400; this one produces the project's
 * error envelope and keeps the field name, so the client gets the same shape
 * it gets from body validation.
 */
@Injectable()
export class ParseUuidPipe implements PipeTransform<string, string> {
  constructor(private readonly field = 'id') {}

  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_V4.test(value)) {
      throw AppError.validation('The request is not valid.', [
        { field: this.field, message: 'must be a UUID' },
      ]);
    }
    return value;
  }
}
