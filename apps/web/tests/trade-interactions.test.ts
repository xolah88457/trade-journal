// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TradeRating } from "../src/components/trade-rating";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const filled = () => container.querySelectorAll('[data-filled="true"]').length;

it("previews all stars up to the hovered or focused rating without saving", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(createElement(TradeRating, { value: 2, onChange: save })));
  await act(async () =>
    button("Rate 4 stars").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  expect(filled()).toBe(4);
  expect(save).not.toHaveBeenCalled();
  await act(async () =>
    button("Rate 4 stars").dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    ),
  );
  expect(filled()).toBe(2);
  await act(async () => button("Rate 5 stars").focus());
  expect(filled()).toBe(5);
  await act(async () => button("Rate 5 stars").blur());
  expect(filled()).toBe(2);
});

it("animates the selection immediately and restores the saved value if saving fails", async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn(
    () =>
      new Promise<void>((_, no) => {
        reject = no;
      }),
  );
  await act(async () => root.render(createElement(TradeRating, { value: 2, onChange: save })));
  await act(async () => button("Rate 4 stars").click());
  expect(save).toHaveBeenCalledWith(4);
  expect(filled()).toBe(4);
  expect(container.querySelectorAll(".journal-rating-selected")).toHaveLength(4);
  await act(async () => reject(new Error("offline")));
  expect(filled()).toBe(2);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("not saved");
});

it("saves a rating and allows selecting it again to clear it", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(createElement(TradeRating, { value: null, onChange: save })));
  await act(async () => button("Rate 3 stars").click());
  expect(button("Rate 3 stars").getAttribute("aria-pressed")).toBe("true");
  await act(async () => button("Rate 3 stars").click());
  expect(save.mock.calls.map(([value]) => value)).toEqual([3, null]);
  expect(filled()).toBe(0);
});
