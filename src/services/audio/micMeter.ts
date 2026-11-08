/**
 * Live microphone level metering.
 *
 * The waveform is driven by real audio from `getUserMedia` through an
 * `AnalyserNode`. If the microphone is unavailable this throws — it never
 * produces invented levels, because an animated bar chart that does not track
 * the user's voice is a lie about what the assistant is hearing.
 */
export type MicErrorCode = 'not-supported' | 'permission-denied' | 'audio-capture' | 'unknown';

export class MicError extends Error {
  readonly code: MicErrorCode;
  constructor(code: MicErrorCode, message: string) {
    super(message);
    this.name = 'MicError';
    this.code = code;
  }
}

export interface MicMeter {
  stop: () => void;
}

export interface MicMeterOptions {
  barCount: number;
  /** Called on each animation frame with one normalised 0..1 value per bar. */
  onLevels: (levels: number[]) => void;
  onError?: (error: MicError) => void;
}

function mapGetUserMediaError(cause: unknown): MicError {
  const name = cause instanceof DOMException ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new MicError('permission-denied', 'Microphone access was refused.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new MicError('audio-capture', 'No microphone is available.');
  }
  if (name === 'NotReadableError') {
    return new MicError('audio-capture', 'The microphone is in use by another application.');
  }
  return new MicError('unknown', cause instanceof Error ? cause.message : 'Could not open the microphone.');
}

export async function startMicMeter({ barCount, onLevels, onError }: MicMeterOptions): Promise<MicMeter> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new MicError('not-supported', 'This browser cannot capture audio.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (cause) {
    throw mapGetUserMediaError(cause);
  }

  const AudioCtx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new MicError('not-supported', 'This browser has no Web Audio support.');
  }

  const context = new AudioCtx();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);

  const spectrum = new Uint8Array(analyser.frequencyBinCount);
  let frame: number | null = null;
  let stopped = false;

  // Speech energy sits low in the spectrum, so the bars sample the lower
  // half of the bins and spread them evenly across the visualiser.
  const usableBins = Math.floor(analyser.frequencyBinCount * 0.55);
  const binsPerBar = Math.max(1, Math.floor(usableBins / barCount));

  const tick = () => {
    if (stopped) return;
    analyser.getByteFrequencyData(spectrum);
    const levels: number[] = [];
    for (let bar = 0; bar < barCount; bar += 1) {
      let sum = 0;
      const start = bar * binsPerBar;
      for (let b = 0; b < binsPerBar; b += 1) sum += spectrum[start + b] ?? 0;
      const mean = sum / binsPerBar / 255;
      // Perceptual curve, with a small floor so silence still shows a line.
      levels.push(Math.min(1, Math.max(0.06, Math.pow(mean, 0.65) * 1.25)));
    }
    onLevels(levels);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  // Losing the device mid-session is a real failure, not silence.
  // The AbortController detaches these listeners on stop, so nothing holds a
  // reference to the caller's closure once the meter is finished with.
  const listeners = new AbortController();
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener(
      'ended',
      () => onError?.(new MicError('audio-capture', 'The microphone was disconnected.')),
      { signal: listeners.signal },
    );
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      listeners.abort();
      source.disconnect();
      analyser.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void context.close().catch(() => undefined);
    },
  };
}
