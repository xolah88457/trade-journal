// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Attachments } from "../src/components/attachments";
import { TooltipProvider } from "../src/components/ui/tooltip";

let container: HTMLDivElement;
let root: Root;

const mockAttachments = [
  { id: "img-1", name: "entry-setup.png", mime: "image/png", size: 102400 },
  { id: "img-2", name: "exit-target.jpeg", mime: "image/jpeg", size: 204800 },
  { id: "img-3", name: "daily-context.webp", mime: "image/webp", size: 153600 },
  { id: "doc-1", name: "trade-plan.pdf", mime: "application/pdf", size: 51200 },
];

let apiData: { attachments: typeof mockAttachments } | null = {
  attachments: [...mockAttachments],
};

vi.mock("@/lib/use-api", () => ({
  useApi: vi.fn(() => ({
    data: apiData,
    error: null,
    refresh: vi.fn(),
  })),
  postJson: vi.fn().mockResolvedValue({}),
}));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  apiData = { attachments: [...mockAttachments] };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const renderGallery = async () => {
  await act(async () => {
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(Attachments, { type: "trade", id: "trade-123", variant: "trade-gallery" }),
      ),
    );
  });
};

it("renders the screenshot gallery with image counter, active preview, and document list", async () => {
  await renderGallery();

  // Header counter: 3 image attachments
  expect(container.textContent).toContain("Screenshots");
  expect(container.textContent).toContain("1 / 3");

  // First image is active
  const activeImg = container.querySelector('img[alt="entry-setup.png"]');
  expect(activeImg).toBeTruthy();
  expect(activeImg?.getAttribute("src")).toBe("/api/attachments/img-1");

  // Non-image PDF document is rendered in documents section
  expect(container.textContent).toContain("Attached Documents & PDFs");
  expect(container.textContent).toContain("trade-plan.pdf");
});

it("navigates forward and backward with arrow buttons and clamps at boundaries", async () => {
  await renderGallery();

  const prevBtn = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Previous screenshot"]',
  )!;
  const nextBtn = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Next screenshot"]',
  )!;

  // Initially at index 0: prev is disabled, next is enabled
  expect(prevBtn.disabled).toBe(true);
  expect(nextBtn.disabled).toBe(false);
  expect(container.textContent).toContain("1 / 3");

  // Click next -> index 1
  await act(async () => nextBtn.click());
  expect(container.textContent).toContain("2 / 3");
  expect(container.querySelector('img[alt="exit-target.jpeg"]')).toBeTruthy();
  expect(prevBtn.disabled).toBe(false);
  expect(nextBtn.disabled).toBe(false);

  // Click next -> index 2 (last)
  await act(async () => nextBtn.click());
  expect(container.textContent).toContain("3 / 3");
  expect(container.querySelector('img[alt="daily-context.webp"]')).toBeTruthy();
  expect(prevBtn.disabled).toBe(false);
  expect(nextBtn.disabled).toBe(true);

  // Click prev -> back to index 1
  await act(async () => prevBtn.click());
  expect(container.textContent).toContain("2 / 3");
  expect(container.querySelector('img[alt="exit-target.jpeg"]')).toBeTruthy();
});

it("supports keyboard arrow navigation scoped to the gallery container", async () => {
  await renderGallery();

  const galleryRegion = container.querySelector<HTMLDivElement>(
    'div[aria-label="Trade screenshots gallery"]',
  )!;
  expect(galleryRegion).toBeTruthy();

  // Press ArrowRight
  await act(async () => {
    galleryRegion.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
  });
  expect(container.textContent).toContain("2 / 3");
  expect(container.querySelector('img[alt="exit-target.jpeg"]')).toBeTruthy();

  // Press ArrowRight again to reach last
  await act(async () => {
    galleryRegion.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
  });
  expect(container.textContent).toContain("3 / 3");

  // Press ArrowLeft to go back
  await act(async () => {
    galleryRegion.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
    );
  });
  expect(container.textContent).toContain("2 / 3");
});

it("renders empty state when trade has no screenshots", async () => {
  apiData = { attachments: [] };
  await renderGallery();

  expect(container.textContent).toContain("No screenshots for this trade yet");
  expect(container.querySelector('button[aria-label="Previous screenshot"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Next screenshot"]')).toBeNull();
});

it("calls delete endpoint with confirmation", async () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const { postJson } = await import("@/lib/use-api");

  await renderGallery();

  const deleteBtn = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove entry-setup.png"]',
  )!;
  expect(deleteBtn).toBeTruthy();

  await act(async () => deleteBtn.click());
  expect(confirmSpy).toHaveBeenCalledWith("Remove entry-setup.png?");
  expect(postJson).toHaveBeenCalledWith("/api/attachments/img-1", undefined, "DELETE");

  confirmSpy.mockRestore();
});

it("clamps safe index and closes lightbox when attachments shrink to empty", async () => {
  await renderGallery();

  // Open lightbox
  const viewFullBtn = container.querySelector<HTMLButtonElement>(
    'button[aria-label="View full size"]',
  )!;
  await act(async () => viewFullBtn.click());
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();

  // Simulate deleting all images (refetch returns only non-image document)
  const docAttachment = mockAttachments[3]!;
  apiData = { attachments: [docAttachment] };
  await renderGallery();

  expect(container.textContent).toContain("No screenshots for this trade yet");
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  // Simulate subsequent upload of a new image: lightbox does not reopen unexpectedly
  apiData = {
    attachments: [
      { id: "img-new", name: "new-upload.png", mime: "image/png", size: 102400 },
      docAttachment,
    ],
  };
  await renderGallery();

  expect(container.textContent).toContain("1 / 1");
  expect(container.querySelector('img[alt="new-upload.png"]')).toBeTruthy();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("displays partial error message banner when batch upload partially fails", async () => {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const body = init?.body as FormData;
    const file = body?.get("file") as File;
    if (file?.name === "fail.png") {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({ error: "fail.png: invalid format" }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ id: "ok-id" }),
    });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    await renderGallery();

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Upload attachment"]',
    )!;
    const file1 = new File(["ok"], "ok.png", { type: "image/png" });
    const file2 = new File(["bad"], "fail.png", { type: "image/png" });

    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [file1, file2],
        writable: true,
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const alertBanner = container.querySelector('[role="alert"]');
    expect(alertBanner).toBeTruthy();
    expect(alertBanner?.textContent).toContain(
      "Uploaded 1 file(s), but failed: fail.png: invalid format",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const renderList = async () => {
  await act(async () => {
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(Attachments, { type: "day", id: "2026-11-09" }),
      ),
    );
  });
};
const rightClick = (target: Element) =>
  act(async () => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
  });

it("opens journal screenshots in the in-app viewer, which closes with its Close button", async () => {
  await renderList();
  // No link that would replace the whole window with the raw image.
  expect(container.querySelector('a[target="_blank"]')).toBeNull();

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="View exit-target.jpeg"]')!
      .click(),
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("exit-target.jpeg");
  expect(dialog.textContent).toContain("2 / 3");
  const download = dialog.querySelector<HTMLAnchorElement>("a[download]")!;
  expect(download.getAttribute("href")).toBe("/api/attachments/img-2");
  expect(download.getAttribute("download")).toBe("exit-target.jpeg");

  const close = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Close")!;
  await act(async () => close.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("offers a download link for every attachment", async () => {
  await renderList();
  const links = [...container.querySelectorAll<HTMLAnchorElement>("a[download]")].map((a) => [
    a.getAttribute("href"),
    a.getAttribute("download"),
  ]);
  for (const a of mockAttachments) {
    expect(links).toContainEqual([`/api/attachments/${a.id}`, a.name]);
  }
});

it("downloads or opens a screenshot from its right-click menu", async () => {
  await renderList();
  const thumb = container.querySelector('button[aria-label="View entry-setup.png"]')!;
  await rightClick(thumb);
  const menu = container.querySelector('[role="menu"]')!;
  expect(menu).toBeTruthy();
  const download = menu.querySelector<HTMLAnchorElement>("a[role=menuitem]")!;
  expect(download.textContent).toBe("Download");
  expect(download.getAttribute("href")).toBe("/api/attachments/img-1");
  expect(download.getAttribute("download")).toBe("entry-setup.png");

  // Clicking elsewhere closes it.
  await act(async () => {
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  expect(container.querySelector('[role="menu"]')).toBeNull();

  await rightClick(thumb);
  const view = [...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
    (b) => b.textContent === "View full size",
  )!;
  await act(async () => view.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("entry-setup.png");
  expect(container.querySelector('[role="menu"]')).toBeNull();
});

it("has a right-click download on the trade gallery image", async () => {
  await renderGallery();
  await rightClick(container.querySelector('img[alt="entry-setup.png"]')!);
  expect(
    container.querySelector('[role="menu"] a[download="entry-setup.png"]')?.getAttribute("href"),
  ).toBe("/api/attachments/img-1");
  expect(
    container.querySelector('a[aria-label="Download entry-setup.png"]')?.getAttribute("href"),
  ).toBe("/api/attachments/img-1");
});
