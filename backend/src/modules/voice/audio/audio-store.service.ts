import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.module';

/** A storage key is 32 lowercase hex characters and nothing else. */
const KEY_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Temporary storage for recordings.
 *
 * Three properties, in the order they matter.
 *
 * **Nothing is kept that does not have to be.** The pipeline writes a file,
 * transcribes it, and deletes it in a `finally` block. Retention beyond
 * that is opt-in per user and is the exception, not the default.
 *
 * **No client input reaches the filesystem.** Keys are server-generated
 * random hex, validated on every read and delete, and joined to one
 * directory whose resolved path is re-checked. An upload's filename is
 * discarded on arrival — it is attacker-controlled text, and the only thing
 * it could contribute is a path.
 *
 * **The directory is the service's alone.** Created `0700`, and emptied at
 * startup so files left behind by a crashed process do not accumulate
 * someone's speech on disk indefinitely.
 */
@Injectable()
export class AudioStoreService implements OnModuleInit {
  private readonly logger = new Logger(AudioStoreService.name);
  private readonly root: string;
  private ready: Promise<void> | null = null;

  constructor(config: AppConfigService) {
    this.root = config.providers.audio.tempDir;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureRoot();
    const removed = await this.purgeAll();
    if (removed > 0) {
      // Not an error: a crash mid-request is the usual cause. Worth saying
      // out loud, because it means audio outlived the request that held it.
      this.logger.warn(`Removed ${removed} orphaned audio file(s) left from a previous run.`);
    }
  }

  /** Where files live. Exposed for diagnostics, never to a client. */
  get directory(): string {
    return this.root;
  }

  /**
   * Writes bytes and returns the key.
   *
   * `0600`, so nothing else on the host can read a recording even if it
   * shares the account's group.
   */
  async write(bytes: Buffer): Promise<string> {
    await this.ensureRoot();
    const key = randomBytes(16).toString('hex');
    await writeFile(this.pathFor(key), bytes, { mode: 0o600, flag: 'wx' });
    return key;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key), fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async sizeOf(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathFor(key))).size;
    } catch {
      return null;
    }
  }

  /**
   * Deletes a recording.
   *
   * Never throws. This is called from `finally` blocks on paths that are
   * already failing, and a cleanup error must not replace the real one —
   * the original failure is what the user needs to hear about.
   */
  async remove(key: string | null | undefined): Promise<boolean> {
    if (!key) return false;
    try {
      await rm(this.pathFor(key), { force: true });
      return true;
    } catch (error) {
      this.logger.error(`Could not remove audio ${key}: ${describe(error)}`);
      return false;
    }
  }

  /** Empties the directory. Used at startup and by the retention sweep. */
  async purgeAll(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }

    let removed = 0;
    for (const entry of entries) {
      // Only files this service could have created are touched. Anything
      // else in the directory is left alone rather than deleted on a guess.
      if (!KEY_PATTERN.test(entry)) continue;
      if (await this.remove(entry)) removed += 1;
    }
    return removed;
  }

  /**
   * Removes files older than a cutoff, whatever the database says.
   *
   * A backstop, not the primary mechanism: if a row was lost, or a delete
   * failed, or a process died between writing and recording, the audio
   * still goes. Nothing should rely on this having run.
   */
  async removeOlderThan(maxAgeMs: number): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }

    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const entry of entries) {
      if (!KEY_PATTERN.test(entry)) continue;
      try {
        const info = await stat(join(this.root, entry));
        if (info.mtimeMs < cutoff && (await this.remove(entry))) removed += 1;
      } catch {
        // Gone between readdir and stat. That is the desired state.
      }
    }
    return removed;
  }

  /**
   * Removes stale files that no live row claims.
   *
   * The backstop for a lost or failed delete: if the database no longer
   * points at a file, the file should not exist. Age-gated so a sweep
   * running while an upload is being transcribed does not delete audio that
   * is in use, and restricted to keys this service generates so nothing
   * else in the directory is touched.
   */
  async removeOlderThanExcept(minAgeMs: number, keep: ReadonlySet<string>): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }

    const cutoff = Date.now() - minAgeMs;
    let removed = 0;

    for (const entry of entries) {
      if (!KEY_PATTERN.test(entry) || keep.has(entry)) continue;
      try {
        const info = await stat(join(this.root, entry));
        if (info.mtimeMs < cutoff && (await this.remove(entry))) removed += 1;
      } catch {
        // Gone between readdir and stat. That is the desired state.
      }
    }
    return removed;
  }

  /**
   * Resolves a key to a path.
   *
   * The pattern check is the guard, and it is applied on every operation
   * rather than only at creation: a key read back from the database has
   * been through a round trip, and a traversal attempt there would be far
   * less visible than one in a request.
   */
  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error('Refusing to use a malformed audio storage key.');
    }
    const path = join(this.root, key);
    // Belt and braces: the pattern already excludes separators and dots.
    if (!path.startsWith(this.root + sep)) {
      throw new Error('Refusing to use an audio path outside the store.');
    }
    return path;
  }

  /** Created once per process, and awaited by every writer. */
  private ensureRoot(): Promise<void> {
    this.ready ??= mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => undefined);
    return this.ready;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
