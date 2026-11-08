import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorCode } from '../src/common/errors/app-error';
import {
  PageMetaDto,
  PaginationQueryDto,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from '../src/common/dto/pagination.dto';
import { requestContext } from '../src/common/request-context';
import { ParseUuidPipe } from '../src/common/pipes/parse-uuid.pipe';
import { assertOwned, ownedAndAlive, ownedBy } from '../src/database/tenant-scope';

describe('AppError', () => {
  it('carries a stable code alongside the HTTP status', () => {
    const error = AppError.notFound('Note');
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.message).toBe('Note was not found.');
  });

  it('keeps field-level detail on a validation failure', () => {
    const error = AppError.validation('Invalid.', [{ field: 'email', message: 'must be an email' }]);
    expect(error.details).toEqual([{ field: 'email', message: 'must be an email' }]);
  });
});

describe('pagination', () => {
  it('defaults to the first page', () => {
    const query = new PaginationQueryDto();
    expect(query.page).toBe(1);
    expect(query.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(query.skip).toBe(0);
  });

  it('computes skip from page and limit', () => {
    const query = new PaginationQueryDto();
    query.page = 3;
    query.limit = 20;
    expect(query.skip).toBe(40);
  });

  it('caps the page size so a client cannot ask for everything', () => {
    expect(MAX_PAGE_SIZE).toBeLessThanOrEqual(100);
  });

  it('derives page metadata', () => {
    const meta = new PageMetaDto(2, 10, 35);
    expect(meta.pageCount).toBe(4);
    expect(meta.hasPrevious).toBe(true);
    expect(meta.hasNext).toBe(true);
  });

  it('handles an empty result without dividing by zero', () => {
    const meta = new PageMetaDto(1, 10, 0);
    expect(meta.pageCount).toBe(0);
    expect(meta.hasNext).toBe(false);
  });
});

describe('request context', () => {
  it('isolates the correlation id to its own async scope', () => {
    requestContext.run({ correlationId: 'alpha' }, () => {
      expect(requestContext.correlationId()).toBe('alpha');
    });
    expect(requestContext.correlationId()).toBe('no-context');
  });

  it('attaches a principal once a guard resolves one', () => {
    requestContext.run({ correlationId: 'beta' }, () => {
      requestContext.setPrincipal('user-1', 'device-1');
      expect(requestContext.get()?.userId).toBe('user-1');
      expect(requestContext.get()?.deviceId).toBe('device-1');
    });
  });

  it('survives an await boundary', async () => {
    await requestContext.run({ correlationId: 'gamma' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(requestContext.correlationId()).toBe('gamma');
    });
  });
});

describe('ParseUuidPipe', () => {
  const pipe = new ParseUuidPipe('noteId');

  it('passes a valid UUID through', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(pipe.transform(id)).toBe(id);
  });

  it('rejects a malformed id before it reaches the database', () => {
    expect(() => pipe.transform('not-a-uuid')).toThrow(AppError);
    try {
      pipe.transform('not-a-uuid');
    } catch (error) {
      expect((error as AppError).details?.[0].field).toBe('noteId');
    }
  });
});

describe('tenant scoping', () => {
  it('forces the owner into a where clause', () => {
    expect(ownedBy('u1', { pinned: true })).toEqual({ pinned: true, userId: 'u1' });
  });

  it('adds the soft-delete filter alongside ownership', () => {
    expect(ownedAndAlive('u1')).toEqual({ userId: 'u1', deletedAt: null });
  });

  it('cannot be tricked into dropping the owner', () => {
    // A caller passing userId explicitly must not be able to override it.
    expect(ownedBy('u1', { userId: 'u2' } as { userId: string }).userId).toBe('u1');
  });

  it('returns the row when it belongs to the caller', () => {
    const row = { userId: 'u1', id: 'n1' };
    expect(assertOwned(row, 'u1')).toBe(row);
  });

  it("reports another user's row as missing rather than forbidden", () => {
    const row = { userId: 'u2', id: 'n1' };
    expect(() => assertOwned(row, 'u1', 'Note')).toThrow(AppError);
    try {
      assertOwned(row, 'u1', 'Note');
    } catch (error) {
      // 404, not 403: confirming the id exists is itself a disclosure.
      expect((error as AppError).getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect((error as AppError).code).toBe(ErrorCode.NOT_FOUND);
    }
  });

  it('treats a missing row the same way', () => {
    expect(() => assertOwned(null, 'u1')).toThrow(AppError);
  });
});
