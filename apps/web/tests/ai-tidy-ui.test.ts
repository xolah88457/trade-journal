// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const state = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/use-api", () => ({
  postJson: (...args: unknown[]) => state.post(...args),
}));
const { AiTidy } = await import("../src/components/ai-tidy");
const { TooltipProvider } = await import("../src/components/ui/tooltip");

const preview = {
  snapshotFingerprint: "0123456789abcdef",
  system: "s",
  customInstructions: "",
  effectiveSystemPrompt: "s",
  taskPrompt: "Rewrite the note",
  journalContext: "Note:\nso um ES long",
  fullPrompt: "p",
  provider: "compatible",
  providerName: "OpenAI-compatible",
  model: "openrouter/free",
  isLocal: false,
  endpointUrl: "https://openrouter.ai/api/v1",
  networkPrivacy: "Sent to openrouter.ai",
};

let container: HTMLDivElement;
let root: Root;
let current = "";
function Harness({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  current = text;
  return createElement(
    "div",
    null,
    createElement("textarea", {
      "aria-label": "note",
      value: text,
      onChange: (e: { target: HTMLTextAreaElement }) => setText(e.target.value),
    }),
    createElement(AiTidy, { text, onApply: setText, context: "Trade note: ES long" }),
  );
}
const render = (initial: string) =>
  act(async () =>
    root.render(createElement(TooltipProvider, null, createElement(Harness, { initial }))),
  );
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const click = (name: string) =>
  act(async () => {
    const target = button(name);
    if (!target) throw new Error(`No button ${name}`);
    target.click();
  });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.post.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("is disabled until the note has text", async () => {
  await render("   ");
  expect(button("Tidy up")?.disabled).toBe(true);
  expect(state.post).not.toHaveBeenCalled();
});

it("previews, sends, and replaces the note only after confirmation, with undo", async () => {
  state.post.mockImplementation(async (_url: string, body: { preview?: boolean }) =>
    body.preview ? { preview } : { text: "## ES long\n- Held to target." },
  );
  await render("so um ES long");
  await click("Tidy up");
  expect(state.post).toHaveBeenLastCalledWith("/api/ai/tidy", {
    text: "so um ES long",
    format: "markdown",
    context: "Trade note: ES long",
    preview: true,
  });
  expect(document.body.textContent).toContain("Your note");
  expect(current).toBe("so um ES long");

  await click("Tidy with OpenAI-compatible");
  expect(state.post).toHaveBeenLastCalledWith("/api/ai/tidy", {
    text: "so um ES long",
    format: "markdown",
    context: "Trade note: ES long",
    snapshotFingerprint: "0123456789abcdef",
  });
  expect(document.querySelector('[aria-label="Tidied note"]')?.textContent).toBe(
    "## ES long\n- Held to target.",
  );
  // The rewrite is only a suggestion until the trader accepts it.
  expect(current).toBe("so um ES long");

  await click("Replace note");
  expect(current).toBe("## ES long\n- Held to target.");
  await click("Undo tidy");
  expect(current).toBe("so um ES long");
  expect(button("Undo tidy")).toBeUndefined();
});

it("keeps the original when the rewrite is declined", async () => {
  state.post.mockImplementation(async (_url: string, body: { preview?: boolean }) =>
    body.preview ? { preview } : { text: "Cleaner." },
  );
  await render("messy");
  await click("Tidy up");
  await click("Tidy with OpenAI-compatible");
  await click("Keep original");
  expect(current).toBe("messy");
  expect(button("Undo tidy")).toBeUndefined();
});

it("shows a setup notice when AI is not configured", async () => {
  state.post.mockImplementation(async (_url: string, body: { preview?: boolean }) => {
    if (body.preview) return { preview };
    throw new Error("AI is not configured — add your Anthropic API key in Settings.");
  });
  await render("messy");
  await click("Tidy up");
  await click("Tidy with OpenAI-compatible");
  expect(document.body.textContent).toContain("Set up AI to continue");
  expect(current).toBe("messy");
});
