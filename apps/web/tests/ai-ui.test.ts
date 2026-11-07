// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { computeMetrics, type AnalysisFilters } from "@luxalgo/journal-core";
import { TooltipProvider } from "../src/components/ui/tooltip";

const state = vi.hoisted(() => ({
  filters: { accounts: "a" } as AnalysisFilters,
  timeZone: "UTC",
  save: vi.fn(),
  post: vi.fn(),
  critiqueApiData: null as unknown,
}));
vi.mock("@/components/filter-bar", () => ({
  FilterBar: () => null,
  useFilters: () => ({
    values: state.filters,
    query: new URLSearchParams(state.filters).toString(),
    timeZone: state.timeZone,
  }),
}));
vi.mock("@/lib/use-api", () => ({
  postJson: (...args: unknown[]) => state.post(...args),
  useApi: (url: string | null) => {
    if (url && typeof url === "string" && url.startsWith("/api/ai/critique")) {
      return {
        data: state.critiqueApiData,
        error: null,
        loading: false,
        refresh: vi.fn(),
      };
    }
    return {
      data: {
        metrics: { ...computeMetrics([]), closedTrades: 1 },
        trades: [],
        intraday: [],
        note: "Original note",
      },
    };
  },
}));
vi.mock("@/lib/use-autosave", () => ({
  useAutosave: () => ({ save: state.save, status: "Saved", flush: vi.fn() }),
}));
vi.mock("@/components/rich-editor", () => ({
  RichEditor: ({ value, onChange }: { value: string; onChange: (s: string) => void }) =>
    createElement("textarea", {
      value,
      onChange: () => {},
      onInput: (e: { currentTarget: HTMLTextAreaElement }) => onChange(e.currentTarget.value),
    }),
}));
vi.mock("@/components/charts/equity-area", () => ({ EquityArea: () => null }));
vi.mock("@/components/pnl", () => ({ Pnl: () => null }));
vi.mock("@/components/privacy", () => ({ MonetaryValue: () => null }));
vi.mock("@/components/voice-note", () => ({ VoiceNote: () => null }));
vi.mock("@/components/attachments", () => ({ Attachments: () => null }));
vi.mock("@/components/review-export", () => ({ ReviewExport: () => null }));
vi.mock("@/components/daily-report-export", () => ({ DailyReportExport: () => null }));
const { AskJournal } = await import("../src/components/ask-journal");
const { TradeCritiqueSection } = await import("../src/components/ai-critique");
const { default: JournalDayPage } = await import("../src/app/journal/[date]/page");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.filters = { accounts: "a" };
  state.timeZone = "UTC";
  state.critiqueApiData = null;
  state.post.mockReset();
  state.save.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const deferred = () => {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const renderAsk = () =>
  act(async () => root.render(createElement(TooltipProvider, null, createElement(AskJournal))));
const click = (text: string) =>
  act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    expect(button, text).toBeTruthy();
    button!.click();
  });
const suggestion = "What's my most expensive mistake?";
const reply = (answer: string) => ({
  answer,
  scope: { label: "Account A · UTC", timeZone: "UTC" },
});
const previewReply = {
  preview: {
    snapshotFingerprint: "0123456789abcdef",
    system: "You are the reflection layer...",
    customInstructions: "",
    effectiveSystemPrompt: "You are the reflection layer...",
    taskPrompt: "Task prompt",
    journalContext: "Journal context",
    fullPrompt: "Full prompt",
    provider: "anthropic" as const,
    providerName: "Anthropic",
    model: "claude-opus-5",
    isLocal: false,
    endpointUrl: null,
    networkPrivacy: "Remote cloud: Requests are sent directly to Anthropic.",
    scopeLabel: "Account A · UTC",
  },
  scope: { label: "Account A · UTC", timeZone: "UTC" },
};

it("sends the full current filter snapshot and displays the server-confirmed scope", async () => {
  state.filters = {
    accounts: "a,b",
    from: "2026-09-01",
    to: "2026-09-15",
    symbol: "AAPL",
    reviewed: "yes",
  };
  state.post.mockResolvedValueOnce(previewReply).mockResolvedValueOnce(reply("Scoped answer"));
  await renderAsk();
  await click(suggestion);
  expect(state.post).toHaveBeenCalledWith("/api/ai/ask", {
    question: suggestion,
    filters: state.filters,
    timeZone: "UTC",
    preview: true,
  });
  expect(document.body.textContent).toContain("Provider: Anthropic");
  expect(document.body.textContent).toContain(
    "Remote cloud: Requests are sent directly to Anthropic.",
  );
  await click("Send to Anthropic");
  expect(state.post).toHaveBeenCalledWith("/api/ai/ask", {
    question: suggestion,
    filters: state.filters,
    timeZone: "UTC",
    snapshotFingerprint: "0123456789abcdef",
  });
  expect(container.textContent).toContain("Scoped answer");
  expect(container.textContent).toContain("Account A · UTC");
  state.filters = {};
  await renderAsk();
  expect(container.textContent).not.toContain("Scoped answer");
});

it("cancels preview confirm dialog without sending request", async () => {
  state.post.mockResolvedValueOnce(previewReply);
  await renderAsk();
  await click(suggestion);
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Ask Journal Preview");
  await click("Cancel");
  expect(document.body.textContent).not.toContain("Ask Journal Preview");
  expect(state.post).toHaveBeenCalledTimes(1);
});

it.each(["accounts", "symbol", "timezone"])(
  "discards late answers after changing %s, including returning to A",
  async (change) => {
    const old = deferred(),
      current = deferred();
    state.post
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(previewReply)
      .mockReturnValueOnce(current.promise);
    await renderAsk();
    await click(suggestion);
    if (change === "accounts") state.filters = { accounts: "b" };
    else if (change === "symbol") state.filters = { accounts: "a", symbol: "MSFT" };
    else state.timeZone = "America/New_York";
    await renderAsk();
    state.filters = { accounts: "a" };
    state.timeZone = "UTC";
    await renderAsk();
    await click(suggestion);
    await act(async () => old.resolve(previewReply));
    expect(container.textContent).not.toContain("OLD RESULT");
    await click("Send to Anthropic");
    expect(container.textContent).toContain("Thinking");
    await act(async () => current.resolve(reply("CURRENT RESULT")));
    expect(container.textContent).toContain("CURRENT RESULT");
  },
);

it("ignores old errors and allows retry after a current failure", async () => {
  const old = deferred();
  state.post
    .mockReturnValueOnce(old.promise)
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValueOnce(previewReply)
    .mockResolvedValueOnce(reply("Retry answer"));
  await renderAsk();
  await click(suggestion);
  state.filters = { accounts: "b" };
  await renderAsk();
  await act(async () => old.reject(new Error("OLD ERROR")));
  expect(container.querySelector("[data-ai-notice]")).toBeNull();
  await click(suggestion);
  expect(container.textContent).toContain("Couldn’t complete the AI request");
  await click("Try again");
  await click("Send to Anthropic");
  expect(container.textContent).toContain("Retry answer");
});

it("prevents duplicate submissions before a rerender", async () => {
  state.post.mockReturnValue(deferred().promise);
  await renderAsk();
  await act(async () => {
    const buttons = container.querySelectorAll("button");
    buttons[1]!.click();
    buttons[2]!.click();
  });
  expect(state.post).toHaveBeenCalledTimes(1);
});

const dateParams = Promise.resolve({ date: "2026-09-15" });
const renderDay = (params = dateParams) =>
  act(async () => root.render(createElement(JournalDayPage, { params })));
const recapReply = {
  recap: "Generated recap",
  scope: { label: "2026-09-15 · Account A · UTC", timeZone: "UTC" },
};

it("appends a labeled recap to edits made while generation is pending", async () => {
  const pending = deferred();
  state.post.mockResolvedValueOnce(previewReply).mockReturnValueOnce(pending.promise);
  await renderDay();
  await click("AI recap");
  expect(state.post).toHaveBeenCalledWith("/api/ai/recap", {
    date: "2026-09-15",
    filters: { accounts: "a" },
    timeZone: "UTC",
    preview: true,
  });
  await click("Send to Anthropic");
  expect(state.post).toHaveBeenCalledWith("/api/ai/recap", {
    date: "2026-09-15",
    filters: { accounts: "a" },
    timeZone: "UTC",
    snapshotFingerprint: "0123456789abcdef",
  });
  await act(async () => {
    const editor = container.querySelector("textarea")!;
    editor.value = "My newest edit";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => pending.resolve(recapReply));
  const saved = state.save.mock.calls.at(-1)![0].note;
  expect(saved).toContain("My newest edit");
  expect(saved).not.toContain("Original note");
  expect(saved).toContain("Account A");
  expect(saved).toContain("Generated recap");
});

it.each(["account", "date", "unmount"])(
  "does not append a delayed recap after %s changes",
  async (change) => {
    const pending = deferred();
    state.post.mockResolvedValueOnce(previewReply).mockReturnValueOnce(pending.promise);
    await renderDay();
    await click("AI recap");
    await click("Send to Anthropic");
    if (change === "account") {
      state.filters = { accounts: "b" };
      await renderDay();
      state.filters = { accounts: "a" };
      await renderDay();
    } else if (change === "date") await renderDay(Promise.resolve({ date: "2026-09-16" }));
    else await act(async () => root.render(null));
    await act(async () => pending.resolve(recapReply));
    expect(state.save).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Generated recap");
  },
);

it("displays drift error and Refresh preview button inside TradeCritiqueSection modal on failure", async () => {
  const driftMessage =
    "Journal context, personal instructions, or AI settings changed since preview was generated. Please review the updated preview before sending.";

  state.post
    .mockResolvedValueOnce(previewReply)
    .mockRejectedValueOnce(new Error(driftMessage))
    .mockResolvedValueOnce(previewReply);

  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeCritiqueSection, { tradeKey: "trade_test_key" }),
      ),
    ),
  );

  await click("Critique this trade");
  expect(state.post).toHaveBeenCalledWith("/api/ai/critique", {
    key: "trade_test_key",
    preview: true,
  });
  expect(document.body.textContent).toContain("Trade Critique Preview");

  await click("Send to Anthropic");
  expect(state.post).toHaveBeenCalledWith("/api/ai/critique", {
    key: "trade_test_key",
    snapshotFingerprint: previewReply.preview.snapshotFingerprint,
  });

  expect(document.body.textContent).toContain("Trade Critique Preview");
  expect(document.body.textContent).toContain(driftMessage);
  expect(document.body.textContent).toContain("Refresh preview snapshot");

  await click("Refresh preview snapshot");
  expect(state.post).toHaveBeenCalledTimes(3);
  expect(document.body.textContent).toContain("Trade Critique Preview");
});

it("hydrates and renders latest critique and earlier collapsible critiques with metadata in TradeCritiqueSection", async () => {
  state.critiqueApiData = {
    reviews: [
      {
        id: "rev_old",
        createdAt: "2026-11-05T10:00:00.000Z",
        content: "Older critique content: Entry was premature.",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      },
      {
        id: "rev_new",
        createdAt: "2026-11-06T15:00:00.000Z",
        content: "Latest critique content: Followed trading plan cleanly.",
        provider: "openai",
        model: "gpt-4.1-mini",
      },
    ],
  };

  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeCritiqueSection, { tradeKey: "trade_test_key" }),
      ),
    ),
  );

  // Latest review is shown directly
  expect(container.textContent).toContain(
    "Latest critique content: Followed trading plan cleanly.",
  );
  expect(container.textContent).toContain("openai");
  expect(container.textContent).toContain("gpt-4.1-mini");
  expect(container.textContent).toContain("Latest");

  // Earlier review is collapsed with accessible attributes
  const toggleBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("earlier reviews"),
  );
  expect(toggleBtn).toBeDefined();
  expect(toggleBtn?.getAttribute("aria-expanded")).toBe("false");
  const controlledId = toggleBtn?.getAttribute("aria-controls");
  expect(controlledId).toBeTruthy();

  expect(container.textContent).toContain("Show earlier reviews (1)");
  expect(container.textContent).not.toContain("Older critique content: Entry was premature.");

  // Expand earlier reviews
  await click("Show earlier reviews (1)");
  expect(toggleBtn?.getAttribute("aria-expanded")).toBe("true");
  const expandedSection = container.querySelector(`#${controlledId}`);
  expect(expandedSection).toBeDefined();
  expect(container.textContent).toContain("Older critique content: Entry was premature.");
  expect(container.textContent).toContain("anthropic");
  expect(container.textContent).toContain("claude-3-5-sonnet");
  expect(container.textContent).toContain("Hide earlier reviews (1)");

  // Collapse earlier reviews
  await click("Hide earlier reviews (1)");
  expect(toggleBtn?.getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain("Older critique content: Entry was premature.");
});

it("preserves newly generated review when an older deferred GET resolves after POST (no vanishing review regression)", async () => {
  // Scenario: Initially GET returned only 1 review
  state.critiqueApiData = {
    reviews: [
      {
        id: "rev_1",
        createdAt: "2026-11-06T10:00:00.000Z",
        content: "First review: Initial analysis.",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      },
    ],
  };

  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeCritiqueSection, { tradeKey: "trade_test_key" }),
      ),
    ),
  );

  expect(container.textContent).toContain("First review: Initial analysis.");

  // User generates a second review via POST confirm
  state.post.mockResolvedValueOnce(previewReply).mockResolvedValueOnce({
    critique: "Second review: Newly generated analysis.",
    review: {
      id: "rev_2",
      createdAt: "2026-11-06T11:00:00.000Z",
      content: "Second review: Newly generated analysis.",
      provider: "openai",
      model: "gpt-4.1-mini",
    },
    reviews: [
      {
        id: "rev_1",
        createdAt: "2026-11-06T10:00:00.000Z",
        content: "First review: Initial analysis.",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      },
      {
        id: "rev_2",
        createdAt: "2026-11-06T11:00:00.000Z",
        content: "Second review: Newly generated analysis.",
        provider: "openai",
        model: "gpt-4.1-mini",
      },
    ],
  });

  await click("Critique this trade");
  await click("Send to Anthropic");

  // Newly generated review is now visible as latest
  expect(container.textContent).toContain("Second review: Newly generated analysis.");
  expect(container.textContent).toContain("Show earlier reviews (1)");

  // Now simulate an older deferred GET response arriving with ONLY the older review rev_1
  // (e.g. from an in-flight network read started earlier)
  await act(async () => {
    state.critiqueApiData = {
      reviews: [
        {
          id: "rev_1",
          createdAt: "2026-11-06T10:00:00.000Z",
          content: "First review: Initial analysis.",
          provider: "anthropic",
          model: "claude-3-5-sonnet",
        },
      ],
    };
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeCritiqueSection, { tradeKey: "trade_test_key" }),
      ),
    );
  });

  // The newly generated review MUST NOT vanish! Append-only merge keeps both!
  expect(container.textContent).toContain("Second review: Newly generated analysis.");
  expect(container.textContent).toContain("Show earlier reviews (1)");
});

it("ignores in-flight async responses when tradeKey changes (cross-trade isolation)", async () => {
  let resolvePost: (value: unknown) => void = () => {};
  const pendingPost = new Promise((resolve) => {
    resolvePost = resolve;
  });
  state.post.mockReturnValue(pendingPost);

  // Render for trade_1
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeCritiqueSection, { tradeKey: "trade_1" }),
      ),
    ),
  );

  // Trigger preview for trade_1
  await click("Critique this trade");
  expect(state.post).toHaveBeenCalledWith("/api/ai/critique", {
    key: "trade_1",
    preview: true,
  });

  // Switch tradeKey to trade_2 before trade_1 resolves
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeCritiqueSection, { tradeKey: "trade_2" }),
      ),
    ),
  );

  // Now resolve the in-flight post for trade_1
  await act(async () => {
    resolvePost({
      preview: {
        ...previewReply.preview,
        journalContext: "TRADE 1 CONTEXT THAT MUST NOT LEAK",
      },
    });
  });

  // Trade 2 must NOT show trade 1's preview dialog or context
  expect(document.body.textContent).not.toContain("TRADE 1 CONTEXT THAT MUST NOT LEAK");
});
