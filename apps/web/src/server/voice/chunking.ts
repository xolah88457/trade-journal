import { AUDIO_CONFIG, CHUNKING_CONFIG } from "./constants";

const RATE = AUDIO_CONFIG.sampleRate;
const FRAME = AUDIO_CONFIG.frameSamples;
const TARGET_SECONDS = CHUNKING_CONFIG.targetSeconds;
const MAX_CHUNK_SAMPLES = CHUNKING_CONFIG.maxChunkSamples;
const MIN_CHUNK_SAMPLES = CHUNKING_CONFIG.minChunkSamples;

// Silero segmentation parameters for pause detection
const THRESHOLD = 0.5;
const NEG_THRESHOLD = THRESHOLD - 0.15;
const MIN_SPEECH = Math.round((250 * RATE) / 1000); // 250 ms
const MIN_SILENCE = Math.round((100 * RATE) / 1000); // 100 ms
const SPEECH_PAD = Math.round((30 * RATE) / 1000); // 30 ms

export interface SpeechSegment {
  start: number;
  end: number;
}

export interface CutCandidate {
  cut: number;
  gapSeconds: number;
}

/**
 * Derives speech segments from per-frame probabilities using Silero rules.
 */
export function speechSegments(probs: ArrayLike<number>, samples: number): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let triggered = false;
  let start = 0;
  let tempEnd = 0;

  for (let i = 0; i < probs.length; i++) {
    const prob = probs[i] ?? 0;
    const at = i * FRAME;

    if (prob >= THRESHOLD && tempEnd !== 0) tempEnd = 0;
    if (prob >= THRESHOLD && !triggered) {
      triggered = true;
      start = at;
      continue;
    }
    if (prob < NEG_THRESHOLD && triggered) {
      if (tempEnd === 0) tempEnd = at;
      if (at - tempEnd < MIN_SILENCE) continue;
      if (tempEnd - start > MIN_SPEECH) {
        segments.push({ start, end: tempEnd });
      }
      triggered = false;
      tempEnd = 0;
    }
  }

  if (triggered && samples - start > MIN_SPEECH) {
    segments.push({ start, end: samples });
  }

  // Apply padding around segments
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (i === 0) segment.start = Math.max(0, segment.start - SPEECH_PAD);
    const next = segments[i + 1];
    if (!next) {
      segment.end = Math.min(samples, segment.end + SPEECH_PAD);
      continue;
    }
    const silence = next.start - segment.end;
    const pad = silence < 2 * SPEECH_PAD ? Math.floor(silence / 2) : SPEECH_PAD;
    segment.end = Math.min(samples, segment.end + pad);
    next.start = Math.max(0, next.start - pad);
  }

  return segments;
}

/**
 * Places cut candidates in the middle of each detected pause.
 */
export function cutCandidates(segments: readonly SpeechSegment[], samples: number): CutCandidate[] {
  const candidates: CutCandidate[] = [];
  let silenceStart = 0;

  for (const { start, end } of [...segments, { start: samples, end: samples }]) {
    if (start > silenceStart) {
      candidates.push({
        cut: Math.floor((silenceStart + start) / 2),
        gapSeconds: (start - silenceStart) / RATE,
      });
    }
    silenceStart = Math.max(silenceStart, end);
  }

  return candidates;
}

/**
 * Plans optimal chunk cut points between 5s and 40s (targeting ~30s).
 */
export function planCuts(candidates: readonly CutCandidate[], samples: number, from = 0): number[] {
  const cuts: number[] = [];
  let start = from;
  let first = 0;

  while (samples - start > MAX_CHUNK_SAMPLES) {
    while (first < candidates.length && candidates[first]!.cut < start + MIN_CHUNK_SAMPLES) {
      first++;
    }

    let best: number | undefined;
    let bestScore = -Infinity;
    let fallback: number | undefined;
    let fallbackScore = -Infinity;

    for (
      let i = first;
      i < candidates.length && candidates[i]!.cut <= start + MAX_CHUNK_SAMPLES;
      i++
    ) {
      const { cut, gapSeconds } = candidates[i]!;
      const position = (cut - start) / RATE;
      const score =
        Math.min(gapSeconds, 1) -
        (position > TARGET_SECONDS
          ? 0.1 * (position - TARGET_SECONDS)
          : 0.05 * (TARGET_SECONDS - position));

      if (samples - cut >= MIN_CHUNK_SAMPLES && score > bestScore) {
        best = cut;
        bestScore = score;
      }
      if (score > fallbackScore) {
        fallback = cut;
        fallbackScore = score;
      }
    }

    const hardCut =
      samples - start < MAX_CHUNK_SAMPLES + MIN_CHUNK_SAMPLES
        ? start + Math.floor((samples - start) / 2)
        : start + MAX_CHUNK_SAMPLES;

    start = best ?? fallback ?? hardCut;
    cuts.push(start);
  }

  return cuts;
}

/**
 * Cuts PCM into bounded chunks (<= 40s, target 30s) at speech pauses.
 */
export function sliceIntoChunks(pcm: Float32Array, probs?: number[]): Float32Array[] {
  if (pcm.length <= MAX_CHUNK_SAMPLES) {
    return [pcm];
  }

  let cuts: number[] = [];
  if (probs && probs.length > 0) {
    const segments = speechSegments(probs, pcm.length);
    const candidates = cutCandidates(segments, pcm.length);
    cuts = planCuts(candidates, pcm.length, 0);
  }

  // Fallback if no pause cuts generated
  if (cuts.length === 0) {
    let offset = 0;
    while (pcm.length - offset > MAX_CHUNK_SAMPLES) {
      const nextCut = offset + TARGET_SECONDS * RATE;
      cuts.push(nextCut);
      offset = nextCut;
    }
  }

  const chunks: Float32Array[] = [];
  let prev = 0;
  for (const cut of cuts) {
    if (cut > prev && cut < pcm.length) {
      chunks.push(pcm.subarray(prev, cut));
      prev = cut;
    }
  }
  if (prev < pcm.length) {
    chunks.push(pcm.subarray(prev));
  }

  return chunks;
}

// Scripts written without spaces between words, and CJK punctuation.
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u3000-\u303f\uff00-\uffef]/u;

/**
 * Joins chunk transcripts with proper spacing between Latin words
 * and avoiding spaces for unspaced CJK scripts.
 */
export function joinTranscripts(texts: readonly string[]): string {
  let joined = "";
  let last: string | undefined;

  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;

    if (
      last !== undefined &&
      !UNSPACED.test(last) &&
      !UNSPACED.test(String.fromCodePoint(text.codePointAt(0)!))
    ) {
      joined += " ";
    }
    joined += text;
    last = Array.from(text).at(-1);
  }

  return joined;
}
