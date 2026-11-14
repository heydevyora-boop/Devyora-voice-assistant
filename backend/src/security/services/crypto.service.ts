import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';

/** AES-256-GCM. 12-byte IV is the recommended size; 16-byte tag is the full one. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Sealed {
  readonly ciphertext: Buffer;
  /** Which key sealed it, so a rotated key can still open old rows. */
  readonly keyVersion: number;
}

/**
 * Encryption for third-party credentials at rest.
 *
 * An OAuth access token is a bearer credential for somebody's Gmail. A
 * database backup, a replica, a dropped disk or an over-broad `SELECT`
 * should not hand it over, so these are sealed before they are stored and
 * the key lives outside the database.
 *
 * **Versioned keys.** `TOKEN_ENCRYPTION_KEY` holds one or more keys as
 * `version:base64`, newest first — `2:...,1:...`. New material is sealed
 * with the highest version and `keyVersion` is written alongside the
 * ciphertext, so a rotation does not require re-encrypting every row before
 * it takes effect. Reads use the version the row names.
 *
 * **No key means no connection.** If nothing is configured, `available` is
 * false and the integration layer refuses to connect an account rather than
 * storing a token in the clear. A missing key must be a feature that does
 * not work, never a credential written unprotected.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly keys: ReadonlyMap<number, Buffer>;
  private readonly currentVersion: number;

  constructor(config: AppConfigService) {
    const { keys, problems } = parseKeys(config.providers.tokenEncryptionKey);
    this.keys = keys;
    this.currentVersion = keys.size > 0 ? Math.max(...keys.keys()) : 0;

    for (const problem of problems) this.logger.error(problem);

    if (keys.size === 0) {
      this.logger.warn(
        'No TOKEN_ENCRYPTION_KEY, so third-party accounts cannot be connected. ' +
          'Connecting is refused rather than storing a credential unencrypted.',
      );
    } else {
      this.logger.log(
        `Credential encryption is available (key version ${this.currentVersion}` +
          `${keys.size > 1 ? `, ${keys.size} keys loaded for reads` : ''}).`,
      );
    }
  }

  /** Whether anything can be sealed or opened at all. */
  get available(): boolean {
    return this.keys.size > 0;
  }

  get version(): number {
    return this.currentVersion;
  }

  /**
   * Seals a credential.
   *
   * Layout: `IV ‖ tag ‖ ciphertext`. One buffer rather than three columns,
   * because the three are useless apart and a row that lost its tag would
   * be a silent integrity hole.
   */
  seal(plaintext: string): Sealed {
    const key = this.keys.get(this.currentVersion);
    if (!key) {
      throw new Error('Refusing to seal: no encryption key is configured.');
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return { ciphertext: Buffer.concat([iv, tag, body]), keyVersion: this.currentVersion };
  }

  /**
   * Opens a credential.
   *
   * Returns null rather than throwing on any failure — a wrong key, a
   * truncated buffer, a tampered tag. The caller's correct response is
   * identical in every case: treat the connection as broken and ask the
   * user to reconnect. Distinguishing them would only tell an attacker
   * which part of their guess was wrong.
   */
  open(sealed: Buffer | null | undefined, keyVersion: number): string | null {
    if (!sealed || sealed.length <= IV_BYTES + TAG_BYTES) return null;

    const key = this.keys.get(keyVersion);
    if (!key) {
      this.logger.warn(`No key for version ${keyVersion}; cannot open this credential.`);
      return null;
    }

    try {
      const iv = sealed.subarray(0, IV_BYTES);
      const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const body = sealed.subarray(IV_BYTES + TAG_BYTES);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      // `final()` is what verifies the tag, so a tampered ciphertext throws
      // here rather than returning plausible rubbish.
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * Whether a row should be re-sealed.
   *
   * True when it was sealed with an older key. Used by the rotation sweep,
   * so rotation finishes rather than leaving old material indefinitely
   * readable by a key that was meant to be retired.
   */
  needsRotation(keyVersion: number): boolean {
    return this.available && keyVersion < this.currentVersion;
  }
}

/**
 * Parses the configured keys.
 *
 * Accepts `version:base64` entries separated by commas, and a bare base64
 * key as version 1 so a single-key deployment needs no ceremony. A malformed
 * or wrong-length entry is reported and skipped rather than silently
 * truncated to something that would still encrypt — badly.
 */
export function parseKeys(value: string | undefined): {
  keys: Map<number, Buffer>;
  problems: string[];
} {
  const keys = new Map<number, Buffer>();
  const problems: string[] = [];

  if (!value?.trim()) return { keys, problems };

  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const match = /^(\d+):(.+)$/.exec(trimmed);
    const version = match ? Number(match[1]) : 1;
    const material = match ? match[2] : trimmed;

    let decoded: Buffer;
    try {
      decoded = Buffer.from(material, 'base64');
    } catch {
      problems.push(`Encryption key version ${version} is not valid base64; skipped.`);
      continue;
    }

    if (decoded.length !== KEY_BYTES) {
      problems.push(
        `Encryption key version ${version} is ${decoded.length} bytes, not ${KEY_BYTES}; skipped.`,
      );
      continue;
    }
    if (keys.has(version)) {
      problems.push(`Encryption key version ${version} appears twice; the later one is skipped.`);
      continue;
    }

    keys.set(version, decoded);
  }

  return { keys, problems };
}

/** Constant-time comparison, for anything that is effectively a secret. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
