import { createHash } from 'node:crypto';
import { AppError } from '../../../common/errors/app-error';
import {
  containerForDeclaredMime,
  readWavProperties,
  sniffContainer,
  SUPPORTED_FORMATS,
  type AudioContainer,
} from './audio-format';

export interface AudioLimits {
  readonly minBytes: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
}

export interface ValidatedAudio {
  readonly bytes: Buffer;
  readonly container: AudioContainer;
  /** The canonical MIME type, derived from the bytes. */
  readonly mimeType: string;
  readonly byteSize: number;
  /** Exact, for WAV. Null for compressed containers — never estimated. */
  readonly durationMs: number | null;
  readonly sampleRate: number | null;
  /** SHA-256 of the bytes. */
  readonly checksum: string;
}

/**
 * The failure codes a client can branch on. Deliberately specific, so the
 * interface can say what to do differently rather than "upload failed".
 */
export type AudioRejection =
  | 'audio_missing'
  | 'audio_too_small'
  | 'audio_too_large'
  | 'audio_unsupported_format'
  | 'audio_format_mismatch'
  | 'audio_too_long';

export class AudioValidationError extends AppError {
  readonly rejection: AudioRejection;

  constructor(rejection: AudioRejection, message: string) {
    super('VALIDATION_FAILED', message, 400);
    this.rejection = rejection;
  }
}

/**
 * Checks a recording before anything is done with it.
 *
 * Order matters and is cheapest-first: size is a length check, format is
 * twelve bytes, duration needs a header walk. A hostile client should be
 * rejected by arithmetic, not by parsing.
 *
 * The declared MIME type is checked *against* the bytes rather than
 * trusted. A mismatch is reported separately from an unsupported format,
 * because they mean different things: one is a client sending something we
 * do not handle, the other is a client lying about what it sent.
 */
export function validateAudio(
  bytes: Buffer,
  declaredMimeType: string | undefined,
  limits: AudioLimits,
): ValidatedAudio {
  if (!bytes || bytes.byteLength === 0) {
    throw new AudioValidationError('audio_missing', 'No audio was received.');
  }
  if (bytes.byteLength < limits.minBytes) {
    throw new AudioValidationError(
      'audio_too_small',
      'That recording is too short to contain speech.',
    );
  }
  if (bytes.byteLength > limits.maxBytes) {
    throw new AudioValidationError(
      'audio_too_large',
      `Audio must be ${Math.floor(limits.maxBytes / 1_048_576)} MB or smaller.`,
    );
  }

  const actual = sniffContainer(bytes);
  if (!actual) {
    throw new AudioValidationError(
      'audio_unsupported_format',
      `Unrecognised audio. Supported: ${Object.values(SUPPORTED_FORMATS).map((f) => f.label).join(', ')}.`,
    );
  }

  if (declaredMimeType) {
    const declared = containerForDeclaredMime(declaredMimeType);
    if (declared && declared !== actual) {
      throw new AudioValidationError(
        'audio_format_mismatch',
        'The audio does not match the format it was sent as.',
      );
    }
  }

  const wav = readWavProperties(bytes);
  if (wav && wav.durationMs > limits.maxDurationMs) {
    throw new AudioValidationError(
      'audio_too_long',
      `Recordings must be under ${Math.floor(limits.maxDurationMs / 1000)} seconds.`,
    );
  }

  return {
    bytes,
    container: actual,
    mimeType: SUPPORTED_FORMATS[actual].mimeType,
    byteSize: bytes.byteLength,
    // Only a measured duration appears here. For a compressed container the
    // byte ceiling is the real guard, and the provider reports the true
    // length once it has decoded the audio.
    durationMs: wav?.durationMs ?? null,
    sampleRate: wav?.sampleRate ?? null,
    checksum: checksumOf(bytes),
  };
}

/**
 * Checks a duration the provider measured, after the fact.
 *
 * A compressed recording's length is unknown until something decodes it, so
 * the ceiling is enforced twice: on bytes before the call, and on the real
 * duration after. Both are needed — the byte limit cannot catch four
 * minutes of silence in a 200 KB Opus file.
 */
export function assertDurationWithinLimit(durationMs: number | null, limits: AudioLimits): void {
  if (durationMs !== null && durationMs > limits.maxDurationMs) {
    throw new AudioValidationError(
      'audio_too_long',
      `Recordings must be under ${Math.floor(limits.maxDurationMs / 1000)} seconds.`,
    );
  }
}

function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
