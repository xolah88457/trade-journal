import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-ai-tidy-"));
process.env.JOURNAL_DATA_DIR = scratch;

const { db, settings } = await import("../src/db");
const { setAiInstructions, setSetting, setAiKey } = await import("../src/server/settings");
const { generateText } = await import("ai");
const { TIDY_SYSTEM, buildTidyPromptContext, cleanTidyOutput } =
  await import("../src/server/ai-prompt");
const { POST } = await import("../src/app/api/ai/tidy/route");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/ai/tidy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const modelText = (text: string) =>
  vi
    .mocked(generateText)
    .mockResolvedValue({ text, finishReason: "stop" } as Awaited<ReturnType<typeof generateText>>);

const dictated =
  "so um today I took ES long at 5000 uh it went my way and I I held it to target 5010 but I was nervous the whole time";

beforeEach(() => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  db.delete(settings).run();
  vi.mocked(generateText).mockReset();
});
afterAll(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("buildTidyPromptContext", () => {
  it("puts the note and its location in the prompt and uses the writing system prompt", () => {
    setAiInstructions("Always be harsh about overtrading.");
    const { fullPrompt, effectiveSystemPrompt, preview } = buildTidyPromptContext({
      text: dictated,
      context: "Trade note:\n ES   long",
      preview: true,
    });
    expect(effectiveSystemPrompt).toBe(TIDY_SYSTEM);
    expect(preview.system).toBe(TIDY_SYSTEM);
    // Coaching instructions would change the trader's words, so the rewrite leaves them out.
    expect(preview.customInstructions).toBe("");
    expect(fullPrompt).not.toContain("overtrading");
    expect(fullPrompt).toContain("Where this note is: Trade note: ES long");
    expect(fullPrompt).toContain(`<<<NOTE\n${dictated}\nNOTE>>>`);
    expect(fullPrompt).toContain('"##" headings');
    expect(preview.snapshotFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it("asks for the requested shape of text", () => {
    expect(buildTidyPromptContext({ text: "a", format: "lines" }).fullPrompt).toContain(
      "each item on its own line",
    );
    expect(buildTidyPromptContext({ text: "a", format: "plain" }).fullPrompt).toContain(
      "without Markdown",
    );
  });

  it("rejects empty, oversized and malformed requests", () => {
    expect(() => buildTidyPromptContext({ text: "  \n " })).toThrow(/Write or dictate/);
    expect(() => buildTidyPromptContext({ text: "x".repeat(20_001) })).toThrow(/20,000/);
    expect(() => buildTidyPromptContext({})).toThrow(/text is required/);
    expect(() => buildTidyPromptContext({ text: "a", format: "html" })).toThrow(/format/);
    expect(() => buildTidyPromptContext({ text: "a", context: "x".repeat(201) })).toThrow(
      /context/,
    );
    expect(() => buildTidyPromptContext({ text: "a", extra: 1 } as never)).toThrow(/Unknown/);
    expect(() => buildTidyPromptContext({ text: "a", snapshotFingerprint: "nope" })).toThrow(
      /snapshotFingerprint/,
    );
  });

  it("stops the send when the note changed since the preview", () => {
    const { preview } = buildTidyPromptContext({ text: "first", preview: true });
    expect(() =>
      buildTidyPromptContext({ text: "first", snapshotFingerprint: preview.snapshotFingerprint }),
    ).not.toThrow();
    expect(() =>
      buildTidyPromptContext({ text: "second", snapshotFingerprint: preview.snapshotFingerprint }),
    ).toThrow(/changed since preview/);
  });
});

describe("cleanTidyOutput", () => {
  it("removes code fences and note delimiters the model echoes", () => {
    expect(cleanTidyOutput("```markdown\n## Plan\n- Wait\n```")).toBe("## Plan\n- Wait");
    expect(cleanTidyOutput("<<<NOTE\nHeld to target.\nNOTE>>>\n")).toBe("Held to target.");
    expect(cleanTidyOutput("  Plain text.\r\n")).toBe("Plain text.");
  });
});

describe("POST /api/ai/tidy", () => {
  it("returns a preview without calling the model", async () => {
    const res = await post({ text: dictated, preview: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preview: { journalContext: string } };
    expect(body.preview.journalContext).toContain(dictated);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("sends the note with the writing prompt and returns the cleaned rewrite", async () => {
    setSetting("aiProvider", "anthropic");
    setAiKey("anthropic", "test-only-key");
    modelText("```\n## ES long\n- Entered at 5000 and held to the 5010 target.\n```");
    const { preview } = buildTidyPromptContext({ text: dictated, preview: true });
    const res = await post({ text: dictated, snapshotFingerprint: preview.snapshotFingerprint });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "## ES long\n- Entered at 5000 and held to the 5010 target.",
    });
    const options = vi.mocked(generateText).mock.calls[0]![0];
    expect(options.system).toBe(TIDY_SYSTEM);
    expect(options.prompt).toContain(dictated);
    expect(options.maxOutputTokens).toBeGreaterThanOrEqual(1500);
  });

  it("explains how to set up AI when no provider is configured", async () => {
    const res = await post({ text: dictated });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/AI is not configured/);
    expect(generateText).not.toHaveBeenCalled();
  });
});
