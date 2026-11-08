import { Injectable } from '@nestjs/common';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { AppError } from '../../common/errors/app-error';

/**
 * Password hashing and policy.
 *
 * Argon2id with parameters at the OWASP floor: 19 MiB of memory, two
 * iterations, one lane. Memory cost is what makes GPU cracking expensive, so
 * it is the parameter not to trim.
 */
@Injectable()
export class PasswordService {
  private readonly options = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456, // KiB
    timeCost: 2,
    parallelism: 1,
  };

  hash(plain: string): Promise<string> {
    return hash(plain, this.options);
  }

  /**
   * Returns false rather than throwing on a malformed stored hash, so a
   * corrupted row reads as "wrong password" instead of a 500 that tells an
   * attacker the account exists.
   */
  async verify(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(storedHash, plain);
    } catch {
      return false;
    }
  }

  /**
   * Minimum viable policy: length over composition rules, which is what
   * current guidance recommends. A breached-password check belongs here too
   * and is noted for when an external list is available.
   */
  assertStrong(plain: string): void {
    const problems: string[] = [];
    if (plain.length < 12) problems.push('must be at least 12 characters');
    if (plain.length > 256) problems.push('must be at most 256 characters');
    if (/^\s|\s$/.test(plain)) problems.push('must not start or end with whitespace');
    if (/^(.)\1+$/.test(plain)) problems.push('must not be a single repeated character');

    if (problems.length > 0) {
      throw AppError.validation(
        'The password does not meet the minimum requirements.',
        problems.map((message) => ({ field: 'password', message })),
      );
    }
  }
}
