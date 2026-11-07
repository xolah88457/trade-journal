import { NextResponse } from "next/server";
import { voiceEngine } from "@/server/voice/engine";
import { checkSameOrigin } from "@/server/voice/security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const originCheck = checkSameOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.reason }, { status: originCheck.status });
  }

  try {
    const res = await voiceEngine.setup();
    return NextResponse.json({
      ok: true,
      device: res.device,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
