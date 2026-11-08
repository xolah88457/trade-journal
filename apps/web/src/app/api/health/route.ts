import { NextResponse } from "next/server";

// Cheap readiness probe for the desktop shell. Reveals nothing.
export const dynamic = "force-dynamic";

export const GET = () => NextResponse.json({ ok: true });
