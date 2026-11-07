/**
 * Local voice dictation client for Sumi.
 * Uses local Parakeet Unified EN 0.6B + Silero VAD via /api/voice/ routes.
 * Supports Web Audio 16kHz PCM capture with AudioWorklet and ScriptProcessor fallback.
 * Strictly local inference; no cloud or browser SpeechRecognition fallback.
 */

export type DictationState =
  | "idle"
  | "checking"
  | "setup-required"
  | "preparing"
  | "starting"
  | "listening"
  | "transcribing"
  | "error";

export interface VoiceStatus {
  ready: boolean;
  cached: boolean;
  activeModel: string;
  vadReady: boolean;
  device?: string;
}

export interface TranscribeResponse {
  text: string;
  speechDurationMs?: number;
  latencyMs?: number;
  error?: string;
}

export interface DictationSessionCallbacks {
  onState: (state: DictationState) => void;
  onText: (text: string) => void;
  onError: (message: string) => void;
  onAudioLevel?: (level: number) => void;
}

export interface InsertDictatedTextOptions {
  currentText: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  dictatedText: string;
}

export interface InsertDictatedTextResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Maximum recording limit (5 minutes) matching the server-side ASR finite buffer */
export const MAX_RECORDING_SECONDS = 300;

/**
 * Inserts transcribed text at cursor or replaces active selection with proper spacing.
 * Does not overwrite text outside the selection.
 * Avoids redundant spaces around newlines, whitespace, or punctuation.
 */
export function insertDictatedText({
  currentText,
  selectionStart,
  selectionEnd,
  dictatedText,
}: InsertDictatedTextOptions): InsertDictatedTextResult {
  const trimmed = dictatedText.trim();
  if (!trimmed) {
    const cur = selectionStart ?? currentText.length;
    return { value: currentText, selectionStart: cur, selectionEnd: cur };
  }

  const start = Math.max(0, Math.min(selectionStart ?? currentText.length, currentText.length));
  const end = Math.max(start, Math.min(selectionEnd ?? start, currentText.length));

  const before = currentText.slice(0, start);
  const after = currentText.slice(end);

  const isPunctuation = /^[.,!?:;]/.test(trimmed);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before) && !isPunctuation;
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after) && !/^[.,!?:;]/.test(after);

  const insertion = (needsLeadingSpace ? " " : "") + trimmed + (needsTrailingSpace ? " " : "");
  const value = before + insertion + after;
  const newCursor = before.length + insertion.length;

  return {
    value,
    selectionStart: newCursor,
    selectionEnd: newCursor,
  };
}

/**
 * Resamples Float32 audio samples to 16,000 Hz using linear interpolation.
 */
export function resampleTo16k(audioData: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === 16000 || audioData.length === 0) {
    return audioData;
  }
  const targetRate = 16000;
  const ratio = sourceRate / targetRate;
  const targetLength = Math.round(audioData.length / ratio);
  const result = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = i * ratio;
    const indexFloor = Math.floor(sourceIndex);
    const indexCeil = Math.min(indexFloor + 1, audioData.length - 1);
    const weight = sourceIndex - indexFloor;
    const valFloor = audioData[indexFloor] ?? 0;
    const valCeil = audioData[indexCeil] ?? valFloor;
    result[i] = valFloor * (1 - weight) + valCeil * weight;
  }
  return result;
}

/**
 * Computes root-mean-square amplitude normalized between 0 and 1.
 */
export function calculateRms(samples: Float32Array): number {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const val = samples[i] ?? 0;
    sum += val * val;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, Math.max(0, rms * 5));
}

export function dictationError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Microphone access was blocked. Allow microphone permission in your browser or Sumi app settings, then try again.";
    case "audio-capture":
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone is available. Connect or enable a microphone, then try again.";
    case "not-supported":
    case "NotSupportedError":
      return "Audio capture is not supported in this browser environment.";
    case "no-speech":
      return "No speech was detected. Speak clearly into your microphone after clicking Dictate.";
    case "model-offline":
      return "The local transcription model is not ready or could not be loaded.";
    case "network":
    case "service-unavailable":
      return "The local speech recognition service is not responding.";
    case "canceled":
      return "Dictation was canceled.";
    default:
      return "Local dictation encountered an error. Please try again.";
  }
}

export async function fetchVoiceStatus(fetchFn = fetch): Promise<VoiceStatus> {
  try {
    const res = await fetchFn("/api/voice/status");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as VoiceStatus;
  } catch {
    // Treat offline or unreachable local service as unready without throwing
    return {
      ready: false,
      cached: false,
      activeModel: "parakeet-unified-en-0.6b",
      vadReady: false,
    };
  }
}

export async function setupVoiceModel(fetchFn = fetch): Promise<{ ok: boolean; device?: string }> {
  const res = await fetchFn("/api/voice/setup", { method: "POST" });
  if (!res.ok) {
    throw new Error(`Setup failed: HTTP ${res.status}`);
  }
  return res.json();
}

export async function cancelVoiceSession(sessionId?: string, fetchFn = fetch): Promise<void> {
  try {
    await fetchFn("/api/voice/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    // Best-effort session cancellation dispatch; network teardown errors are safely ignored
  }
}

/** Global monotonic counter ensuring distinct generation IDs across session starts */
let globalSessionGeneration = 0;

export interface ActiveSessionLease {
  id: string;
  generation: number;
  cancel: () => void;
  stop: () => Promise<void>;
}

let activeGlobalSession: ActiveSessionLease | null = null;

export function getActiveDictationSession(): ActiveSessionLease | null {
  return activeGlobalSession;
}

export interface DictationSessionOptions {
  fetchFn?: typeof fetch;
  mediaDevices?: MediaDevices;
  AudioContextClass?: typeof AudioContext;
}

export interface DictationSession {
  id: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
  dispose: () => void;
}

/**
 * Creates a managed dictation session enforcing single-active-target across the application.
 */
export function createLocalDictationSession(
  callbacks: DictationSessionCallbacks,
  options: DictationSessionOptions = {},
): DictationSession {
  const sessionId = crypto.randomUUID();
  const fetchFn =
    options.fetchFn ?? (typeof window !== "undefined" ? window.fetch.bind(window) : fetch);

  let state: DictationState = "idle";
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let workletNode: AudioNode | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let silentGainNode: GainNode | null = null;
  const chunks: Float32Array[] = [];
  let totalSamplesCollected = 0;
  let lastAudioLevelReportTime = 0;
  let abortController: AbortController | null = null;

  let sessionGeneration = 0;
  let isCanceled = false;
  let isDisposed = false;

  const isStale = () =>
    isDisposed || isCanceled || activeGlobalSession?.generation !== sessionGeneration;

  const setState = (next: DictationState) => {
    if (isDisposed && next !== "idle") return;
    state = next;
    callbacks.onState(next);
  };

  const cleanupAudio = () => {
    if (stream) {
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // Teardown: track stop error is ignored to ensure clean audio disposal
      }
      stream = null;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // Teardown: source disconnect is best-effort during cleanup
      }
      sourceNode = null;
    }
    if (workletNode) {
      try {
        workletNode.disconnect();
      } catch {
        // Teardown: worklet disconnect is best-effort during cleanup
      }
      workletNode = null;
    }
    if (scriptNode) {
      try {
        scriptNode.disconnect();
      } catch {
        // Teardown: script processor disconnect is best-effort during cleanup
      }
      scriptNode = null;
    }
    if (silentGainNode) {
      try {
        silentGainNode.disconnect();
      } catch {
        // Teardown: silent gain disconnect is best-effort during cleanup
      }
      silentGainNode = null;
    }
    if (audioContext) {
      try {
        audioContext.close().catch(() => {
          // Teardown: context close rejection is safely ignored
        });
      } catch {
        // Teardown: context closing error is safely ignored
      }
      audioContext = null;
    }
    chunks.length = 0;
    totalSamplesCollected = 0;
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", handleKeyDown);
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && state === "listening") {
      event.preventDefault();
      cancel();
    }
  };

  const cancel = () => {
    if (isDisposed) return;
    isCanceled = true;

    // Signal abort to any in-flight transcribe fetch
    if (abortController) {
      abortController.abort();
    }

    cleanupAudio();
    cancelVoiceSession(sessionId, fetchFn).catch(() => {
      // Best-effort session cancellation dispatch; network teardown errors are safely ignored
    });

    if (activeGlobalSession?.generation === sessionGeneration) {
      activeGlobalSession = null;
    }

    setState("idle");
  };

  const handleAudioChunk = (chunk: Float32Array) => {
    if (state !== "listening" || isStale()) return;

    const sampleRate = audioContext?.sampleRate ?? 16000;
    const maxSamples = sampleRate * MAX_RECORDING_SECONDS;

    if (totalSamplesCollected >= maxSamples) {
      // 5-minute cap reached: trigger stop immediately to prevent unbounded memory growth
      void stop();
      return;
    }

    const remaining = maxSamples - totalSamplesCollected;
    const toAdd = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
    chunks.push(new Float32Array(toAdd));
    totalSamplesCollected += toAdd.length;

    if (callbacks.onAudioLevel) {
      const now = Date.now();
      // Throttle audio level meter updates to ~15-20Hz (every 50-60ms) to avoid setState thrashing
      if (now - lastAudioLevelReportTime >= 50) {
        lastAudioLevelReportTime = now;
        callbacks.onAudioLevel(calculateRms(toAdd));
      }
    }

    if (totalSamplesCollected >= maxSamples) {
      void stop();
    }
  };

  const start = async () => {
    if (isDisposed) return;

    // 1. Establish the global lease immediately at invocation time before any async boundary
    const currentGen = ++globalSessionGeneration;
    sessionGeneration = currentGen;
    isCanceled = false;

    if (activeGlobalSession && activeGlobalSession.generation !== currentGen) {
      activeGlobalSession.cancel();
    }

    activeGlobalSession = {
      id: sessionId,
      generation: currentGen,
      cancel,
      stop,
    };

    // Synchronously acquire and initialize AudioContext to capture live user gesture token
    const AudioContextClass =
      options.AudioContextClass ??
      (typeof window !== "undefined"
        ? window.AudioContext ||
          /* SAFETY: Legacy WebKit Safari exposes AudioContext under webkitAudioContext prefix on window */
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        : undefined);

    if (!AudioContextClass) {
      if (activeGlobalSession?.generation === currentGen) {
        activeGlobalSession = null;
      }
      setState("idle");
      callbacks.onError(dictationError("not-supported"));
      return;
    }

    try {
      try {
        // Request 16000Hz directly if supported by browser/device
        audioContext = new AudioContextClass({ sampleRate: 16000 });
      } catch {
        // Fallback to default sampleRate if 16000 is unsupported on this hardware
        audioContext = new AudioContextClass();
      }
    } catch {
      if (activeGlobalSession?.generation === currentGen) {
        activeGlobalSession = null;
      }
      setState("idle");
      callbacks.onError(dictationError("not-supported"));
      return;
    }

    // Synchronously initiate audio context resume within the live user gesture
    let resumeError: Error | null = null;
    let resumeOutcomePromise: Promise<boolean> | null = null;
    if (typeof audioContext.resume === "function") {
      try {
        const rawResumePromise = audioContext.resume();
        // Synchronously attach rejection handler to prevent unhandled rejection if rejected early or never awaited
        resumeOutcomePromise = rawResumePromise.then(
          () => true,
          (err) => {
            resumeError = err instanceof Error ? err : new Error(String(err));
            return false;
          },
        );
      } catch {
        cleanupAudio();
        if (activeGlobalSession?.generation === currentGen) {
          activeGlobalSession = null;
        }
        setState("idle");
        callbacks.onError(dictationError("not-supported"));
        return;
      }
    }

    // 2. Async boundary: Status check
    setState("checking");
    const status = await fetchVoiceStatus(fetchFn);
    if (isStale()) {
      cleanupAudio();
      return;
    }

    if (!status.cached) {
      cleanupAudio();
      if (activeGlobalSession?.generation === currentGen) {
        activeGlobalSession = null;
      }
      setState("setup-required");
      return;
    }

    // 3. Async boundary: Model setup
    if (!status.ready) {
      setState("preparing");
      try {
        await setupVoiceModel(fetchFn);
      } catch {
        cleanupAudio();
        if (isStale()) return;
        if (activeGlobalSession?.generation === currentGen) {
          activeGlobalSession = null;
        }
        setState("idle");
        callbacks.onError(dictationError("model-offline"));
        return;
      }
      if (isStale()) {
        cleanupAudio();
        return;
      }
    }

    setState("starting");

    const mediaDevices =
      options.mediaDevices ??
      (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);

    if (!mediaDevices?.getUserMedia) {
      cleanupAudio();
      if (activeGlobalSession?.generation === currentGen) {
        activeGlobalSession = null;
      }
      setState("idle");
      callbacks.onError(dictationError("not-supported"));
      return;
    }

    // 4. Async boundary: getUserMedia
    let acquiredStream: MediaStream;
    try {
      acquiredStream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      cleanupAudio();
      if (isStale()) return;
      if (activeGlobalSession?.generation === currentGen) {
        activeGlobalSession = null;
      }
      setState("idle");
      const errName = err instanceof Error ? err.name : "";
      callbacks.onError(
        dictationError(
          errName === "NotAllowedError" || errName === "PermissionDeniedError"
            ? "not-allowed"
            : errName === "NotFoundError" || errName === "DevicesNotFoundError"
              ? "audio-capture"
              : "audio-capture",
        ),
      );
      return;
    }

    // CRITICAL: If cancelled or superseded while getUserMedia was resolving,
    // stop the late-resolving tracks immediately to prevent microphone privacy leak!
    if (isStale()) {
      cleanupAudio();
      try {
        acquiredStream.getTracks().forEach((track) => track.stop());
      } catch {
        // Teardown: track stop error is ignored to ensure clean audio disposal
      }
      return;
    }
    stream = acquiredStream;

    // 5. Async boundary: Await user gesture audioContext.resume()
    // WebKit and modern browsers start AudioContext in 'suspended' state; must resume within user gesture
    if (resumeOutcomePromise) {
      const ok = await resumeOutcomePromise;
      if (!ok || resumeError || audioContext.state === "suspended") {
        cleanupAudio();
        if (activeGlobalSession?.generation === currentGen) {
          activeGlobalSession = null;
        }
        setState("idle");
        callbacks.onError(dictationError("not-supported"));
        return;
      }
    } else if (audioContext.state === "suspended") {
      cleanupAudio();
      if (activeGlobalSession?.generation === currentGen) {
        activeGlobalSession = null;
      }
      setState("idle");
      callbacks.onError(dictationError("not-supported"));
      return;
    }

    if (isStale()) {
      cleanupAudio();
      return;
    }

    chunks.length = 0;
    totalSamplesCollected = 0;
    sourceNode = audioContext.createMediaStreamSource(stream);

    // Create a silent gain node to destination.
    // In Web Audio engines (especially WebKit), unreferenced processing nodes without
    // a downstream path to the context destination can be garbage-collected or culled from rendering.
    // Routing through gain = 0 ensures the processor stays active without audible feedback.
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    silentGain.connect(audioContext.destination);
    silentGainNode = silentGain;

    // 6. Async boundary: AudioWorklet module load
    let workletAttached = false;
    if (audioContext.audioWorklet?.addModule) {
      try {
        await audioContext.audioWorklet.addModule("/dictation-worklet.js");
        if (isStale()) {
          cleanupAudio();
          return;
        }
        const node = new AudioWorkletNode(audioContext, "dictation-processor");
        node.port.onmessage = (event) => {
          handleAudioChunk(event.data as Float32Array);
        };
        sourceNode.connect(node);
        node.connect(silentGain);
        workletNode = node;
        workletAttached = true;
      } catch {
        // Worklet load failure falls back to ScriptProcessorNode below
      }
    }

    if (!workletAttached) {
      if (isStale()) {
        cleanupAudio();
        return;
      }
      const script = audioContext.createScriptProcessor(4096, 1, 1);
      script.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        handleAudioChunk(input);
      };
      sourceNode.connect(script);
      script.connect(silentGain);
      scriptNode = script;
    }

    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handleKeyDown);
    }

    setState("listening");
  };

  const stop = async () => {
    if (state !== "listening" || isStale()) return;

    setState("transcribing");
    abortController = new AbortController();
    const capturedAbort = abortController;

    const currentSampleRate = audioContext?.sampleRate ?? 16000;
    // Capture chunk references before audio hardware cleanup resets chunks.length
    const capturedChunks = [...chunks];
    const totalLength = capturedChunks.reduce((acc, c) => acc + c.length, 0);

    // Release microphone tracks and audio context immediately
    cleanupAudio();

    if (isStale()) {
      setState("idle");
      return;
    }

    if (totalLength === 0) {
      if (activeGlobalSession?.generation === sessionGeneration) {
        activeGlobalSession = null;
      }
      setState("idle");
      callbacks.onError(dictationError("no-speech"));
      return;
    }

    try {
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const c of capturedChunks) {
        merged.set(c, offset);
        offset += c.length;
      }

      const pcm16k = resampleTo16k(merged, currentSampleRate);

      const response = await fetchFn("/api/voice/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-transcribe-session-id": sessionId,
        },
        body: pcm16k.buffer as ArrayBuffer,
        signal: capturedAbort.signal,
      });

      if (isStale() || capturedAbort.signal.aborted) {
        setState("idle");
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = (await response.json()) as TranscribeResponse;

      if (isStale() || capturedAbort.signal.aborted) {
        setState("idle");
        return;
      }

      const text = result.text ? result.text.trim() : "";
      if (text) {
        callbacks.onText(text);
      } else {
        callbacks.onError(dictationError("no-speech"));
      }
      setState("idle");
    } catch {
      // Check if cancellation or generation switch aborted this request
      if (isStale() || capturedAbort.signal.aborted || isCanceled) {
        setState("idle");
        return;
      }
      setState("idle");
      callbacks.onError(dictationError("network"));
    } finally {
      if (activeGlobalSession?.generation === sessionGeneration) {
        activeGlobalSession = null;
      }
    }
  };

  const dispose = () => {
    cancel();
    isDisposed = true;
  };

  return {
    id: sessionId,
    start,
    stop,
    cancel,
    dispose,
  };
}
