import type { TranscribeModel } from "transcribe-cpp";
import { AUDIO_CONFIG, VAD_CONFIG } from "./constants";

export function framesFor(durationMs: number): number {
  return Math.ceil((durationMs * AUDIO_CONFIG.sampleRate) / (AUDIO_CONFIG.frameSamples * 1000));
}

export function concatPcm(pieces: readonly Float32Array[]): Float32Array {
  if (pieces.length === 0) return new Float32Array(0);
  if (pieces.length === 1) return pieces[0]!;
  const out = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

type BufferedFrame<T> = { frame: T; emitted: boolean };

/**
 * SpeechGate implements SmoothedVad:
 * - 0.3 speech threshold
 * - 450 ms prefill buffer (15 frames)
 * - 60 ms onset threshold (2 consecutive voiced frames before gating open)
 * - 450 ms hangover (15 frames after voice stops before closing)
 */
export class SpeechGate<T = Float32Array> {
  private readonly buffer: BufferedFrame<T>[] = [];
  private hangover = 0;
  private onset = 0;
  private speaking = false;

  constructor(
    private readonly options: {
      prefillFrames: number;
      onsetFrames: number;
      hangoverFrames: number;
    },
  ) {}

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** The frames to keep now, in order. */
  push(frame: T, voiced: boolean): T[] {
    const buffered: BufferedFrame<T> = { frame, emitted: false };
    this.buffer.push(buffered);
    while (this.buffer.length > this.options.prefillFrames + 1) {
      this.buffer.shift();
    }

    if (!this.speaking) {
      if (!voiced) {
        this.onset = 0;
        return [];
      }
      if (++this.onset < this.options.onsetFrames) return [];
      this.speaking = true;
      this.onset = 0;
      this.hangover = this.options.hangoverFrames;
      return this.takeWithheld();
    }

    if (voiced) {
      this.hangover = this.options.hangoverFrames;
    } else if (this.hangover > 0) {
      this.hangover--;
    } else {
      this.speaking = false;
      return [];
    }
    buffered.emitted = true;
    return [frame];
  }

  takeWithheld(): T[] {
    const out: T[] = [];
    for (const buffered of this.buffer) {
      if (buffered.emitted) continue;
      buffered.emitted = true;
      out.push(buffered.frame);
    }
    return out;
  }

  finish(): T[] {
    return this.onset > 0 ? this.takeWithheld() : [];
  }
}

export interface VadFilterResult {
  speechPcm: Float32Array;
  allSilence: boolean;
  probs: number[];
  warning?: string;
}

/**
 * Applies Silero VAD + SpeechGate to an audio clip.
 * If detector fails, preserves full input audio with warning.
 * If all silence, returns empty speech audio to skip ASR.
 */
export async function filterSpeech(
  vadModel: TranscribeModel,
  pcm: Float32Array,
  signal?: AbortSignal,
): Promise<VadFilterResult> {
  if (pcm.length === 0) {
    return { speechPcm: pcm, allSilence: true, probs: [] };
  }

  let probs: number[] = [];
  try {
    const vadSession = vadModel.createVadSession();
    try {
      const vadRes = await vadSession.run(pcm, {
        threshold: VAD_CONFIG.threshold,
        signal,
      });
      probs = vadRes.probs;
    } finally {
      vadSession.dispose();
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // Keep remaining/full audio if detector fails with warning
    const warning = `VAD detector failed; audio preserved: ${err instanceof Error ? err.message : String(err)}`;
    return { speechPcm: pcm, allSilence: false, probs: [], warning };
  }

  const gate = new SpeechGate<Float32Array>({
    prefillFrames: framesFor(VAD_CONFIG.prefillMs),
    onsetFrames: framesFor(VAD_CONFIG.onsetMs),
    hangoverFrames: framesFor(VAD_CONFIG.hangoverMs),
  });

  const keptPieces: Float32Array[] = [];
  const frameSamples = AUDIO_CONFIG.frameSamples;
  const numFrames = Math.ceil(pcm.length / frameSamples);

  for (let i = 0; i < numFrames; i++) {
    const start = i * frameSamples;
    const end = Math.min(start + frameSamples, pcm.length);
    const frame = pcm.subarray(start, end);
    const prob = probs[i] ?? 0;
    const voiced = prob >= VAD_CONFIG.threshold;

    const emitted = gate.push(frame, voiced);
    for (const f of emitted) {
      keptPieces.push(f);
    }
  }

  const tail = gate.finish();
  for (const f of tail) {
    keptPieces.push(f);
  }

  if (keptPieces.length === 0) {
    return { speechPcm: new Float32Array(0), allSilence: true, probs };
  }

  const speechPcm = concatPcm(keptPieces);
  return { speechPcm, allSilence: false, probs };
}
