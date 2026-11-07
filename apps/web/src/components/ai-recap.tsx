"use client";

import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { AnalysisFilters } from "@luxalgo/journal-core";
import { Button } from "./ui/button";
import { AiNotice } from "./ai-notice";
import { AiPreviewDialog } from "./ai-preview-dialog";
import { postJson } from "@/lib/use-api";
import { useAiRequest, type AiScope } from "@/lib/use-ai-request";
import type { AiContextPreview } from "@/server/ai-prompt";

/** The parent keys this component by date, filters and timezone. */
export function AiRecap({
  date,
  filters,
  timeZone,
  disabled,
  onRecap,
}: {
  date: string;
  filters: AnalysisFilters;
  timeZone: string;
  disabled: boolean;
  onRecap: (result: { recap: string; scope: AiScope }) => void;
}) {
  const { run, busy, error, dismiss } = useAiRequest();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<AiContextPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const prepareRecap = async () => {
    if (busy || previewLoading || busyRef.current || disabled) return;
    busyRef.current = true;
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const res = await postJson<{ preview: AiContextPreview; scope: AiScope }>("/api/ai/recap", {
        date,
        filters,
        timeZone,
        preview: true,
      });
      setPreviewData(res.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Couldn’t generate recap preview.");
    } finally {
      setPreviewLoading(false);
      busyRef.current = false;
    }
  };

  const confirmSend = async (fingerprint?: string) => {
    setPreviewOpen(false);
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
        disabled={busy || disabled || previewLoading}
      >
        <Sparkles />
        {busy || previewLoading ? "Writing…" : "AI recap"}
      </Button>
      {(error || previewError) && (
        <AiNotice
          error={error || previewError!}
          onRetry={() => void prepareRecap()}
          onDismiss={() => {
            dismiss();
            setPreviewError(null);
          }}
        />
      )}

      <AiPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="Session Recap Preview"
        preview={previewData}
        loading={previewLoading}
        error={previewError}
        sending={busy}
        onConfirm={confirmSend}
        onRefresh={() => void prepareRecap()}
      />
    </div>
  );
}
