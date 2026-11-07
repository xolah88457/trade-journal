"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { AiNotice } from "./ai-notice";
import { AiPreviewDialog } from "./ai-preview-dialog";
import { postJson } from "@/lib/use-api";
import type { AiContextPreview } from "@/server/ai-prompt";

export interface TradeCritiqueProps {
  tradeKey: string;
}

/**
 * Trade critique component with preview confirm-before-send.
 *
 * Handoff for app/trades/[key]/page.tsx:
 * 1. Import:
 *    import { TradeCritiqueSection } from "@/components/ai-critique";
 * 2. Replace the AI review Card block in app/trades/[key]/page.tsx with:
 *    <TradeCritiqueSection tradeKey={trade.key} />
 */
export function TradeCritiqueSection({ tradeKey }: TradeCritiqueProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [critique, setCritique] = useState<string | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<AiContextPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const openPreview = async () => {
    setError(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const res = await postJson<{ preview: AiContextPreview }>("/api/ai/critique", {
        key: tradeKey,
        preview: true,
      });
      setPreviewData(res.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Couldn’t generate critique preview.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmSend = async (fingerprint?: string) => {
    setBusy(true);
    setError(null);
    setPreviewError(null);
    try {
      const result = await postJson<{ critique: string }>("/api/ai/critique", {
        key: tradeKey,
        ...(fingerprint ? { snapshotFingerprint: fingerprint } : {}),
      });
      setCritique(result.critique);
      setPreviewOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI critique failed";
      setError(msg);
      setPreviewError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>AI review</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={openPreview}
            disabled={busy || previewLoading}
          >
            <Sparkles />
            {busy ? "Thinking…" : "Critique this trade"}
          </Button>
        </CardHeader>
        {error && (
          <CardContent>
            <AiNotice error={error} onRetry={openPreview} onDismiss={() => setError(null)} />
          </CardContent>
        )}
        {critique && (
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{critique}</p>
          </CardContent>
        )}
      </Card>

      <AiPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="Trade Critique Preview"
        preview={previewData}
        loading={previewLoading}
        error={previewError}
        sending={busy}
        onConfirm={confirmSend}
        onRefresh={openPreview}
      />
    </>
  );
}

/**
 * Button-only helper variant if parent prefers managing critique text display.
 */
export function TradeCritiqueButton({
  tradeKey,
  disabled,
  onCritique,
}: {
  tradeKey: string;
  disabled?: boolean;
  onCritique: (critique: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<AiContextPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const openPreview = async () => {
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const res = await postJson<{ preview: AiContextPreview }>("/api/ai/critique", {
        key: tradeKey,
        preview: true,
      });
      setPreviewData(res.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Couldn’t generate critique preview.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmSend = async (fingerprint?: string) => {
    setBusy(true);
    try {
      const result = await postJson<{ critique: string }>("/api/ai/critique", {
        key: tradeKey,
        ...(fingerprint ? { snapshotFingerprint: fingerprint } : {}),
      });
      onCritique(result.critique);
      setPreviewOpen(false);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "AI critique failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={openPreview}
        disabled={disabled || busy || previewLoading}
      >
        <Sparkles />
        {busy ? "Thinking…" : "Critique this trade"}
      </Button>

      <AiPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="Trade Critique Preview"
        preview={previewData}
        loading={previewLoading}
        error={previewError}
        sending={busy}
        onConfirm={confirmSend}
        onRefresh={openPreview}
      />
    </>
  );
}
