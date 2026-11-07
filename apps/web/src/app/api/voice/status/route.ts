import { NextResponse } from "next/server";
import { voiceEngine } from "@/server/voice/engine";
import { checkSameOrigin } from "@/server/voice/security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const originCheck = checkSameOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.reason }, { status: originCheck.status });
  }

  try {
    const status = await voiceEngine.getStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      {
        ready: false,
        cached: false,
        activeModel: "parakeet-unified-en-0.6b",
        vadReady: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
