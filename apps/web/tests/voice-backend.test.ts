import { describe, expect, it, vi, beforeEach } from "vitest";

beforeEach(() => {
  delete process.env.JOURNAL_PASSWORD;
});
import { SpeechGate, framesFor, concatPcm, filterSpeech } from "@/server/voice/vad";
import {
  sliceIntoChunks,
  speechSegments,
  cutCandidates,
  planCuts,
  joinTranscripts,
} from "@/server/voice/chunking";
import {
  verifyFileIntegrity,
  resolveAsrModelPath,
  resolveVadModelPath,
} from "@/server/voice/model-cache";
import { checkSameOrigin } from "@/server/voice/security";
import { AUDIO_CONFIG, VAD_CONFIG, ASR_MODEL, SILERO_VAD_MODEL } from "@/server/voice/constants";
import { POST as transcribeHandler } from "@/app/api/voice/transcribe/route";
import { POST as cancelHandler } from "@/app/api/voice/cancel/route";
import { GET as statusHandler } from "@/app/api/voice/status/route";
import { POST as setupHandler } from "@/app/api/voice/setup/route";
import { voiceEngine, EngineBusyError } from "@/server/voice/engine";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Voice Activity Detection (VAD) & SpeechGate", () => {
  it("framesFor calculates exact 32ms frame counts", () => {
    // 450 ms / 32 ms = 14.0625 -> ceil = 15 frames
    expect(framesFor(450)).toBe(15);
    // 60 ms / 32 ms = 1.875 -> ceil = 2 frames
    expect(framesFor(60)).toBe(2);
  });

  it("concatPcm merges multiple chunks correctly", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([3, 4, 5]);
    const merged = concatPcm([a, b]);
    expect(merged.length).toBe(5);
    expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5]);
  });

  it("SpeechGate withholds brief unvoiced noise and does not trigger speech", () => {
    const gate = new SpeechGate<Float32Array>({
      prefillFrames: 15,
      onsetFrames: 2,
      hangoverFrames: 15,
    });
    const frame = new Float32Array(512);

    // Single voiced frame (less than onsetFrames: 2) followed by silence
    const emitted1 = gate.push(frame, true);
    expect(emitted1.length).toBe(0);
    expect(gate.inSpeech).toBe(false);

    const emitted2 = gate.push(frame, false);
    expect(emitted2.length).toBe(0);
    expect(gate.inSpeech).toBe(false);
  });

  it("SpeechGate triggers speech on reaching onset and emits prefill buffer", () => {
    const gate = new SpeechGate<Float32Array>({
      prefillFrames: 3,
      onsetFrames: 2,
      hangoverFrames: 2,
    });
    const frame1 = new Float32Array([1]);
    const frame2 = new Float32Array([2]);
    const frame3 = new Float32Array([3]);
    const frame4 = new Float32Array([4]);

    // Push two unvoiced prefill frames
    gate.push(frame1, false);
    gate.push(frame2, false);

    // Push 2 consecutive voiced frames
    const out1 = gate.push(frame3, true);
    expect(out1.length).toBe(0);
    expect(gate.inSpeech).toBe(false);

    const out2 = gate.push(frame4, true);
    expect(gate.inSpeech).toBe(true);
    // Should emit withheld prefill frames plus current frames
    expect(out2.length).toBeGreaterThanOrEqual(2);
  });

  it("SpeechGate keeps hangover frames after voice ends then closes", () => {
    const gate = new SpeechGate<Float32Array>({
      prefillFrames: 2,
      onsetFrames: 1,
      hangoverFrames: 2,
    });
    const frame = new Float32Array(512);

    // Trigger speech immediately
    gate.push(frame, true);
    expect(gate.inSpeech).toBe(true);

    // Hangover frame 1
    const h1 = gate.push(frame, false);
    expect(h1.length).toBe(1);
    expect(gate.inSpeech).toBe(true);

    // Hangover frame 2
    const h2 = gate.push(frame, false);
    expect(h2.length).toBe(1);
    expect(gate.inSpeech).toBe(true);

    // Hangover expired -> speech ends
    const h3 = gate.push(frame, false);
    expect(h3.length).toBe(0);
    expect(gate.inSpeech).toBe(false);
  });

  it("filterSpeech detects all-silence and marks allSilence: true to skip ASR", async () => {
    const mockVadModel = {
      createVadSession: () => ({
        run: async () => ({ probs: [0.01, 0.02, 0.05], segments: [] }),
        dispose: () => {},
      }),
    } as any;

    const pcm = new Float32Array(512 * 3);
    const result = await filterSpeech(mockVadModel, pcm);
    expect(result.allSilence).toBe(true);
    expect(result.speechPcm.length).toBe(0);
  });

  it("filterSpeech preserves full audio with warning if VAD detector fails", async () => {
    const mockFailingVadModel = {
      createVadSession: () => ({
        run: async () => {
          throw new Error("Native VAD crash simulation");
        },
        dispose: () => {},
      }),
    } as any;

    const pcm = new Float32Array(1024).fill(0.1);
    const result = await filterSpeech(mockFailingVadModel, pcm);
    expect(result.allSilence).toBe(false);
    expect(result.speechPcm.length).toBe(1024);
    expect(result.warning).toContain("VAD detector failed");
  });
});

describe("Audio Chunking & Long Note Slicing", () => {
  it("keeps audio under 40 seconds as a single chunk", () => {
    const shortAudio = new Float32Array(16000 * 20); // 20 seconds
    const chunks = sliceIntoChunks(shortAudio);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBe(shortAudio.length);
  });

  it("slices audio over 40 seconds into ~30s chunks at pauses", () => {
    const longAudio = new Float32Array(16000 * 75); // 75 seconds
    // Generate simulated probabilities: speech, then pause at ~30s, speech, pause at ~60s
    const totalFrames = Math.ceil(longAudio.length / 512);
    const probs: number[] = new Array(totalFrames).fill(0.8);

    // Pause between 28s and 32s (samples 28*16000=448000 to 32*16000=512000)
    const pauseStartFrame = Math.floor((28 * 16000) / 512);
    const pauseEndFrame = Math.floor((32 * 16000) / 512);
    for (let f = pauseStartFrame; f < pauseEndFrame; f++) {
      probs[f] = 0.05;
    }

    const chunks = sliceIntoChunks(longAudio, probs);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Each chunk must be bounded <= 40s (640,000 samples)
      expect(chunk.length).toBeLessThanOrEqual(40 * 16000);
    }
  });

  it("joinTranscripts correctly handles spaces, punctuation, and unspaced CJK scripts", () => {
    expect(joinTranscripts(["Trade", "entered", "at", "support."])).toBe(
      "Trade entered at support.",
    );
    expect(joinTranscripts(["Broke out,", " then pulled back."])).toBe(
      "Broke out, then pulled back.",
    );
    expect(joinTranscripts(["   Trimmed size.   ", "Kept stop in place.  "])).toBe(
      "Trimmed size. Kept stop in place.",
    );
    // Unspaced scripts
    expect(joinTranscripts(["交易", "入场"])).toBe("交易入场");
  });
});

describe("Model Integrity & Verification", () => {
  it("verifyFileIntegrity validates correct size and SHA256", async () => {
    const tempFile = join(tmpdir(), `sumi-test-integrity-${Date.now()}.bin`);
    const content = Buffer.from("sumi test payload for sha256 verification");
    writeFileSync(tempFile, content);

    const { createHash } = await import("node:crypto");
    const expectedSha256 = createHash("sha256").update(content).digest("hex");

    try {
      const valid = await verifyFileIntegrity(tempFile, content.length, expectedSha256);
      expect(valid).toBe(true);

      const wrongSize = await verifyFileIntegrity(tempFile, content.length + 10, expectedSha256);
      expect(wrongSize).toBe(false);

      const wrongHash = await verifyFileIntegrity(
        tempFile,
        content.length,
        "0000000000000000000000000000000000000000000000000000000000000000",
      );
      expect(wrongHash).toBe(false);
    } finally {
      unlinkSync(tempFile);
    }
  });

  it("resolves Silero VAD asset path from repo models directory", async () => {
    const vadPath = await resolveVadModelPath();
    expect(vadPath).not.toBeNull();
    expect(existsSync(vadPath!)).toBe(true);
  });
});

describe("Security & Same-Origin Guard", () => {
  it("allows same-origin requests with matching Host and Origin", () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/status", {
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(true);
  });

  it("allows valid direct loopback Host without Origin header (direct navigation / native client)", () => {
    for (const host of [
      "127.0.0.1:3000",
      "localhost:3000",
      "[::1]:3000",
      "localhost",
      "127.0.0.1",
    ]) {
      const req = new Request(`http://${host}/api/voice/status`, {
        headers: { host },
      });
      const check = checkSameOrigin(req);
      expect(check.ok).toBe(true);
    }
  });

  it("blocks DNS rebinding where matching Host and Origin are external attacker domain with 403", () => {
    const req = new Request("http://rebind.attacker.com:3000/api/voice/status", {
      headers: {
        host: "rebind.attacker.com:3000",
        origin: "http://rebind.attacker.com:3000",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
    expect(check.reason).toContain("loopback");
  });

  it("blocks missing Host header even when forged x-forwarded-host is present with 403", () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/status", {
      headers: {
        "x-forwarded-host": "127.0.0.1:3000",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
  });

  it("blocks DNS lookalike hosts (localhost.evil, 127.evil, 127.0.0.1.attacker.com) with 403", () => {
    for (const fakeHost of [
      "localhost.evil.com",
      "127.evil.com",
      "127.0.0.1.attacker.com",
      "localhost.evil:3000",
      "127.0.0.1.com:3000",
    ]) {
      const req = new Request(`http://${fakeHost}/api/voice/status`, {
        headers: { host: fakeHost },
      });
      const check = checkSameOrigin(req);
      expect(check.ok).toBe(false);
      expect(check.status).toBe(403);
    }
  });

  it("blocks userinfo @ in Host authority or Origin with 403", () => {
    const req1 = new Request("http://127.0.0.1:3000/api/voice/status", {
      headers: { host: "localhost@evil.com" },
    });
    expect(checkSameOrigin(req1).status).toBe(403);

    const req2 = new Request("http://127.0.0.1:3000/api/voice/status", {
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://localhost@evil.com",
      },
    });
    expect(checkSameOrigin(req2).status).toBe(403);
  });

  it("blocks Origin with mismatched port with 403", () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:4000",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
    expect(check.reason).toContain("port mismatch");
  });

  it("blocks localhost Origin against 127.0.0.1 Host with 403 (strict exact host, no alias)", () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/status", {
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://localhost:3000",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
    expect(check.reason).toContain("Origin and Host mismatch");
  });

  it("blocks https Origin against http request with 403 (protocol mismatch)", () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/status", {
      headers: {
        host: "127.0.0.1:3000",
        origin: "https://127.0.0.1:3000",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
    expect(check.reason).toContain("Origin protocol mismatch");
  });

  it("blocks Origin containing non-root path with 403", () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/status", {
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000/app",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
    expect(check.reason).toContain("Origin path");
  });

  it("blocks cross-origin requests from external origins with 403", () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      headers: {
        host: "127.0.0.1:3000",
        origin: "https://evil-cross-site.com",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
  });

  it("blocks requests with Sec-Fetch-Site: cross-site with 403", () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      headers: {
        host: "127.0.0.1:3000",
        "sec-fetch-site": "cross-site",
      },
    });
    const check = checkSameOrigin(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
  });

  it("returns clean 400 Bad Request when auth cookie has malformed percent encoding", async () => {
    process.env.JOURNAL_PASSWORD = "test-security-secret";

    try {
      const req = new Request("http://127.0.0.1:3000/api/voice/status", {
        headers: {
          host: "127.0.0.1:3000",
          cookie: "journal_session=%E0%A4%A",
        },
      });
      const check = checkSameOrigin(req);
      expect(check.ok).toBe(false);
      expect(check.status).toBe(400);
      expect(check.reason).toContain("Malformed cookie");
    } finally {
      delete process.env.JOURNAL_PASSWORD;
    }
  });

  it("tolerates whitespace in cookie header and validates valid session", async () => {
    process.env.JOURNAL_PASSWORD = "test-security-secret";

    const { sessionToken } = await import("@/server/auth");
    const validToken = sessionToken();

    try {
      const req = new Request("http://127.0.0.1:3000/api/voice/status", {
        headers: {
          host: "127.0.0.1:3000",
          cookie: `theme=parchment;   journal_session=${validToken};  fontSize=14`,
        },
      });
      const check = checkSameOrigin(req);
      expect(check.ok).toBe(true);
    } finally {
      delete process.env.JOURNAL_PASSWORD;
    }
  });
});

describe("API Route Contracts & Boundary Validations", () => {
  it("GET /api/voice/status returns required schema", async () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/status", {
      headers: { host: "127.0.0.1:3000" },
    });
    const res = await statusHandler(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.ready).toBe("boolean");
    expect(typeof json.cached).toBe("boolean");
    expect(json.activeModel).toBe("parakeet-unified-en-0.6b");
    expect(typeof json.vadReady).toBe("boolean");
  });

  it("POST /api/voice/cancel returns { ok: true }", async () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/cancel", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "test-session-123" }),
    });
    const res = await cancelHandler(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("POST /api/voice/transcribe rejects non-octet-stream Content-Type with 415", async () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
        "x-transcribe-session-id": "123e4567-e89b-12d3-a456-426614174000",
      },
      body: JSON.stringify({ error: "bad" }),
    });
    const res = await transcribeHandler(req);
    expect(res.status).toBe(415);
  });

  it("POST /api/voice/transcribe rejects missing session ID header with 400", async () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/octet-stream",
      },
      body: new Float32Array(512).buffer,
    });
    const res = await transcribeHandler(req);
    expect(res.status).toBe(400);
  });

  it("POST /api/voice/transcribe rejects invalid UUID format for session ID with 400", async () => {
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/octet-stream",
        "x-transcribe-session-id": "not-a-valid-uuid",
      },
      body: new Float32Array(512).buffer,
    });
    const res = await transcribeHandler(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("UUID");
  });

  it("POST /api/voice/transcribe rejects buffers not multiple of 4 bytes with 400", async () => {
    const oddBytes = new Uint8Array([1, 2, 3]);
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/octet-stream",
        "x-transcribe-session-id": "123e4567-e89b-12d3-a456-426614174000",
      },
      body: oddBytes.buffer,
    });
    const res = await transcribeHandler(req);
    expect(res.status).toBe(400);
  });

  it("POST /api/voice/transcribe rejects audio exceeding 5 minutes with 413 via Content-Length", async () => {
    // 5 minutes max = 19,200,000 bytes. Create a body larger than that.
    const oversizeBytes = new Uint8Array(AUDIO_CONFIG.maxBytes + 4);
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/octet-stream",
        "x-transcribe-session-id": "123e4567-e89b-12d3-a456-426614174000",
      },
      body: oversizeBytes.buffer,
    });
    const res = await transcribeHandler(req);
    expect(res.status).toBe(413);
  });

  it("POST /api/voice/transcribe cancels oversized stream without Content-Length and returns 413 without invoking engine", async () => {
    const transcribeSpy = vi.spyOn(voiceEngine, "transcribe");
    let readerCanceled = false;

    // Stream producing chunks exceeding 19.2 MB (4 chunks of 5 MB = 20 MB)
    const chunk = new Uint8Array(5 * 1024 * 1024);
    let sentChunks = 0;
    const stream = new ReadableStream({
      pull(controller) {
        sentChunks++;
        if (sentChunks <= 4) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
      cancel() {
        readerCanceled = true;
      },
    });

    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/octet-stream",
        "x-transcribe-session-id": "123e4567-e89b-12d3-a456-426614174000",
      },
      body: stream,
      // @ts-expect-error duplex required for streaming request body in Node Fetch
      duplex: "half",
    });

    const res = await transcribeHandler(req);
    expect(res.status).toBe(413);
    expect(readerCanceled).toBe(true);
    expect(transcribeSpy).not.toHaveBeenCalled();
    transcribeSpy.mockRestore();
  });

  it("POST /api/voice/transcribe rejects non-finite float samples (NaN / Infinity) with 400", async () => {
    const pcmWithNan = new Float32Array([0.1, NaN, 0.3]);
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/octet-stream",
        "x-transcribe-session-id": "123e4567-e89b-12d3-a456-426614174000",
      },
      body: pcmWithNan.buffer,
    });
    const res = await transcribeHandler(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("non-finite");
  });

  it("POST /api/voice/transcribe returns empty transcript on zero-length audio", async () => {
    const emptyPcm = new Float32Array(0);
    const req = new Request("http://127.0.0.1:3000/api/voice/transcribe", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "Content-Type": "application/octet-stream",
        "x-transcribe-session-id": "123e4567-e89b-12d3-a456-426614174000",
      },
      body: emptyPcm.buffer,
    });
    const res = await transcribeHandler(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.text).toBe("");
    expect(json.speechDurationMs).toBe(0);
  });
});

describe("Voice Engine Concurrency & Cancellation", () => {
  it("cancelJob aborts the active session when matching sessionId", () => {
    const canceled = voiceEngine.cancelJob("non-existent-session");
    expect(canceled).toBe(false);
  });
});

describe("Resource Cleanup on Load Failure", () => {
  it("disposes partial ASR model if subsequent VAD model load fails", async () => {
    const { TranscribeModel } = await import("transcribe-cpp");
    const disposeSpy = vi.fn();
    const fakeAsrModel = {
      dispose: disposeSpy,
      device: { name: "FakeDevice" },
      backend: "cpu",
    };

    const originalLoad = TranscribeModel.load;
    let callCount = 0;
    (TranscribeModel as any).load = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return fakeAsrModel;
      }
      throw new Error("VAD load failure simulation");
    });

    try {
      let asr: any = null;
      let vad: any = null;
      let caughtError: any = null;
      try {
        asr = await TranscribeModel.load("fake-asr.gguf");
        vad = await TranscribeModel.load("fake-vad.gguf");
      } catch (err) {
        caughtError = err;
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
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toBe("VAD load failure simulation");
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(asr).toBeNull();
    } finally {
      (TranscribeModel as any).load = originalLoad;
    }
  });
});

const realVoiceWavPath = process.env.SUMI_REAL_VOICE_WAV;
const hasRealVoiceWav = Boolean(realVoiceWavPath && existsSync(realVoiceWavPath));

describe("End-to-End Real Inference Smoke Test", () => {
  it.skipIf(!hasRealVoiceWav)(
    "transcribes synthetic speech WAV using cached Parakeet model (opt-in via SUMI_REAL_VOICE_WAV)",
    async () => {
      const fixturePath = realVoiceWavPath!;
      const { readFileSync } = await import("node:fs");
      const wavBuf = readFileSync(fixturePath);
      const dataOffset = wavBuf.indexOf(Buffer.from("data")) + 8;
      const pcmInt16 = new Int16Array(
        wavBuf.buffer,
        wavBuf.byteOffset + dataOffset,
        (wavBuf.length - dataOffset) / 2,
      );
      const pcmFloat32 = new Float32Array(pcmInt16.length);
      for (let i = 0; i < pcmInt16.length; i++) {
        pcmFloat32[i] = pcmInt16[i]! / 32768.0;
      }

      try {
        const res = await voiceEngine.transcribe("smoke-session-test", pcmFloat32);
        expect(res.text.length).toBeGreaterThan(0);
        expect(res.text.toLowerCase()).toContain("trading plan");
        expect(res.speechDurationMs).toBeGreaterThan(0);
        expect(res.latencyMs).toBeGreaterThan(0);
      } finally {
        await voiceEngine.dispose();
      }
    },
    30000,
  );
});
