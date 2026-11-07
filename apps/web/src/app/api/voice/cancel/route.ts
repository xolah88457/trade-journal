import { NextResponse } from "next/server";
import { voiceEngine } from "@/server/voice/engine";
import { checkSameOrigin } from "@/server/voice/security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const originCheck = checkSameOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.reason }, { status: originCheck.status });
  }

  let sessionId: string | undefined;
  try {
    const text = await request.text();
    if (text) {
      const body = JSON.parse(text);
      if (typeof body?.sessionId === "string") {
        sessionId = body.sessionId;
      }
    }
  } catch {
    // If body is malformed or empty, proceed with global cancel if applicable
  }

  voiceEngine.cancelJob(sessionId);
  return NextResponse.json({ ok: true });
}
