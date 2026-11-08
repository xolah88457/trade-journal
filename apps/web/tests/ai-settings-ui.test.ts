// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { AiConnection, AiProvider, AiSettingsPayload } from "../src/lib/ai-settings";
const state = vi.hoisted(() => ({
  post: vi.fn(),
  refresh: vi.fn(),
  data: undefined as unknown,
}));
vi.mock("@/lib/use-api", () => ({
  postJson: (...args: unknown[]) => state.post(...args),
  useApi: () => ({ data: state.data, error: null, loading: false, refresh: state.refresh }),
}));
const { AiSettings } = await import("../src/components/ai-settings");
let container: HTMLDivElement;
let root: Root;
const connection = (model: string, extra: Partial<AiConnection> = {}): AiConnection => ({
  configured: false,
  source: null,
  model,
  baseUrl: null,
  ...extra,
});
const settings = (
  aiProvider: AiProvider,
  connections: Partial<Record<AiProvider, AiConnection>> = {},
  aiInstructions = "",
): AiSettingsPayload => {
  const aiConnections = {
    anthropic: connection("claude-opus-5"),
    openai: connection("gpt-4.1-mini"),
    compatible: connection(""),
    ...connections,
  };
  return {
    aiProvider,
    aiConfigured: aiConnections[aiProvider].configured,
    aiModel: aiConnections[aiProvider].model,
    aiConnections,
    aiInstructions,
  };
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.post.mockReset().mockResolvedValue({ saved: true });
  state.refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = (data: AiSettingsPayload) => {
  state.data = data;
  return act(async () =>
    root.render(createElement(TooltipProvider, null, createElement(AiSettings))),
  );
};
const field = (id: string) =>
  container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
const type = (id: string, value: string) =>
  act(async () => {
    const input = field(id)!;
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const saveButton = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === "Save AI settings",
  )!;

it("saves an OpenAI-compatible server with a model and no key", async () => {
  await render(settings("compatible"));
  expect(container.textContent).toContain("API key (optional)");
  expect(saveButton().disabled).toBe(true);
  await type("ai-model", "llama3.1:8b");
  expect(saveButton().disabled).toBe(true);
  await type("ai-base-url", " http://localhost:11434/v1 ");
  expect(saveButton().disabled).toBe(false);
  await act(async () => saveButton().click());
  expect(state.post).toHaveBeenCalledWith(
    "/api/settings",
    {
      aiProvider: "compatible",
      aiModel: "llama3.1:8b",
      compatibleBaseUrl: "http://localhost:11434/v1",
      aiInstructions: "",
    },
    "PATCH",
  );
  expect(state.refresh).toHaveBeenCalled();
});

it("shows the saved server and warns that a new URL drops its saved key", async () => {
  await render(
    settings("compatible", {
      compatible: connection("router-model", {
        configured: true,
        source: "saved",
        baseUrl: "https://router.example/api/v1",
      }),
    }),
  );
  expect(field("ai-base-url")!.value).toBe("https://router.example/api/v1");
  expect(container.textContent).toContain("Saving a different server URL removes it.");
  expect(container.textContent).toContain("Remove OpenAI-compatible key");
  expect(container.textContent).toContain("Server configured");
});

it("keeps hosted providers free of a server URL", async () => {
  await render(
    settings("openai", {
      openai: connection("gpt-4.1-mini", { configured: true, source: "saved" }),
      compatible: connection("llama3.1:8b", { baseUrl: "http://localhost:11434/v1" }),
    }),
  );
  expect(field("ai-base-url")).toBeNull();
  await act(async () => saveButton().click());
  expect(state.post.mock.calls[0]![1]).toEqual({
    aiProvider: "openai",
    aiModel: "gpt-4.1-mini",
    aiInstructions: "",
  });
});

it("loads, edits and saves personal trading instructions", async () => {
  await render(
    settings(
      "openai",
      { openai: connection("gpt-4.1-mini", { configured: true, source: "saved" }) },
      "Risk max 1% per setup",
    ),
  );
  expect(field("ai-instructions")!.value).toBe("Risk max 1% per setup");
  expect(container.textContent).toContain("21/2000");
  await type("ai-instructions", "Focus on patience and discipline");
  expect(container.textContent).toContain("32/2000");
  await act(async () => saveButton().click());
  expect(state.post).toHaveBeenCalledWith(
    "/api/settings",
    {
      aiProvider: "openai",
      aiModel: "gpt-4.1-mini",
      aiInstructions: "Focus on patience and discipline",
    },
    "PATCH",
  );
});

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

it("shows free OpenRouter and Groq options with links to their key pages", async () => {
  await render(settings("anthropic"));
  expect(container.textContent).toContain("Start free: no API fees");
  const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).map((a) => a.href);
  expect(links).toContain("https://openrouter.ai/keys");
  expect(links).toContain("https://console.groq.com/keys");
});

it.each([
  ["OpenRouter", "https://openrouter.ai/api/v1", "openrouter/free"],
  ["Groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b"],
])("fills in %s and saves it with the pasted key", async (name, baseUrl, model) => {
  await render(settings("anthropic"));
  await act(async () => button(`Use ${name} settings`).click());
  expect(field("ai-base-url")!.value).toBe(baseUrl);
  expect(field("ai-model")!.value).toBe(model);
  expect(container.textContent).toContain(`Paste your ${name} API key into the key field`);
  expect(container.textContent).toContain(`${name} API key`);
  expect(container.textContent).not.toContain("API key (optional)");
  await type("ai-api-key", "free-key");
  await act(async () => saveButton().click());
  expect(state.post).toHaveBeenCalledWith(
    "/api/settings",
    {
      aiProvider: "compatible",
      aiModel: model,
      compatibleBaseUrl: baseUrl,
      compatibleKey: "free-key",
      aiInstructions: "",
    },
    "PATCH",
  );
});
