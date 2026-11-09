"use client";

import { useState } from "react";
import { Loader2, Sparkles, Undo2 } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { AiNotice } from "./ai-notice";
import { AiPreviewDialog } from "./ai-preview-dialog";
import { postJson } from "@/lib/use-api";
import { useAiPreview, useAiRequest } from "@/lib/use-ai-request";
import type { AiContextPreview, TidyFormat } from "@/server/ai-prompt";

type Result = { source: string; text: string };

/**
 * "Tidy up": sends the current note, after a preview, to the configured AI provider and offers the
 * cleaner rewrite. Nothing changes until the trader picks "Replace note", and that can be undone.
 */
export function AiTidy({
  text,
  onApply,
  context,
  format = "markdown",
  disabled = false,
  label = "Tidy up",
}: {
  text: string;
  onApply: (text: string) => void;
  /** A short description of where the note lives, such as "Trade note: ES long". */
  context?: string;
  format?: TidyFormat;
  disabled?: boolean;
  label?: string;
}) {
  const { run, busy, error, dismiss } = useAiRequest();
  const preview = useAiPreview("Couldn’t prepare the tidy-up preview.");
  const [resultOpen, setResultOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [sent, setSent] = useState("");
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);

  const empty = !text.trim();
  const body = (source: string) => ({
    text: source,
    format,
    ...(context ? { context: context.slice(0, 200) } : {}),
  });

  const prepare = async () => {
    if (busy || disabled || empty) return;
    const source = text;
    setSent(source);
    await preview.prepare(async () => {
      const res = await postJson<{ preview: AiContextPreview }>("/api/ai/tidy", {
        ...body(source),
        preview: true,
      });
      return res.preview;
    });
  };

  const send = async (fingerprint?: string) => {
    preview.setOpen(false);
    const source = sent;
    setResult(null);
    dismiss();
    setResultOpen(true);
    await run(
      () =>
        postJson<{ text: string }>("/api/ai/tidy", {
          ...body(source),
          ...(fingerprint ? { snapshotFingerprint: fingerprint } : {}),
        }),
      (res) => setResult({ source, text: res.text }),
    );
  };

  const replace = () => {
    if (!result) return;
    setUndo({ before: text, after: result.text });
    onApply(result.text);
    setResultOpen(false);
    setResult(null);
  };

  const changedSinceSent = result !== null && result.source !== text;
  const canUndo = undo !== null && undo.after === text;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void prepare()}
        disabled={disabled || empty || busy || preview.loading}
        title={empty ? "Write or dictate something first" : "Rewrite this note with AI"}
      >
        {busy || preview.loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {busy ? "Tidying…" : label}
      </Button>
      {canUndo && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onApply(undo.before);
            setUndo(null);
          }}
        >
          <Undo2 />
          Undo tidy
        </Button>
      )}

      <AiPreviewDialog
        open={preview.open}
        onOpenChange={preview.setOpen}
        title="Tidy up note"
        preview={preview.data}
        loading={preview.loading}
        error={preview.error}
        sending={busy}
        onConfirm={send}
        onRefresh={() => void prepare()}
        contextLabel="Your note"
        confirmLabel={preview.data ? `Tidy with ${preview.data.providerName}` : undefined}
      />

      <Dialog
        open={resultOpen}
        onOpenChange={(open) => {
          if (!busy) setResultOpen(open);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Tidied note
            </DialogTitle>
            <DialogDescription>
              Check the rewrite before it replaces your note. You can undo it afterwards.
            </DialogDescription>
          </DialogHeader>
          {busy ? (
            <div
              role="status"
              className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
            >
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              Tidying your note…
            </div>
          ) : error ? (
            <AiNotice
              error={error}
              onRetry={() => {
                setResultOpen(false);
                dismiss();
                void prepare();
              }}
              onDismiss={() => {
                dismiss();
                setResultOpen(false);
              }}
            />
          ) : result ? (
            <>
              {changedSinceSent && (
                <p role="alert" className="text-xs text-destructive">
                  The note changed after it was sent. Replacing it will drop those newer edits.
                </p>
              )}
              <div
                aria-label="Tidied note"
                className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm leading-relaxed"
              >
                {result.text}
              </div>
            </>
          ) : null}
          <div className="flex items-center justify-end gap-2 border-t pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setResultOpen(false);
                setResult(null);
              }}
            >
              {result ? "Keep original" : "Close"}
            </Button>
            {result && (
              <Button type="button" size="sm" onClick={replace}>
                Replace note
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
