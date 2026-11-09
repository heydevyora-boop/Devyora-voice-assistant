/**
 * Audio fixtures.
 *
 * Real containers, built byte by byte, rather than buffers with plausible
 * names. The validator decides from magic numbers, so a fixture that only
 * claims to be a WebM would not exercise anything.
 */

export { silentWav } from '../../src/providers/tts/mock.provider';

/** A WAV with a given duration, sample rate and channel count. */
export function wav(options: {
  durationMs: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  /** Omit the size in the data chunk, as a streamed WAV does. */
  unsizedData?: boolean;
}): Buffer {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const bits = options.bitsPerSample ?? 16;
  const bytesPerFrame = (bits / 8) * channels;
  const dataBytes = Math.round((sampleRate * options.durationMs) / 1000) * bytesPerFrame;

  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  buffer.writeUInt16LE(bytesPerFrame, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(options.unsizedData ? 0 : dataBytes, 40);
  return buffer;
}

/** A WAV carrying a LIST chunk before `fmt `, which real encoders emit. */
export function wavWithListChunk(durationMs: number): Buffer {
  const base = wav({ durationMs });
  const list = Buffer.alloc(8 + 12);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(12, 4);
  list.write('INFOIART', 8, 'ascii');

  const header = base.subarray(0, 12);
  const rest = base.subarray(12);
  const out = Buffer.concat([header, list, rest]);
  out.writeUInt32LE(out.byteLength - 8, 4);
  return out;
}

/** Minimal EBML header — what a browser's MediaRecorder produces. */
export function webm(padTo = 2_048): Buffer {
  const head = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f,
  ]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length), 0x42)]);
}

export function ogg(padTo = 2_048): Buffer {
  const head = Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.alloc(8, 0)]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length), 0x43)]);
}

export function flac(padTo = 2_048): Buffer {
  const head = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(8, 0)]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length), 0x44)]);
}

/** MP4/M4A: a size field then `ftyp`. */
export function mp4(padTo = 2_048): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16, 0);
  head.write('ftypM4A ', 4, 'ascii');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length), 0x45)]);
}

/** MP3 with an ID3v2 tag. */
export function mp3Tagged(padTo = 2_048): Buffer {
  const head = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(9, 0)]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length), 0x46)]);
}

/** A bare MP3 frame, no tag. */
export function mp3Bare(padTo = 2_048): Buffer {
  const head = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length), 0x47)]);
}

/** Not audio at all. */
export function notAudio(size = 2_048): Buffer {
  return Buffer.from('this is a text file pretending to be a recording'.padEnd(size, '.'), 'utf8');
}
