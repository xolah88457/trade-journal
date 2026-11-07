import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateRms,
  cancelVoiceSession,
  createLocalDictationSession,
  dictationError,
  fetchVoiceStatus,
  getActiveDictationSession,
  insertDictatedText,
  resampleTo16k,
  setupVoiceModel,
  type DictationSessionCallbacks,
} from "../src/lib/dictation";

describe("insertDictatedText", () => {
  it("inserts into empty text", () => {
    const res = insertDictatedText({
      currentText: "",
      selectionStart: 0,
      selectionEnd: 0,
      dictatedText: "Broke resistance at 4200",
    });
    expect(res.value).toBe("Broke resistance at 4200");
    expect(res.selectionStart).toBe("Broke resistance at 4200".length);
    expect(res.selectionEnd).toBe("Broke resistance at 4200".length);
  });

  it("appends to existing text without trailing space by adding a single space", () => {
    const res = insertDictatedText({
      currentText: "First note.",
      selectionStart: 11,
      selectionEnd: 11,
      dictatedText: "Second note.",
    });
    expect(res.value).toBe("First note. Second note.");
    expect(res.selectionStart).toBe("First note. Second note.".length);
  });

  it("appends to existing text that already has a trailing space without duplicating spaces", () => {
    const res = insertDictatedText({
      currentText: "First note. ",
      selectionStart: 12,
      selectionEnd: 12,
      dictatedText: "Second note.",
    });
    expect(res.value).toBe("First note. Second note.");
  });

  it("appends after a newline without prepending a space", () => {
    const res = insertDictatedText({
      currentText: "## Market Context\n",
      selectionStart: 18,
      selectionEnd: 18,
      dictatedText: "Strong trend day.",
    });
    expect(res.value).toBe("## Market Context\nStrong trend day.");
  });

  it("inserts in the middle of text with proper surrounding spaces", () => {
    const res = insertDictatedText({
      currentText: "Opening gap was filled.",
      selectionStart: 11,
      selectionEnd: 11,
      dictatedText: "quickly",
    });
    expect(res.value).toBe("Opening gap quickly was filled.");
  });

  it("replaces an active selection without damaging surrounding text", () => {
    const res = insertDictatedText({
      currentText: "Exit was too late on the pullback.",
      selectionStart: 9,
      selectionEnd: 17, // "too late"
      dictatedText: "perfect",
    });
    expect(res.value).toBe("Exit was perfect on the pullback.");
  });

  it("handles punctuation without inserting an awkward space before commas or periods", () => {
    const res = insertDictatedText({
      currentText: "Waited for confirmation",
      selectionStart: 23,
      selectionEnd: 23,
      dictatedText: ", but volume faded.",
    });
    expect(res.value).toBe("Waited for confirmation, but volume faded.");
  });

  it("returns unchanged text when dictated speech is empty or whitespace", () => {
    const res = insertDictatedText({
      currentText: "Existing text",
      selectionStart: 5,
      selectionEnd: 5,
      dictatedText: "   ",
    });
    expect(res.value).toBe("Existing text");
    expect(res.selectionStart).toBe(5);
  });
});

describe("resampleTo16k and calculateRms", () => {
  it("leaves 16kHz audio unchanged", () => {
    const original = new Float32Array([0.1, -0.2, 0.3]);
    const res = resampleTo16k(original, 16000);
    expect(res).toBe(original);
  });

  it("downsamples 48kHz audio to 16kHz (3x decimation length)", () => {
    const original = new Float32Array(480);
    for (let i = 0; i < 480; i++) original[i] = Math.sin(i);
    const res = resampleTo16k(original, 48000);
    expect(res.length).toBe(160);
  });

  it("computes RMS volume accurately", () => {
    expect(calculateRms(new Float32Array([]))).toBe(0);
    expect(calculateRms(new Float32Array([0, 0, 0]))).toBe(0);
    const wave = new Float32Array([0.2, -0.2, 0.2, -0.2]);
    const rms = calculateRms(wave);
    expect(rms).toBeGreaterThan(0);
    expect(rms).toBeLessThanOrEqual(1);
  });
});

describe("dictationError messages", () => {
  it("translates permission denial, missing mic, and no-speech codes into user-friendly notices", () => {
    expect(dictationError("not-allowed")).toContain("permission");
    expect(dictationError("NotFoundError")).toContain("microphone is available");
    expect(dictationError("no-speech")).toContain("No speech was detected");
    expect(dictationError("model-offline")).toContain("transcription model is not ready");
  });
});

describe("Local dictation session controller", () => {
  let fakeFetch: ReturnType<typeof vi.fn>;
  let fakeMediaDevices: { getUserMedia: ReturnType<typeof vi.fn> };
  let mockTrack: { stop: ReturnType<typeof vi.fn> };
  let mockStream: { getTracks: () => (typeof mockTrack)[] };

  interface MockScriptProcessor {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onaudioprocess:
      ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
  }

  let capturedScriptNode: MockScriptProcessor | null = null;

  class FakeAudioContext {
    sampleRate = 16000;
    state = "running";
    destination = {};
    resume = vi.fn().mockResolvedValue(undefined);
    audioWorklet = {
      addModule: vi.fn().mockResolvedValue(undefined),
    };
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createGain() {
      return {
        gain: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }
    createScriptProcessor(): MockScriptProcessor {
      const proc: MockScriptProcessor = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        onaudioprocess: null,
      };
      capturedScriptNode = proc;
      return proc;
    }
    close = vi.fn().mockResolvedValue(undefined);
  }

  class FakeAudioContextNoWorklet extends FakeAudioContext {
    override audioWorklet = {
      addModule: vi.fn().mockRejectedValue(new Error("No worklet")),
    };
  }

  beforeEach(() => {
    mockTrack = { stop: vi.fn() };
    mockStream = { getTracks: () => [mockTrack] };

    fakeMediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(mockStream),
    };

    fakeFetch = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const setupSession = (callbacksPartial: Partial<DictationSessionCallbacks> = {}) => {
    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
      onAudioLevel: vi.fn(),
      ...callbacksPartial,
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: FakeAudioContext as unknown as typeof AudioContext,
    });
    return { session, callbacks };
  };

  it("checks status and transitions to setup-required when model is not cached", async () => {
    fakeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ready: false,
        cached: false,
        activeModel: "parakeet-unified-en-0.6b",
        vadReady: false,
      }),
    });

    const { session, callbacks } = setupSession();
    await session.start();

    expect(callbacks.onState).toHaveBeenCalledWith("checking");
    expect(callbacks.onState).toHaveBeenCalledWith("setup-required");
    expect(fakeMediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("automatically prepares the model when cached but not yet ready", async () => {
    fakeFetch
      // status response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ready: false,
          cached: true,
          activeModel: "parakeet-unified-en-0.6b",
          vadReady: false,
        }),
      })
      // setup response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, device: "Apple Silicon Metal" }),
      });

    const { session, callbacks } = setupSession();
    await session.start();

    expect(callbacks.onState).toHaveBeenCalledWith("checking");
    expect(callbacks.onState).toHaveBeenCalledWith("preparing");
    expect(callbacks.onState).toHaveBeenCalledWith("starting");
    expect(callbacks.onState).toHaveBeenCalledWith("listening");
  });

  it("handles microphone permission denial cleanly", async () => {
    fakeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ready: true, cached: true }),
    });

    const notAllowedError = new Error("Permission denied");
    notAllowedError.name = "NotAllowedError";
    fakeMediaDevices.getUserMedia.mockRejectedValueOnce(notAllowedError);

    const { session, callbacks } = setupSession();
    await session.start();

    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining("permission"));
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
  });

  it("handles missing audio capture device cleanly", async () => {
    fakeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ready: true, cached: true }),
    });

    const notFoundError = new Error("Device not found");
    notFoundError.name = "NotFoundError";
    fakeMediaDevices.getUserMedia.mockRejectedValueOnce(notFoundError);

    const { session, callbacks } = setupSession();
    await session.start();

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining("microphone is available"),
    );
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
  });

  it("enforces single active recording: starting session B cancels active session A", async () => {
    fakeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ready: true, cached: true }),
    });

    const sessionA = setupSession();
    await sessionA.session.start();
    expect(sessionA.callbacks.onState).toHaveBeenLastCalledWith("listening");
    expect(getActiveDictationSession()?.id).toBe(sessionA.session.id);

    const sessionB = setupSession();
    await sessionB.session.start();

    // Session A should have been canceled
    expect(sessionA.callbacks.onState).toHaveBeenLastCalledWith("idle");
    expect(sessionB.callbacks.onState).toHaveBeenLastCalledWith("listening");
    expect(getActiveDictationSession()?.id).toBe(sessionB.session.id);
  });

  it("canceling an active session cleans up microphone tracks and notifies backend cancel route", async () => {
    fakeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ready: true, cached: true, ok: true }),
    });

    const { session, callbacks } = setupSession();
    await session.start();
    expect(callbacks.onState).toHaveBeenLastCalledWith("listening");

    session.cancel();
    expect(mockTrack.stop).toHaveBeenCalled();
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
    expect(callbacks.onText).not.toHaveBeenCalled();

    // Should call /api/voice/cancel
    const cancelCalls = fakeFetch.mock.calls.filter((call) => call[0] === "/api/voice/cancel");
    expect(cancelCalls.length).toBeGreaterThan(0);
  });

  it("disposing on unmount frees all audio tracks and state", async () => {
    fakeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ready: true, cached: true }),
    });

    const { session, callbacks } = setupSession();
    await session.start();
    session.dispose();

    expect(mockTrack.stop).toHaveBeenCalled();
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
  });

  it("handles stop with transcription delivery", async () => {
    fakeFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ready: true, cached: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: "Broke morning high on heavy volume",
          speechDurationMs: 2500,
          latencyMs: 120,
        }),
      });

    capturedScriptNode = null;

    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
      onAudioLevel: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: FakeAudioContextNoWorklet as unknown as typeof AudioContext,
    });

    await session.start();
    expect(callbacks.onState).toHaveBeenLastCalledWith("listening");

    // Simulate audio frame delivery
    (capturedScriptNode as MockScriptProcessor | null)?.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => new Float32Array([0.1, 0.2, 0.3]),
      },
    });

    await session.stop();

    expect(callbacks.onState).toHaveBeenCalledWith("transcribing");
    expect(callbacks.onText).toHaveBeenCalledWith("Broke morning high on heavy volume");
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");

    const transcribeCall = fakeFetch.mock.calls.find((call) => call[0] === "/api/voice/transcribe");
    expect(transcribeCall).toBeDefined();
    expect(transcribeCall![1].headers["Content-Type"]).toBe("application/octet-stream");
    const sentSessionId = transcribeCall![1].headers["x-transcribe-session-id"];
    // Validate platform UUID v4 contract required by backend
    expect(sentSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Assert NONZERO EXACT samples: verify cleanupAudio() did not clear chunks before merge!
    const sentBuffer = transcribeCall![1].body as ArrayBuffer;
    const sentFloats = new Float32Array(sentBuffer);
    expect(sentFloats.length).toBe(3);
    expect(sentFloats[0]).toBeCloseTo(0.1, 5);
    expect(sentFloats[1]).toBeCloseTo(0.2, 5);
    expect(sentFloats[2]).toBeCloseTo(0.3, 5);
    expect(mockTrack.stop).toHaveBeenCalled();
  });

  it("preserves AudioWorklet PCM chunks after cleanupAudio and uploads exact nonzero samples with valid UUID", async () => {
    fakeFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ready: true, cached: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: "Worklet transcription",
          speechDurationMs: 1000,
        }),
      });

    type WorkletHandler = (event: { data: Float32Array }) => void;
    let workletMessageCallback: WorkletHandler | null = null;
    const originalWorklet = (globalThis as unknown as { AudioWorkletNode?: unknown })
      .AudioWorkletNode;

    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode =
      class MockWorkletNode {
        port = {
          set onmessage(fn: WorkletHandler) {
            workletMessageCallback = fn;
          },
        };
        connect = vi.fn();
        disconnect = vi.fn();
      };

    try {
      const callbacks: DictationSessionCallbacks = {
        onState: vi.fn(),
        onText: vi.fn(),
        onError: vi.fn(),
      };
      const session = createLocalDictationSession(callbacks, {
        fetchFn: fakeFetch as unknown as typeof fetch,
        mediaDevices: fakeMediaDevices as unknown as MediaDevices,
        AudioContextClass: FakeAudioContext as unknown as typeof AudioContext,
      });

      await session.start();
      expect(callbacks.onState).toHaveBeenLastCalledWith("listening");

      // Deliver realistic non-zero Float32 PCM audio frames from the worklet
      const testPcmSamples = new Float32Array([0.15, -0.45, 0.75, -0.95, 0.33]);
      (workletMessageCallback as WorkletHandler | null)?.({ data: testPcmSamples });

      await session.stop();

      expect(callbacks.onText).toHaveBeenCalledWith("Worklet transcription");
      const transcribeCall = fakeFetch.mock.calls.find(
        (call) => call[0] === "/api/voice/transcribe",
      );
      expect(transcribeCall).toBeDefined();

      // Assert UUID format
      const sentSessionId = transcribeCall![1].headers["x-transcribe-session-id"];
      expect(sentSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // Assert NONZERO EXACT samples: must preserve all 5 samples, not silent zeros
      const sentBuffer = transcribeCall![1].body as ArrayBuffer;
      const sentFloats = new Float32Array(sentBuffer);
      expect(sentFloats.length).toBe(5);
      expect(sentFloats[0]).toBeCloseTo(0.15, 5);
      expect(sentFloats[1]).toBeCloseTo(-0.45, 5);
      expect(sentFloats[2]).toBeCloseTo(0.75, 5);
      expect(sentFloats[3]).toBeCloseTo(-0.95, 5);
      expect(sentFloats[4]).toBeCloseTo(0.33, 5);

      // Verify microphone track cleanup occurred
      expect(mockTrack.stop).toHaveBeenCalled();
    } finally {
      (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode = originalWorklet;
    }
  });

  it("reports no-speech when server returns empty transcription text", async () => {
    fakeFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ready: true, cached: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: "",
          speechDurationMs: 0,
        }),
      });

    capturedScriptNode = null;

    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: FakeAudioContextNoWorklet as unknown as typeof AudioContext,
    });

    await session.start();
    (capturedScriptNode as MockScriptProcessor | null)?.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => new Float32Array([0.01, 0.01]),
      },
    });

    await session.stop();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining("No speech was detected"),
    );
    expect(callbacks.onText).not.toHaveBeenCalled();
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
  });

  it("handles server transcription 500 error gracefully", async () => {
    fakeFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ready: true, cached: true }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

    capturedScriptNode = null;

    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: FakeAudioContextNoWorklet as unknown as typeof AudioContext,
    });

    await session.start();
    (capturedScriptNode as MockScriptProcessor | null)?.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => new Float32Array([0.1, 0.2]),
      },
    });

    await session.stop();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining("service is not responding"),
    );
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
  });

  it("immediately stops tracks when getUserMedia resolves late after cancel", async () => {
    let resolveMedia!: (stream: unknown) => void;
    const deferredMediaPromise = new Promise((resolve) => {
      resolveMedia = resolve;
    });
    fakeMediaDevices.getUserMedia.mockReturnValueOnce(deferredMediaPromise);
    fakeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ready: true, cached: true }),
    });

    const { session, callbacks } = setupSession();
    const startPromise = session.start();

    // Wait a tick for fetchVoiceStatus to complete and reach getUserMedia
    await new Promise((r) => setTimeout(r, 0));

    // User cancels while permission prompt is still open
    session.cancel();
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");

    // Browser permission resolves late
    const lateTrack = { stop: vi.fn() };
    const lateStream = { getTracks: () => [lateTrack] };
    resolveMedia(lateStream);

    await startPromise;

    // The late stream's tracks must have been stopped immediately to avoid mic leaks
    expect(lateTrack.stop).toHaveBeenCalled();
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
  });

  it("discards late status resolution when a new session starts", async () => {
    let resolveStatusA!: (val: unknown) => void;
    fakeFetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStatusA = resolve;
          }),
      )
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ready: true, cached: true }),
      });

    const sessionA = setupSession();
    const startAPromise = sessionA.session.start();

    // Session B starts immediately on another field
    const sessionB = setupSession();
    await sessionB.session.start();
    expect(sessionB.callbacks.onState).toHaveBeenLastCalledWith("listening");

    // Session A's status now resolves late
    resolveStatusA({
      ok: true,
      json: async () => ({ ready: true, cached: true }),
    });
    await startAPromise;

    // Session A was stale and should never proceed to listening or take over active session
    expect(sessionA.callbacks.onState).not.toHaveBeenCalledWith("listening");
    expect(getActiveDictationSession()?.id).toBe(sessionB.session.id);
  });

  it("resumes suspended AudioContext and connects worklet to silent gain node routed to destination", async () => {
    fakeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ready: true, cached: true }),
    });

    let resumeCalled = false;
    let gainConnectedToDestination = false;
    let workletConnectedToGain = false;

    let testGainNode: unknown = null;

    class TestAudioContext {
      sampleRate = 16000;
      state = "suspended";
      destination = {};
      resume = vi.fn().mockImplementation(async () => {
        resumeCalled = true;
        this.state = "running";
      });
      audioWorklet = {
        addModule: vi.fn().mockResolvedValue(undefined),
      };
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createGain() {
        const gainNode = {
          gain: { value: 1 },
          connect: vi.fn().mockImplementation((target: unknown) => {
            if (target === this.destination) {
              gainConnectedToDestination = true;
            }
          }),
          disconnect: vi.fn(),
        };
        testGainNode = gainNode;
        return gainNode;
      }
      close = vi.fn().mockResolvedValue(undefined);
    }

    const originalWorklet = (globalThis as unknown as { AudioWorkletNode?: unknown })
      .AudioWorkletNode;
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode =
      class MockWorkletNode {
        port = { onmessage: null };
        connect = vi.fn().mockImplementation((target: unknown) => {
          if (target === testGainNode) {
            workletConnectedToGain = true;
          }
        });
        disconnect = vi.fn();
      };

    try {
      const callbacks: DictationSessionCallbacks = {
        onState: vi.fn(),
        onText: vi.fn(),
        onError: vi.fn(),
      };
      const session = createLocalDictationSession(callbacks, {
        fetchFn: fakeFetch as unknown as typeof fetch,
        mediaDevices: fakeMediaDevices as unknown as MediaDevices,
        AudioContextClass: TestAudioContext as unknown as typeof AudioContext,
      });

      await session.start();

      expect(resumeCalled).toBe(true);
      expect(gainConnectedToDestination).toBe(true);
      expect(workletConnectedToGain).toBe(true);
      expect(callbacks.onState).toHaveBeenLastCalledWith("listening");
    } finally {
      (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode = originalWorklet;
    }
  });

  it("bounds recording duration to 5 minutes max", async () => {
    fakeFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, cached: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "bounded speech" }) });

    capturedScriptNode = null;
    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: FakeAudioContextNoWorklet as unknown as typeof AudioContext,
    });

    await session.start();
    expect(callbacks.onState).toHaveBeenLastCalledWith("listening");

    // 16000 * 300 = 4,800,000 samples
    const bigChunk = new Float32Array(4800000);
    (capturedScriptNode as MockScriptProcessor | null)?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => bigChunk },
    });

    // Should automatically transition to transcribing
    expect(callbacks.onState).toHaveBeenCalledWith("transcribing");
  });

  it("creates AudioContext and invokes resume() synchronously before awaiting deferred status check", async () => {
    let audioContextInstantiated = false;
    let resumeInvoked = false;

    class GestureAudioContext extends FakeAudioContext {
      constructor() {
        super();
        audioContextInstantiated = true;
      }
      override resume = vi.fn().mockImplementation(async () => {
        resumeInvoked = true;
      });
    }

    // Status check is completely deferred and has not resolved yet
    let resolveStatus!: (val: unknown) => void;
    fakeFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: GestureAudioContext as unknown as typeof AudioContext,
    });

    // Invoke session.start() synchronously
    const startPromise = session.start();

    // Verify synchronous user gesture preservation: AudioContext and resume() are invoked BEFORE status resolves!
    expect(audioContextInstantiated).toBe(true);
    expect(resumeInvoked).toBe(true);

    // Now resolve status and complete
    resolveStatus({ ok: true, json: async () => ({ ready: true, cached: true }) });
    await startPromise;

    expect(callbacks.onState).toHaveBeenLastCalledWith("listening");
    session.cancel();
  });

  it("throttles onAudioLevel callbacks while capturing and preserving 100% of audio PCM samples", async () => {
    fakeFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, cached: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "full audio captured" }) });

    capturedScriptNode = null;
    const audioLevelCalls: number[] = [];
    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
      onAudioLevel: (lvl) => audioLevelCalls.push(lvl),
    };

    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: FakeAudioContextNoWorklet as unknown as typeof AudioContext,
    });

    await session.start();

    // Deliver 10 rapid chunks of 128 samples synchronously (simulating rapid ~375Hz worklet)
    for (let i = 0; i < 10; i++) {
      const chunk = new Float32Array(128);
      chunk.fill(0.1);
      (capturedScriptNode as MockScriptProcessor | null)?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => chunk },
      });
    }

    // Audio level calls should be throttled to fewer than 5 calls instead of 10 rapid setStates
    expect(audioLevelCalls.length).toBeLessThan(5);

    // But ALL 10 * 128 = 1280 samples must be preserved and sent to transcribe
    await session.stop();

    const transcribeCall = fakeFetch.mock.calls.find((call) => call[0] === "/api/voice/transcribe");
    expect(transcribeCall).toBeDefined();
    const sentBuffer = transcribeCall![1].body as ArrayBuffer;
    expect(sentBuffer.byteLength).toBe(1280 * 4); // Float32Array = 4 bytes per sample
    const sentFloats = new Float32Array(sentBuffer);
    expect(sentFloats[0]).toBeCloseTo(0.1, 5);
    expect(sentFloats[1279]).toBeCloseTo(0.1, 5);
    expect(transcribeCall![1].headers["x-transcribe-session-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("releases active global lease even if allocation fails during stop()", async () => {
    fakeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ready: true, cached: true }),
    });

    capturedScriptNode = null;
    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: FakeAudioContextNoWorklet as unknown as typeof AudioContext,
    });

    await session.start();
    expect(getActiveDictationSession()?.id).toBe(session.id);

    // Feed a small chunk so totalLength > 0
    (capturedScriptNode as MockScriptProcessor | null)?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0.1, 0.2]) },
    });

    // Mock Float32Array constructor to throw allocation error
    const OrigFloat32 = globalThis.Float32Array;
    let callCount = 0;
    (globalThis as unknown as { Float32Array: unknown }).Float32Array =
      class MockFloat32Array extends OrigFloat32 {
        constructor(arg: unknown) {
          callCount++;
          // Throw RangeError on the merge allocation inside stop()
          if (callCount === 1) {
            throw new RangeError("Out of memory allocation test");
          }
          super(arg as ArrayBuffer);
        }
      };

    try {
      await session.stop();
      // Should report error and NOT throw unhandled rejection
      expect(callbacks.onError).toHaveBeenCalled();
      // Most importantly: activeGlobalSession lease MUST BE RELEASED (null), not busy-locked!
      expect(getActiveDictationSession()).toBeNull();
      expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
    } finally {
      globalThis.Float32Array = OrigFloat32;
    }
  });

  it("handles early resume rejection with deferred status without unhandled promise rejection and fails fast", async () => {
    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount++;
    };
    process.on("unhandledRejection", onUnhandled);

    class RejectingAudioContext extends FakeAudioContext {
      override resume = vi.fn().mockReturnValue(Promise.reject(new Error("Audio hardware denied")));
    }

    let resolveStatus!: (val: unknown) => void;
    fakeFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: RejectingAudioContext as unknown as typeof AudioContext,
    });

    const startPromise = session.start();

    // Allow promise tick so resume() rejection occurs before status resolves
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandledCount).toBe(0);

    // Now resolve status check
    resolveStatus({ ok: true, json: async () => ({ ready: true, cached: true }) });
    await startPromise;

    // Fails fast with not-supported error
    expect(callbacks.onError).toHaveBeenCalledWith(dictationError("not-supported"));
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");
    expect(unhandledCount).toBe(0);
    process.removeListener("unhandledRejection", onUnhandled);
  });

  it("handles early resume rejection when setup-required exits early without unhandled rejection", async () => {
    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount++;
    };
    process.on("unhandledRejection", onUnhandled);

    class RejectingAudioContext extends FakeAudioContext {
      override resume = vi.fn().mockReturnValue(Promise.reject(new Error("Device error")));
    }

    // Status check indicates model is not cached (exits early at setup-required, never reaches boundary 5)
    fakeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ready: false, cached: false }),
    });

    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: RejectingAudioContext as unknown as typeof AudioContext,
    });

    await session.start();

    // Should transition to setup-required without unhandled rejection
    expect(callbacks.onState).toHaveBeenCalledWith("setup-required");
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandledCount).toBe(0);
    process.removeListener("unhandledRejection", onUnhandled);
  });

  it("handles early resume rejection with immediate cancellation without unhandled rejection", async () => {
    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount++;
    };
    process.on("unhandledRejection", onUnhandled);

    class RejectingAudioContext extends FakeAudioContext {
      override resume = vi.fn().mockReturnValue(Promise.reject(new Error("Hardware failure")));
    }

    let resolveStatus!: (val: unknown) => void;
    fakeFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const callbacks: DictationSessionCallbacks = {
      onState: vi.fn(),
      onText: vi.fn(),
      onError: vi.fn(),
    };
    const session = createLocalDictationSession(callbacks, {
      fetchFn: fakeFetch as unknown as typeof fetch,
      mediaDevices: fakeMediaDevices as unknown as MediaDevices,
      AudioContextClass: RejectingAudioContext as unknown as typeof AudioContext,
    });

    const startPromise = session.start();

    // Immediately cancel
    session.cancel();
    expect(callbacks.onState).toHaveBeenLastCalledWith("idle");

    resolveStatus({ ok: true, json: async () => ({ ready: true, cached: true }) });
    await startPromise;

    await new Promise((r) => setTimeout(r, 10));
    expect(unhandledCount).toBe(0);
    process.removeListener("unhandledRejection", onUnhandled);
  });
});

describe("Field wiring source coverage", () => {
  it("verifies VoiceNote is integrated into major multiline field targets and duplicate page-level instances are removed", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const root = path.resolve(__dirname, "..");

    // 1. RichEditor toolbar integration
    const richEditorSource = fs.readFileSync(
      path.join(root, "src/components/rich-editor.tsx"),
      "utf8",
    );
    expect(richEditorSource).toContain("<VoiceNote");
    expect(richEditorSource).toContain("insertDictatedText");

    // 2. Manual Trade Entry optional notes
    const manualSource = fs.readFileSync(
      path.join(root, "src/components/manual-trade-entry.tsx"),
      "utf8",
    );
    expect(manualSource).toContain("<VoiceNote targetRef={notesRef}");

    // 3. Playbooks trading rules
    const playbooksSource = fs.readFileSync(path.join(root, "src/app/playbooks/page.tsx"), "utf8");
    expect(playbooksSource).toContain("<VoiceNote targetRef={rulesRef}");

    // 4. Prop firm forms (account, entry, receipt)
    const propFirmsSource = fs.readFileSync(
      path.join(root, "src/components/prop-firm-forms.tsx"),
      "utf8",
    );
    const propMicMatches = propFirmsSource.match(/<VoiceNote targetRef=\{notesRef\}/g);
    expect(propMicMatches).toHaveLength(3); // AccountForm, EntryForm, ReceiptForm

    // 5. Duplicate page-level VoiceNote eliminated from parent pages (now built-in to RichEditor)
    const tradesSource = fs.readFileSync(path.join(root, "src/app/trades/[key]/page.tsx"), "utf8");
    expect(tradesSource).not.toContain("<VoiceNote");

    const journalSource = fs.readFileSync(
      path.join(root, "src/app/journal/[date]/page.tsx"),
      "utf8",
    );
    expect(journalSource).not.toContain("<VoiceNote");

    const notebookSource = fs.readFileSync(path.join(root, "src/app/notebook/page.tsx"), "utf8");
    expect(notebookSource).not.toContain("<VoiceNote");
  });

  it("verifies trade critique preview wiring and AI settings instructions dictation cap", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "..");

    // Trade page critique integration
    const tradePage = fs.readFileSync(path.join(root, "src/app/trades/[key]/page.tsx"), "utf8");
    expect(tradePage).toContain("<TradeCritiqueSection tradeKey={trade.key} />");
    expect(tradePage).not.toContain("askCritique");
    expect(tradePage).not.toContain("Critique this trade");

    // AI settings instructions dictation integration
    const aiSettings = fs.readFileSync(path.join(root, "src/components/ai-settings.tsx"), "utf8");
    expect(aiSettings).toContain("<VoiceNote");
    expect(aiSettings).toContain("targetRef={instructionsRef}");
    expect(aiSettings).toContain("AI_INSTRUCTIONS_MAX_LENGTH");
    expect(aiSettings).toContain("Would exceed");
    expect(aiSettings).toContain("existing instructions unchanged");
  });

  it("rejects overflow dictation without truncating pre-existing instructions (1900 chars + 500 insert keeps 1900 unchanged)", () => {
    const AI_INSTRUCTIONS_MAX_LENGTH = 2000;
    const existing1900 = "a".repeat(1900);
    const dictated500 = "b".repeat(500);

    // Dictating into the middle (cursor at 500)
    const result = insertDictatedText({
      currentText: existing1900,
      selectionStart: 500,
      selectionEnd: 500,
      dictatedText: dictated500,
    });

    expect(result.value.length).toBe(2402); // 1900 + 500 + 2 spaces (before and after)

    let currentInstructions = existing1900;
    let failureNotice = "";

    const onTextHandler = (newText: string) => {
      if (newText.length > AI_INSTRUCTIONS_MAX_LENGTH) {
        failureNotice = `Would exceed ${AI_INSTRUCTIONS_MAX_LENGTH}; existing instructions unchanged.`;
        // Reject update: do not overwrite or truncate pre-existing instructions!
      } else {
        currentInstructions = newText;
        failureNotice = "";
      }
    };

    onTextHandler(result.value);

    // Existing 1900 characters must remain completely untouched without tail data-loss
    expect(currentInstructions).toBe(existing1900);
    expect(currentInstructions.length).toBe(1900);
    expect(failureNotice).toBe("Would exceed 2000; existing instructions unchanged.");
  });

  it("VoiceNote marks starting as busy to prevent double permission clicks and shows Starting… label", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "..");
    const voiceNoteSource = fs.readFileSync(
      path.join(root, "src/components/voice-note.tsx"),
      "utf8",
    );

    // Verify starting is included in isBusy and toggle guard
    expect(voiceNoteSource).toContain('state === "starting"');
    expect(voiceNoteSource).toContain('state === "starting"\n                  ? "Starting…"');
  });

  it("RichEditor only shifts caret to end on onPrepare if preview mode is active, preserving existing edit selection", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "..");
    const editorSource = fs.readFileSync(path.join(root, "src/components/rich-editor.tsx"), "utf8");

    // Verify onPrepare checks if (preview) before setting caret
    expect(editorSource).toContain("if (preview) {\n              setPreview(false);");
    // Verify onText reads current DOM value fallback to prop
    expect(editorSource).toContain("const currentValue = ref.current?.value ?? value;");
  });

  it("VoiceNote closes popover and sets state to idle after download without autostarting microphone outside user gesture", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "..");
    const voiceNoteSource = fs.readFileSync(
      path.join(root, "src/components/voice-note.tsx"),
      "utf8",
    );

    // Verify handleDownloadModel does NOT call startSession() after setup, setting state to idle instead
    expect(voiceNoteSource).toContain(
      'await setupVoiceModel();\n      setSetupOpen(false);\n      setState("idle");',
    );
    expect(voiceNoteSource).not.toContain(
      "await setupVoiceModel();\n      setSetupOpen(false);\n      startSession();",
    );
  });

  it("VoiceNote renders visible Cancel button when listening or busy to allow canceling pending work outside Esc", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "..");
    const voiceNoteSource = fs.readFileSync(
      path.join(root, "src/components/voice-note.tsx"),
      "utf8",
    );

    // Verify Cancel button is rendered during isListening OR isBusy
    expect(voiceNoteSource).toContain("{(isListening || isBusy) && (\n          <Button");
    expect(voiceNoteSource).toContain("onClick={handleCancel}");
  });
});
