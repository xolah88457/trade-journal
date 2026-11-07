"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Paperclip,
  Plus,
  Trash2,
  UploadCloud,
  FileText,
} from "lucide-react";
import { HoverHint } from "./ui/tooltip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { postJson, useApi } from "@/lib/use-api";

export interface AttachmentItem {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface AttachmentsProps {
  type: "trade" | "day" | "note" | "missed" | "prop-account" | "prop-entry";
  id: string;
  variant?: "default" | "trade-gallery";
}

export function Attachments({ type, id, variant = "default" }: AttachmentsProps) {
  const { data, error, refresh } = useApi<{
    attachments: AttachmentItem[];
  }>(`/api/attachments?type=${type}&id=${encodeURIComponent(id)}`);

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [, startTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);

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
      startTransition(() => {
        setCurrentIndex((prev) => Math.max(0, prev - 1));
      });
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      startTransition(() => {
        setCurrentIndex((prev) => Math.min(imageAttachments.length - 1, prev + 1));
      });
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
          {allAttachments.map((a) => (
            <div key={a.id} className="min-w-0 rounded-md border p-2">
              <HoverHint content={a.name}>
                <a
                  href={`/api/attachments/${a.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block"
                >
                  {a.mime.startsWith("image/") && (
                    <img
                      src={`/api/attachments/${a.id}`}
                      alt={a.name}
                      className="mb-2 h-28 w-full rounded object-contain"
                    />
                  )}
                  <span className="block truncate text-xs underline">{a.name}</span>
                </a>
              </HoverHint>
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{Math.round(a.size / 1024)} KB</span>
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
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // "trade-gallery" variant for Trade detail page (replaces interactive chart)
  const safeIndex =
    imageAttachments.length === 0 ? 0 : Math.min(currentIndex, imageAttachments.length - 1);
  const activeImage = imageAttachments[safeIndex];

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
            <div className="relative flex h-[400px] w-full items-center justify-center p-4">
              {activeImage && (
                <img
                  src={`/api/attachments/${activeImage.id}`}
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
            </div>

            {/* Bottom bar for active image metadata & actions */}
            {activeImage && (
              <div className="flex w-full items-center justify-between border-t bg-card px-4 py-2 text-xs">
                <span className="truncate max-w-[280px] sm:max-w-md font-medium text-foreground">
                  {activeImage.name} ({Math.round(activeImage.size / 1024)} KB)
                </span>
                <div className="flex items-center gap-1">
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

      {/* Lightbox / Fullscreen Dialog */}
      {imageAttachments.length > 0 && activeImage && (
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent className="max-w-5xl p-2 sm:p-4">
            <DialogTitle className="text-sm font-medium truncate mb-2">
              {activeImage.name}
            </DialogTitle>
            <div className="flex max-h-[80vh] items-center justify-center overflow-auto">
              <img
                src={`/api/attachments/${activeImage.id}`}
                alt={activeImage.name}
                className="max-h-[75vh] w-auto max-w-full rounded object-contain"
              />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Non-image document attachments section (PDFs / docs) */}
      {nonImageAttachments.length > 0 && (
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Attached Documents & PDFs</p>
          <div className="divide-y text-xs">
            {nonImageAttachments.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between py-2">
                <a
                  href={`/api/attachments/${doc.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 truncate underline text-foreground hover:text-primary"
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{doc.name}</span>
                  <span className="text-muted-foreground">({Math.round(doc.size / 1024)} KB)</span>
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
