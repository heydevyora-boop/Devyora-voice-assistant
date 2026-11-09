/**
 * What the backend accepts, and how it decides.
 *
 * The decision is made from the bytes, not from the `Content-Type` header
 * or the filename. A client can claim anything; a container's magic number
 * is what it actually is. This matters beyond pedantry: the recogniser
 * picks a decoder from what we tell it, and handing a decoder something
 * other than what it expects is how a media library gets to misbehave.
 */

export type AudioContainer = 'wav' | 'webm' | 'ogg' | 'mp3' | 'mp4' | 'flac';

export interface AudioFormat {
  readonly container: AudioContainer;
  /** The canonical MIME type for this container, as sent to a provider. */
  readonly mimeType: string;
  readonly label: string;
}

/**
 * The allow-list. Anything not here is rejected, so adding a format is a
 * deliberate act rather than a side effect of a client sending something
 * new.
 */
export const SUPPORTED_FORMATS: Readonly<Record<AudioContainer, AudioFormat>> = {
  wav: { container: 'wav', mimeType: 'audio/wav', label: 'WAV (PCM)' },
  webm: { container: 'webm', mimeType: 'audio/webm', label: 'WebM (Opus)' },
  ogg: { container: 'ogg', mimeType: 'audio/ogg', label: 'Ogg (Opus/Vorbis)' },
  mp3: { container: 'mp3', mimeType: 'audio/mpeg', label: 'MP3' },
  mp4: { container: 'mp4', mimeType: 'audio/mp4', label: 'MP4/M4A (AAC)' },
  flac: { container: 'flac', mimeType: 'audio/flac', label: 'FLAC' },
};

/** MIME types a client may declare, mapped to the container they mean. */
const DECLARED_MIME: Readonly<Record<string, AudioContainer>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm', // what MediaRecorder labels an audio-only WebM
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'mp4',
  'audio/x-m4a': 'mp4',
  'audio/aac': 'mp4',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

export function containerForDeclaredMime(mimeType: string): AudioContainer | null {
  // Parameters such as `;codecs=opus` are part of what browsers send.
  const bare = mimeType.split(';')[0].trim().toLowerCase();
  return DECLARED_MIME[bare] ?? null;
}

/**
 * Identifies a container from its leading bytes.
 *
 * Returns null when nothing matches, which is the answer for a text file
 * renamed to `.wav` as much as for a format we do not support.
 */
export function sniffContainer(bytes: Buffer): AudioContainer | null {
  if (bytes.length < 12) return null;

  // RIFF....WAVE
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') {
    return 'wav';
  }

  // EBML header — Matroska and WebM share it. Distinguishing the two needs
  // the DocType element; both decode the same way here, so `webm` stands
  // for either.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }

  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';

  // ISO base media: a size field, then `ftyp`.
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';

  // MP3 with an ID3v2 tag.
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  // Bare MP3 frame sync: 11 set bits.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';

  return null;
}

export interface WavProperties {
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

/**
 * Reads a WAV header to get the exact duration.
 *
 * Only WAV. Duration for a compressed container cannot be known without
 * decoding it, and this service does not decode audio — so for everything
 * else the duration stays null rather than being estimated from the file
 * size. A plausible-looking number in a metadata field that nothing
 * measured is the kind of thing that gets believed later.
 */
export function readWavProperties(bytes: Buffer): WavProperties | null {
  if (sniffContainer(bytes) !== 'wav') return null;

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let dataBytes = 0;

  // Chunks are not in a guaranteed order, and `LIST` chunks are common, so
  // the header is walked rather than read at fixed offsets.
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= bytes.length) {
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      byteRate = bytes.readUInt32LE(body + 8);
      bitsPerSample = bytes.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // A streamed WAV may declare size 0 or a size beyond what arrived;
      // what is actually present is the honest figure.
      dataBytes = size > 0 ? Math.min(size, bytes.length - body) : bytes.length - body;
      break;
    }

    if (size <= 0) break;
    // Chunks are word-aligned.
    offset = body + size + (size % 2);
  }

  if (!sampleRate || !channels || !bitsPerSample || dataBytes <= 0) return null;

  const effectiveByteRate = byteRate || (sampleRate * channels * bitsPerSample) / 8;
  if (effectiveByteRate <= 0) return null;

  return {
    durationMs: Math.round((dataBytes / effectiveByteRate) * 1000),
    sampleRate,
    channels,
    bitsPerSample,
  };
}
