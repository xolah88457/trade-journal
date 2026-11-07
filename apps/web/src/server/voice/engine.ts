import { TranscribeModel } from "transcribe-cpp";
import { AUDIO_CONFIG } from "./constants";
import {
  downloadAsrModel,
  isAsrCached,
  isVadReady,
  resolveAsrModelPath,
  resolveVadModelPath,
} from "./model-cache";
import { filterSpeech } from "./vad";
import { sliceIntoChunks, joinTranscripts } from "./chunking";
import type { VoiceStatus, SetupResponse, TranscribeResponse } from "./types";

interface ActiveJob {
  sessionId: string;
  abortController: AbortController;
  t0: number;
}

export class EngineBusyError extends Error {
  constructor(message = "The local voice engine is currently processing another transcription.") {
    super(message);
    this.name = "EngineBusyError";
  }
}

export class ModelNotReadyError extends Error {
  constructor(message = "Voice models are not loaded or missing. Run setup first.") {
    super(message);
    this.name = "ModelNotReadyError";
  }
}

class VoiceEngine {
  private asrModel: TranscribeModel | null = null;
  private vadModel: TranscribeModel | null = null;
  private loadingPromise: Promise<{ asr: TranscribeModel; vad: TranscribeModel }> | null = null;
  private activeJob: ActiveJob | null = null;
  private isShuttingDown = false;
  private cachedDevice: string | undefined = undefined;

  constructor() {
    if (typeof process !== "undefined") {
      const shutdown = () => this.dispose();
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    }
  }

  get isReady(): boolean {
    return this.asrModel !== null && this.vadModel !== null;
  }

  get device(): string | undefined {
    return (
      this.cachedDevice ||
      this.asrModel?.device?.name ||
      this.asrModel?.backend ||
      this.vadModel?.device?.name ||
      this.vadModel?.backend
    );
  }

  async getStatus(): Promise<VoiceStatus> {
    const cached = await isAsrCached();
    const vad = await isVadReady();
    return {
      ready: this.isReady,
      cached,
      activeModel: "parakeet-unified-en-0.6b",
      vadReady: vad,
      device: this.device,
    };
  }

  async loadModels(): Promise<{ asr: TranscribeModel; vad: TranscribeModel }> {
    if (this.isShuttingDown) {
      throw new Error("Voice engine is shutting down.");
    }
    if (this.asrModel && this.vadModel) {
      return { asr: this.asrModel, vad: this.vadModel };
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      let asrPath = await resolveAsrModelPath();
      if (!asrPath) {
        throw new ModelNotReadyError(
          "ASR model weights not found in HuggingFace cache or journal data directory. Setup required.",
        );
      }
      let vadPath = await resolveVadModelPath();
      if (!vadPath) {
        throw new ModelNotReadyError(
          "Silero VAD model weights not found. Verify models directory contains silero-vad-v6.2-F32.gguf.",
        );
      }

      // Load sequentially and guarantee disposal if either load fails
      let asr: TranscribeModel | null = null;
      let vad: TranscribeModel | null = null;
      try {
        asr = await TranscribeModel.load(asrPath);
        vad = await TranscribeModel.load(vadPath);
      } catch (err) {
        if (asr) {
          try {
            asr.dispose();
          } catch {}
          asr = null;
        }
        if (vad) {
          try {
            vad.dispose();
          } catch {}
          vad = null;
        }
        throw err;
      }

      this.asrModel = asr;
      this.vadModel = vad;
      this.cachedDevice = asr.device?.name || asr.backend || vad.device?.name || vad.backend;
      return { asr, vad };
    })()
      .catch((err) => {
        this.loadingPromise = null;
        throw err;
      })
      .finally(() => {
        this.loadingPromise = null;
      });

    return this.loadingPromise;
  }

  /**
   * Explicit setup requested by user. Ensures models are present (downloading if missing),
   * verifies checksums, loads models into memory, and reports device.
   */
  async setup(signal?: AbortSignal): Promise<SetupResponse> {
    let asrPath = await resolveAsrModelPath();
    if (!asrPath) {
      // Download Parakeet weights with fixed manifest
      asrPath = await downloadAsrModel(signal);
    }

    const vadPath = await resolveVadModelPath();
    if (!vadPath) {
      throw new ModelNotReadyError(
        "Silero VAD model weights missing. Expected silero-vad-v6.2-F32.gguf.",
      );
    }

    await this.loadModels();
    return {
      ok: true,
      device: this.device,
    };
  }

  cancelJob(sessionId?: string): boolean {
    if (!this.activeJob) return false;
    if (!sessionId || this.activeJob.sessionId === sessionId) {
      this.activeJob.abortController.abort();
      return true;
    }
    return false;
  }

  /**
   * Transcribes Float32Array PCM audio:
   * 1. Validates bounds (<= 5min) and finite floats
   * 2. Enforces single active ASR job concurrency
   * 3. Runs Silero VAD + SpeechGate
   * 4. Skips ASR if all silence
   * 5. Slices speech audio into ~30s chunks at pauses
   * 6. Transcribes chunks sequentially with cancellation checks
   * 7. Joins transcripts cleanly
   */
  async transcribe(
    sessionId: string,
    pcm: Float32Array,
    signal?: AbortSignal,
  ): Promise<TranscribeResponse> {
    const t0 = Date.now();

    // 1. Validation
    if (pcm.length === 0) {
      return { text: "", speechDurationMs: 0, latencyMs: 0 };
    }
    if (pcm.length > AUDIO_CONFIG.maxSamples) {
      throw new Error(
        `Audio exceeds maximum allowed duration of 5 minutes (${pcm.length} samples > ${AUDIO_CONFIG.maxSamples} max).`,
      );
    }
    for (let i = 0; i < pcm.length; i++) {
      if (!Number.isFinite(pcm[i]!)) {
        throw new Error(
          "PCM audio buffer contains invalid non-finite float samples (NaN or Infinity).",
        );
      }
    }

    // 2. Concurrency lock
    if (this.activeJob !== null) {
      // If previous job was already canceled, wait up to 1 second for it to clear
      if (this.activeJob.abortController.signal.aborted) {
        let waitMs = 0;
        while (this.activeJob !== null && waitMs < 1000) {
          await new Promise((r) => setTimeout(r, 50));
          waitMs += 50;
        }
      }
      if (this.activeJob !== null) {
        throw new EngineBusyError();
      }
    }

    const jobAbort = new AbortController();
    const active: ActiveJob = { sessionId, abortController: jobAbort, t0 };
    this.activeJob = active;

    const combinedSignal = signal ? AbortSignal.any([signal, jobAbort.signal]) : jobAbort.signal;

    try {
      if (combinedSignal.aborted) {
        return { text: "", speechDurationMs: 0, latencyMs: Date.now() - t0, warning: "Canceled" };
      }

      // Ensure models loaded
      const { asr, vad } = await this.loadModels();

      if (combinedSignal.aborted) {
        return { text: "", speechDurationMs: 0, latencyMs: Date.now() - t0, warning: "Canceled" };
      }

      // 3. VAD SpeechGate
      const vadResult = await filterSpeech(vad, pcm, combinedSignal);
      const speechDurationMs = Math.round(
        (vadResult.speechPcm.length / AUDIO_CONFIG.sampleRate) * 1000,
      );

      // 4. Skip ASR when all silence
      if (vadResult.allSilence || vadResult.speechPcm.length === 0) {
        return {
          text: "",
          speechDurationMs: 0,
          latencyMs: Date.now() - t0,
          warning: vadResult.warning,
        };
      }

      if (combinedSignal.aborted) {
        return { text: "", speechDurationMs, latencyMs: Date.now() - t0, warning: "Canceled" };
      }

      // 5. Slice speech into bounded ~30s chunks at pauses
      const chunks = sliceIntoChunks(vadResult.speechPcm, vadResult.probs);
      const chunkTexts: string[] = [];

      // 6. Transcribe chunks sequentially with cancellation checks
      for (const chunk of chunks) {
        if (combinedSignal.aborted) {
          break;
        }
        try {
          const res = await asr.transcribe(chunk, { signal: combinedSignal });
          if (res.text) {
            chunkTexts.push(res.text);
          }
        } catch (err: any) {
          if (combinedSignal.aborted || err?.name === "Aborted" || err?.aborted) {
            break;
          }
          throw err;
        }
      }

      if (combinedSignal.aborted) {
        return { text: "", speechDurationMs, latencyMs: Date.now() - t0, warning: "Canceled" };
      }

      // 7. Join transcripts cleanly
      const text = joinTranscripts(chunkTexts);
      return {
        text,
        speechDurationMs,
        latencyMs: Date.now() - t0,
        warning: vadResult.warning,
      };
    } finally {
      if (this.activeJob === active) {
        this.activeJob = null;
      }
    }
  }

  async dispose(): Promise<void> {
    this.isShuttingDown = true;
    if (this.activeJob) {
      this.activeJob.abortController.abort();
    }
    // Wait briefly for active compute to exit
    let waited = 0;
    while (this.activeJob !== null && waited < 1500) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }
    if (this.asrModel) {
      try {
        this.asrModel.dispose();
      } catch {}
      this.asrModel = null;
    }
    if (this.vadModel) {
      try {
        this.vadModel.dispose();
      } catch {}
      this.vadModel = null;
    }
  }
}

// Global shared singleton engine across Next.js API routes
const globalEngine = new VoiceEngine();
export const voiceEngine = globalEngine;
