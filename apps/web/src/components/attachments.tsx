"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  Paperclip,
  Plus,
  Trash2,
  UploadCloud,
  FileText,
} from "lucide-react";
import { HoverHint } from "./ui/tooltip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { postJson, useApi } from "@/lib/use-api";

interface AttachmentItem {
  id: string;
  name: string;
  mime: string;
  size: number;
}

interface AttachmentsProps {
  type: "trade" | "day" | "note" | "missed" | "prop-account" | "prop-entry";
  id: string;
  variant?: "default" | "trade-gallery";
}

const fileUrl = (a: AttachmentItem) => `/api/attachments/${a.id}`;
const sizeLabel = (a: AttachmentItem) => `${Math.round(a.size / 1024)} KB`;

/** Right-click menu state: where it opens, relative to the element that was right-clicked. */
type MenuState = { attachment: AttachmentItem; x: number; y: number; canView: boolean };

export function Attachments({ type, id, variant = "default" }: AttachmentsProps) {
  const { data, error, refresh } = useApi<{
    attachments: AttachmentItem[];
  }>(`/api/attachments?type=${type}&id=${encodeURIComponent(id)}`);

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [, startTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const allAttachments = data?.attachments ?? [];
  const imageAttachments = allAttachments.filter((a) => a.mime.startsWith("image/"));
  const nonImageAttachments = allAttachments.filter((a) => !a.mime.startsWith("image/"));

  // Ensure currentIndex stays within bounds when attachments change; close lightbox if all images removed
  useEffect(() => {
    if (imageAttachments.length === 0) {
      setCurrentIndex(0);
      setLightboxOpen(false);
    } else if (currentIndex >= imageAttachments.length) {
      setCurrentIndex(imageAttachments.length - 1);
    }
  }, [imageAttachments.length, currentIndex]);

  const safeIndex =
    imageAttachments.length === 0 ? 0 : Math.min(currentIndex, imageAttachments.length - 1);
  const activeImage = imageAttachments[safeIndex];

  const openViewer = (attachment: AttachmentItem) => {
    const index = imageAttachments.findIndex((a) => a.id === attachment.id);
    if (index < 0) return;
    setMenu(null);
    setCurrentIndex(index);
    setLightboxOpen(true);
  };
  const step = (delta: number) =>
    startTransition(() => {
      setCurrentIndex((prev) =>
        Math.min(imageAttachments.length - 1, Math.max(0, Math.min(prev, safeIndex) + delta)),
      );
    });

  /** Opens the screenshot menu at the pointer, inside the element that handled the right-click. */
  const contextMenuFor =
    (attachment: AttachmentItem, canView = true) =>
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({
        attachment,
        canView,
        x: Math.max(0, Math.min(event.clientX - rect.left, rect.width - 176)),
        y: Math.max(0, event.clientY - rect.top),
      });
    };
  const menuHere = (attachment: AttachmentItem, canView = true) =>
    menu && menu.attachment.id === attachment.id && menu.canView === canView ? (
      <ScreenshotMenu menu={menu} onClose={closeMenu} onView={() => openViewer(menu.attachment)} />
    ) : null;

  const handleUpload = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    setBusy(true);
    setFailure("");

    const errors: string[] = [];
    let successCount = 0;

    for (const file of files) {
      const body = new FormData();
      body.append("type", type);
      body.append("id", id);
      body.append("file", file);
      try {
        const r = await fetch("/api/attachments", { method: "POST", body });
        const result = await r.json().catch(() => ({}));
        if (!r.ok) {
          errors.push(result.error || `${file.name}: upload failed (${r.status})`);
        } else {
          successCount++;
        }
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : "network error"}`);
      }
    }

    if (errors.length > 0) {
      if (successCount > 0) {
        setFailure(`Uploaded ${successCount} file(s), but failed: ${errors.join("; ")}`);
      } else {
        setFailure(errors.join("; "));
      }
    }

    setBusy(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    refresh();
  };

  const handleDelete = async (attachment: AttachmentItem) => {
    if (!window.confirm(`Remove ${attachment.name}?`)) return;
    try {
      await postJson(`/api/attachments/${attachment.id}`, undefined, "DELETE");
      refresh();
    } catch (e) {
      setFailure(String(e));
    }
  };

  // Keyboard navigation strictly scoped to gallery container
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (imageAttachments.length <= 1) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    }
  };

  const fileInput = (
    <input
      ref={fileInputRef}
      aria-label="Upload attachment"
      type="file"
      accept="image/png,image/jpeg,image/webp,application/pdf"
      className="hidden"
      multiple
      onChange={(e) => void handleUpload(e.target.files)}
    />
  );

  const lightbox = activeImage && (
    <Dialog
      open={lightboxOpen}
      onOpenChange={(open) => {
        setMenu(null);
        setLightboxOpen(open);
      }}
    >
      <DialogContent
        className="flex max-w-5xl flex-col gap-2 p-2 sm:p-4"
        onOpenAutoFocus={(e) => {
          // Start on Close so the way out is obvious and no navigation tooltip pops up.
          e.preventDefault();
          closeRef.current?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            step(e.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <DialogTitle className="truncate text-sm font-medium">{activeImage.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Full-size screenshot. Right-click it to download. Press Escape or Close to go back.
        </DialogDescription>
        <div
          className="relative flex max-h-[75vh] min-h-0 items-center justify-center overflow-auto"
          onContextMenu={contextMenuFor(activeImage, false)}
        >
          <img
            src={fileUrl(activeImage)}
            alt={activeImage.name}
            className="max-h-[75vh] w-auto max-w-full rounded object-contain"
          />
          {menuHere(activeImage, false)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            {imageAttachments.length > 1 && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Previous screenshot"
                  disabled={safeIndex === 0}
                  onClick={() => step(-1)}
                >
                  <ChevronLeft />
                </Button>
                <span className="tnum">
                  {safeIndex + 1} / {imageAttachments.length}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Next screenshot"
                  disabled={safeIndex === imageAttachments.length - 1}
                  onClick={() => step(1)}
                >
                  <ChevronRight />
                </Button>
              </>
            )}
            <span className="ml-1">{sizeLabel(activeImage)}</span>
          </span>
          <span className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={fileUrl(activeImage)} download={activeImage.name}>
                <Download />
                Download
              </a>
            </Button>
            <Button ref={closeRef} type="button" size="sm" onClick={() => setLightboxOpen(false)}>
              Close
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );

  // Default variant (used across other pages/drawers)
  if (variant === "default") {
    return (
      <div className="space-y-3 border-t pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
            {busy ? "Uploading…" : "Add attachment"}
          </Button>
          <span className="text-xs text-muted-foreground">Images or PDF · up to 8 MB each</span>
        </div>
        {fileInput}
        {(failure || error) && (
          <p role="alert" className="text-xs text-destructive">
            {failure || error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          {allAttachments.map((a) => {
            const isImage = a.mime.startsWith("image/");
            return (
              <div key={a.id} className="relative min-w-0 rounded-md border p-2">
                {isImage ? (
                  <HoverHint content={`${a.name} · click to view, right-click to download`}>
                    <button
                      type="button"
                      className="block w-full cursor-zoom-in rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label={`View ${a.name}`}
                      onClick={() => openViewer(a)}
                      onContextMenu={contextMenuFor(a)}
                    >
                      <img
                        src={fileUrl(a)}
                        alt={a.name}
                        className="mb-2 h-28 w-full rounded object-contain"
                      />
                      <span className="block truncate text-xs">{a.name}</span>
                    </button>
                  </HoverHint>
                ) : (
                  <a
                    href={fileUrl(a)}
                    download={a.name}
                    className="flex min-w-0 items-center gap-1 text-xs underline"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{a.name}</span>
                  </a>
                )}
                {menuHere(a)}
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{sizeLabel(a)}</span>
                  <span className="flex items-center">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title={`Download ${a.name}`}
                    >
                      <a href={fileUrl(a)} download={a.name} aria-label={`Download ${a.name}`}>
                        <Download className="h-3 w-3" />
                      </a>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => void handleDelete(a)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {lightbox}
      </div>
    );
  }

  // "trade-gallery" variant for Trade detail page (replaces interactive chart)
  return (
    <div
      ref={galleryRef}
      tabIndex={0}
      role="region"
      aria-label="Trade screenshots gallery"
      onKeyDown={handleKeyDown}
      className="space-y-4 outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-xl"
    >
      {fileInput}

      <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
        {/* Gallery Header / Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Screenshots</h2>
            {imageAttachments.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {safeIndex + 1} / {imageAttachments.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {busy ? "Uploading…" : "Add screenshots"}
            </Button>
          </div>
        </div>

        {/* Failure alert banner */}
        {(failure || error) && (
          <div
            className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive"
            role="alert"
          >
            {failure || error}
          </div>
        )}

        {/* Main Gallery Area */}
        {imageAttachments.length === 0 ? (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void handleUpload(e.dataTransfer.files);
            }}
            className="flex min-h-[300px] cursor-pointer flex-col items-center justify-center gap-3 p-8 text-center transition-colors hover:bg-muted/40"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <UploadCloud className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No screenshots for this trade yet</p>
              <p className="text-xs text-muted-foreground">
                Click or drag & drop screenshots here (PNG, JPEG, WebP up to 8 MB)
              </p>
            </div>
          </div>
        ) : (
          <div className="relative flex flex-col items-center bg-black/5 dark:bg-black/30">
            {/* Viewport / Image Container */}
            <div
              className="relative flex h-[400px] w-full items-center justify-center p-4"
              onContextMenu={activeImage ? contextMenuFor(activeImage) : undefined}
            >
              {activeImage && (
                <img
                  src={fileUrl(activeImage)}
                  alt={activeImage.name}
                  className="max-h-full max-w-full rounded object-contain cursor-zoom-in"
                  onClick={() => setLightboxOpen(true)}
                />
              )}

              {/* Prev / Next navigation buttons */}
              {imageAttachments.length > 1 && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    aria-label="Previous screenshot"
                    disabled={safeIndex === 0}
                    onClick={() => setCurrentIndex(Math.max(0, safeIndex - 1))}
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full shadow-md bg-background/80 hover:bg-background backdrop-blur disabled:opacity-30"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    aria-label="Next screenshot"
                    disabled={safeIndex === imageAttachments.length - 1}
                    onClick={() =>
                      setCurrentIndex(Math.min(imageAttachments.length - 1, safeIndex + 1))
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full shadow-md bg-background/80 hover:bg-background backdrop-blur disabled:opacity-30"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </Button>
                </>
              )}
              {activeImage && menuHere(activeImage)}
            </div>

            {/* Bottom bar for active image metadata & actions */}
            {activeImage && (
              <div className="flex w-full items-center justify-between border-t bg-card px-4 py-2 text-xs">
                <span className="truncate max-w-[280px] sm:max-w-md font-medium text-foreground">
                  {activeImage.name} ({sizeLabel(activeImage)})
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  >
                    <a
                      href={fileUrl(activeImage)}
                      download={activeImage.name}
                      aria-label={`Download ${activeImage.name}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    aria-label="View full size"
                    onClick={() => setLightboxOpen(true)}
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${activeImage.name}`}
                    onClick={() => void handleDelete(activeImage)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {lightbox}

      {/* Non-image document attachments section (PDFs / docs) */}
      {nonImageAttachments.length > 0 && (
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Attached Documents & PDFs</p>
          <div className="divide-y text-xs">
            {nonImageAttachments.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between py-2">
                <a
                  href={fileUrl(doc)}
                  download={doc.name}
                  className="flex items-center gap-2 truncate underline text-foreground hover:text-primary"
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{doc.name}</span>
                  <span className="text-muted-foreground">({sizeLabel(doc)})</span>
                </a>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${doc.name}`}
                  onClick={() => void handleDelete(doc)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The desktop app has no built-in right-click menu, so screenshots get their own small one.
 * It is positioned inside the right-clicked element, which keeps it working inside dialogs.
 */
function ScreenshotMenu({
  menu,
  onClose,
  onView,
}: {
  menu: MenuState;
  onClose: () => void;
  onView: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const item =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none [&_svg]:h-4 [&_svg]:w-4";
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${menu.attachment.name} options`}
      className="absolute z-50 w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      <a
        role="menuitem"
        href={fileUrl(menu.attachment)}
        download={menu.attachment.name}
        className={item}
        onClick={() => setTimeout(onClose, 0)}
      >
        <Download />
        Download
      </a>
      {menu.canView && (
        <button type="button" role="menuitem" className={item} onClick={onView}>
          <Maximize2 />
          View full size
        </button>
      )}
    </div>
  );
}
