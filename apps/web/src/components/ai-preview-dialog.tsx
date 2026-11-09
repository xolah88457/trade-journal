"use client";

import { Sparkles, ShieldCheck, Server, Cloud, Info } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import type { AiContextPreview } from "@/server/ai-prompt";

interface AiPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  preview: AiContextPreview | null;
  loading: boolean;
  error?: string | null;
  sending?: boolean;
  onConfirm: (fingerprint?: string) => void | Promise<void>;
  onCancel?: () => void;
  onRefresh?: () => void;
  confirmLabel?: string;
  /** Heading for the data section; defaults to the journal data wording. */
  contextLabel?: string;
}

export function AiPreviewDialog({
  open,
  onOpenChange,
  title = "Review AI Request",
  preview,
  loading,
  error,
  sending = false,
  onConfirm,
  onCancel,
  onRefresh,
  confirmLabel,
  contextLabel = "Journal data context (grounding data)",
}: AiPreviewDialogProps) {
  const close = () => {
    onCancel?.();
    onOpenChange(false);
  };

  const isLocal = preview?.isLocal ?? false;
  const sendButtonText = confirmLabel ?? (preview ? `Send to ${preview.providerName}` : "Send");
  const isDriftError = Boolean(
    error && (error.includes("changed since preview") || error.includes("updated preview")),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>
            Preview snapshot of your journal data and settings. Context is verified and rebuilt live
            upon sending.
          </DialogDescription>
        </DialogHeader>

        {preview && (
          <div className="rounded-lg border bg-muted/40 p-3 text-xs space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                {isLocal ? (
                  <Server className="h-3.5 w-3.5 text-profit" />
                ) : (
                  <Cloud className="h-3.5 w-3.5 text-primary" />
                )}
                <span>Provider: {preview.providerName}</span>
              </div>
              <span className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground">
                Model: {preview.model || "default"}
              </span>
            </div>
            <p className="text-muted-foreground leading-relaxed flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{preview.networkPrivacy}</span>
            </p>
            <p className="text-[11px] text-muted-foreground/80 border-t pt-1 flex items-center gap-1">
              <Info className="h-3 w-3 shrink-0" />
              <span>
                Snapshot at review time (id: {preview.snapshotFingerprint}). Exact prompt is rebuilt
                on send; sending halts if data or instructions change.
              </span>
            </p>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground gap-2">
            <Sparkles className="h-6 w-6 animate-spin text-primary" />
            <span>Generating context preview snapshot…</span>
          </div>
        ) : error ? (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive space-y-2">
            <p>{error}</p>
            {isDriftError && onRefresh && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={onRefresh}
              >
                Refresh preview snapshot
              </Button>
            )}
          </div>
        ) : preview ? (
          <div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs">
            {preview.customInstructions ? (
              <div>
                <div className="font-semibold text-foreground mb-1">
                  Personal trading instructions
                </div>
                <pre className="whitespace-pre-wrap rounded bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed border border-border/80">
                  {preview.customInstructions}
                </pre>
              </div>
            ) : null}

            <div>
              <div className="font-semibold text-foreground mb-1">Task prompt</div>
              <pre className="whitespace-pre-wrap rounded bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed border border-border/80">
                {preview.taskPrompt}
              </pre>
            </div>

            <div>
              <div className="font-semibold text-foreground mb-1">{contextLabel}</div>
              <pre className="whitespace-pre-wrap rounded bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed border border-border/80 max-h-56 overflow-y-auto">
                {preview.journalContext}
              </pre>
            </div>

            <div>
              <div className="font-semibold text-foreground mb-1">
                System instructions & boundaries
              </div>
              <pre className="whitespace-pre-wrap rounded bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed border border-border/80 max-h-36 overflow-y-auto">
                {preview.effectiveSystemPrompt}
              </pre>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2 border-t">
          <Button type="button" variant="outline" size="sm" disabled={sending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={loading || Boolean(error) || sending || !preview}
            onClick={() => void onConfirm(preview?.snapshotFingerprint)}
          >
            <Sparkles className="h-4 w-4" />
            {sending ? "Sending…" : sendButtonText}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
