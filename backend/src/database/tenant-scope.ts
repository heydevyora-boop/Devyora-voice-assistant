import { AppError } from '../common/errors/app-error';

/**
 * Ownership helpers.
 *
 * Every user-owned row carries `userId`. These two functions are how a
 * repository states that, so the check is written the same way everywhere
 * and is easy to grep for in review.
 */

/** A `where` clause that can only ever match one user's rows. */
export function ownedBy<T extends object>(userId: string, where?: T): T & { userId: string } {
  return { ...(where ?? ({} as T)), userId };
}

/** Adds the soft-delete filter alongside ownership. */
export function ownedAndAlive<T extends object>(
  userId: string,
  where?: T,
): T & { userId: string; deletedAt: null } {
  return { ...(where ?? ({} as T)), userId, deletedAt: null };
}

/**
 * Asserts that a fetched row belongs to the caller.
 *
 * Throws 404 rather than 403 on a mismatch: telling someone that an id exists
 * but is not theirs is itself a disclosure.
 */
export function assertOwned<T extends { userId: string } | null | undefined>(
  row: T,
  userId: string,
  resource = 'Resource',
): NonNullable<T> {
  if (!row || row.userId !== userId) {
    throw AppError.notFound(resource);
  }
  return row;
}
