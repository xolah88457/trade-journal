import { NextResponse } from "next/server";
import { AUDIO_CONFIG } from "@/server/voice/constants";
import { EngineBusyError, voiceEngine } from "@/server/voice/engine";
import { checkSameOrigin } from "@/server/voice/security";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  // 1. Same-origin and auth guard
  const originCheck = checkSameOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.reason }, { status: originCheck.status });
  }

  // 2. MIME type validation (strict base content-type comparison)
  const rawContentType = request.headers.get("content-type") || "";
  const baseMime = rawContentType.split(";")[0]?.trim().toLowerCase();
  if (baseMime !== "application/octet-stream") {
    return NextResponse.json(
      { error: "Content-Type must be application/octet-stream" },
      { status: 415 },
    );
  }

  // 3. Header UUID validation (validate format BEFORE body reading/allocations)
  const sessionId = request.headers.get("x-transcribe-session-id");
  if (!sessionId || !UUID_PATTERN.test(sessionId)) {
    return NextResponse.json(
      { error: "Missing or invalid UUID format for header x-transcribe-session-id" },
      { status: 400 },
    );
  }

  // 4. Early Content-Length boundary check
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(declaredLength) && declaredLength > AUDIO_CONFIG.maxBytes) {
      return NextResponse.json(
        {
          error: `Audio exceeds maximum allowed duration of 5 minutes (${declaredLength} bytes > ${AUDIO_CONFIG.maxBytes} max).`,
        },
        { status: 413 },
      );
    }
  }

  // 5. Bounded streaming body read with immediate reader cancellation on overflow
  if (!request.body) {
    return NextResponse.json({ text: "", speechDurationMs: 0, latencyMs: 0 });
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > AUDIO_CONFIG.maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          return NextResponse.json(
            {
              error: `Audio exceeds maximum allowed duration of 5 minutes (> ${AUDIO_CONFIG.maxBytes} bytes).`,
            },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read audio stream: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  if (totalBytes === 0) {
    return NextResponse.json({ text: "", speechDurationMs: 0, latencyMs: 0 });
  }

  if (totalBytes % 4 !== 0) {
    return NextResponse.json(
      { error: "Audio buffer length must be a multiple of 4 bytes (Float32Array)." },
      { status: 400 },
    );
  }

  // Allocate bounded memory once and copy chunks
  const mergedBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    mergedBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const pcm = new Float32Array(mergedBytes.buffer, mergedBytes.byteOffset, totalBytes / 4);

  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]!;
    if (!Number.isFinite(s)) {
      return NextResponse.json(
        { error: "Audio buffer contains invalid non-finite float samples (NaN or Infinity)." },
        { status: 400 },
      );
    }
  }

  // 6. Transcription execution
  try {
    const result = await voiceEngine.transcribe(sessionId, pcm, request.signal);
    return NextResponse.json({
      text: result.text,
      speechDurationMs: result.speechDurationMs,
      latencyMs: result.latencyMs,
      ...(result.warning ? { warning: result.warning } : {}),
    });
  } catch (err) {
    if (err instanceof EngineBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      {
        error: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}
