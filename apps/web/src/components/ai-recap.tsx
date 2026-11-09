"use client";

import { Sparkles } from "lucide-react";
import type { AnalysisFilters } from "@luxalgo/journal-core";
import { Button } from "./ui/button";
import { AiNotice } from "./ai-notice";
import { AiPreviewDialog } from "./ai-preview-dialog";
import { postJson } from "@/lib/use-api";
import { useAiPreview, useAiRequest, type AiScope } from "@/lib/use-ai-request";
import type { AiContextPreview } from "@/server/ai-prompt";

/** The parent keys this component by date, filters and timezone. */
export function AiRecap({
  date,
  filters,
  timeZone,
  disabled,
  disabledReason,
  beforeRequest,
  onRecap,
}: {
  date: string;
  filters: AnalysisFilters;
  timeZone: string;
  disabled: boolean;
  /** Shown under the button while it is disabled, so the trader knows what a recap needs. */
  disabledReason?: string;
  /** Runs before the preview is built, e.g. to save the latest note the recap reads. */
  beforeRequest?: () => unknown;
  onRecap: (result: { recap: string; scope: AiScope }) => void;
}) {
  const { run, busy, error, dismiss } = useAiRequest();
  const preview = useAiPreview("Couldn’t generate recap preview.");

  const prepareRecap = async () => {
    if (busy || disabled) return;
    await preview.prepare(async () => {
      await beforeRequest?.();
      const res = await postJson<{ preview: AiContextPreview; scope: AiScope }>("/api/ai/recap", {
        date,
        filters,
        timeZone,
        preview: true,
      });
      return res.preview;
    });
  };

  const confirmSend = async (fingerprint?: string) => {
    preview.setOpen(false);
    await run(
      () =>
        postJson<{ recap: string; scope: AiScope }>("/api/ai/recap", {
          date,
          filters,
          timeZone,
          ...(fingerprint ? { snapshotFingerprint: fingerprint } : {}),
        }),
      onRecap,
    );
  };

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void prepareRecap()}
        disabled={busy || disabled || preview.loading}
      >
        <Sparkles />
        {busy || preview.loading ? "Writing…" : "AI recap"}
      </Button>
      {disabled && disabledReason && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      {(error || preview.error) && (
        <AiNotice
          error={error || preview.error!}
          onRetry={() => void prepareRecap()}
          onDismiss={() => {
            dismiss();
            preview.setError(null);
          }}
        />
      )}

      <AiPreviewDialog
        open={preview.open}
        onOpenChange={preview.setOpen}
        title="Session Recap Preview"
        preview={preview.data}
        loading={preview.loading}
        error={preview.error}
        sending={busy}
        onConfirm={confirmSend}
        onRefresh={() => void prepareRecap()}
      />
    </div>
  );
}
