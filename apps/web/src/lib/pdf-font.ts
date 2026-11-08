const FONT_URL = "/fonts/NotoSans-Regular.ttf";

let cachedFontBytes: Uint8Array | null = null;

/**
 * Fetches the bundled Noto Sans font once and shares the bytes between PDF exporters.
 * Browser fetch only — no dynamic Node fs/path in client-importable code.
 */
export async function loadFontBytes(
  failureMessage: (res: Response) => string = () => "Could not load the PDF font.",
): Promise<Uint8Array> {
  if (cachedFontBytes) return cachedFontBytes;
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error(failureMessage(res));
  cachedFontBytes = new Uint8Array(await res.arrayBuffer());
  return cachedFontBytes;
}
