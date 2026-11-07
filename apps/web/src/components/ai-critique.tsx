"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { AiNotice } from "./ai-notice";
import { AiPreviewDialog } from "./ai-preview-dialog";
import { postJson, useApi } from "@/lib/use-api";
import type { AiContextPreview } from "@/server/ai-prompt";
import type { SavedTradeAiReview } from "@/server/ai-review-history";

export interface TradeCritiqueProps {
  tradeKey: string;
}

function formatReviewTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Trade critique component with preview confirm-before-send and persistent critique history.
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
  const [localReviews, setLocalReviews] = useState<SavedTradeAiReview[] | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<AiContextPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const activeKeyRef = useRef(tradeKey);
  const earlierSectionId = useId();

  // Fetch persisted history for the current trade.
  const historyUrl = tradeKey ? `/api/ai/critique?key=${encodeURIComponent(tradeKey)}` : null;
  const { data: historyData } = useApi<{
    reviews?: SavedTradeAiReview[];
    critique?: string | null;
  }>(historyUrl);

  // Reset local transient state on trade key change to guarantee cross-trade isolation.
  useEffect(() => {
    activeKeyRef.current = tradeKey;
    setBusy(false);
    setError(null);
    setCritique(null);
    setLocalReviews(null);
    setShowEarlier(false);
    setPreviewOpen(false);
    setPreviewData(null);
    setPreviewError(null);
    setPreviewLoading(false);
  }, [tradeKey]);

  // Sync fetched history into local display state with append-only id-dedup merge.
  // This guarantees that a pending/deferred GET resolving after a POST cannot erase newer reviews.
  useEffect(() => {
    if (historyData?.reviews && Array.isArray(historyData.reviews)) {
      setLocalReviews((prev) => {
        if (!prev || prev.length === 0) return historyData.reviews!;
        const map = new Map<string, SavedTradeAiReview>();
        for (const r of historyData.reviews!) {
          map.set(r.id, r);
        }
        for (const r of prev) {
          map.set(r.id, r);
        }
        return Array.from(map.values()).sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
        );
      });
    }
  }, [historyData?.reviews]);

  const openPreview = async () => {
    const targetKey = tradeKey;
    setError(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const res = await postJson<{ preview: AiContextPreview }>("/api/ai/critique", {
        key: targetKey,
        preview: true,
      });
      if (activeKeyRef.current !== targetKey) return;
      setPreviewData(res.preview);
    } catch (err) {
      if (activeKeyRef.current !== targetKey) return;
      setPreviewError(err instanceof Error ? err.message : "Couldn’t generate critique preview.");
    } finally {
      if (activeKeyRef.current === targetKey) {
        setPreviewLoading(false);
      }
    }
  };

  const confirmSend = async (fingerprint?: string) => {
    const targetKey = tradeKey;
    setBusy(true);
    setError(null);
    setPreviewError(null);
    try {
      const result = await postJson<{
        critique: string;
        review?: SavedTradeAiReview;
        reviews?: SavedTradeAiReview[];
      }>("/api/ai/critique", {
        key: targetKey,
        ...(fingerprint ? { snapshotFingerprint: fingerprint } : {}),
      });

      if (activeKeyRef.current !== targetKey) return;

      setCritique(result.critique);
      // POST is authoritative; merge immediately without redundant re-fetch refresh()
      if (result.reviews && Array.isArray(result.reviews)) {
        setLocalReviews(result.reviews);
      } else if (result.review) {
        setLocalReviews((prev) => {
          const map = new Map<string, SavedTradeAiReview>();
          if (prev) {
            for (const r of prev) map.set(r.id, r);
          }
          map.set(result.review!.id, result.review!);
          return Array.from(map.values()).sort(
            (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
          );
        });
      }
      setPreviewOpen(false);
    } catch (err) {
      if (activeKeyRef.current !== targetKey) return;
      const msg = err instanceof Error ? err.message : "AI critique failed";
      setError(msg);
      setPreviewError(msg);
    } finally {
      if (activeKeyRef.current === targetKey) {
        setBusy(false);
      }
    }
  };

  const reviewsList: SavedTradeAiReview[] =
    localReviews ??
    (historyData?.reviews && Array.isArray(historyData.reviews) ? historyData.reviews : []);

  const hasReviews = reviewsList.length > 0;
  const latestReview = hasReviews ? reviewsList[reviewsList.length - 1] : null;
  const earlierReviews = hasReviews ? reviewsList.slice(0, -1) : [];
  const fallbackCritique = critique ?? historyData?.critique ?? null;

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

        {latestReview ? (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5 font-medium">
                  <span className="capitalize text-foreground">{latestReview.provider}</span>
                  <span>•</span>
                  <span className="font-mono">{latestReview.model}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span>{formatReviewTimestamp(latestReview.createdAt)}</span>
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                    Latest
                  </span>
                </div>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{latestReview.content}</p>
            </div>

            {earlierReviews.length > 0 && (
              <div className="space-y-3 border-t pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showEarlier}
                  aria-controls={earlierSectionId}
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowEarlier((v) => !v)}
                >
                  {showEarlier ? (
                    <ChevronUp className="mr-1 h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="mr-1 h-3.5 w-3.5" />
                  )}
                  {showEarlier ? "Hide" : "Show"} earlier reviews ({earlierReviews.length})
                </Button>

                {showEarlier && (
                  <div id={earlierSectionId} className="space-y-3">
                    {earlierReviews
                      .slice()
                      .reverse()
                      .map((rev) => (
                        <div key={rev.id} className="space-y-2 rounded-md border bg-muted/30 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium capitalize text-foreground">
                                {rev.provider}
                              </span>
                              <span>•</span>
                              <span className="font-mono">{rev.model}</span>
                            </div>
                            <span>{formatReviewTimestamp(rev.createdAt)}</span>
                          </div>
                          <p className="whitespace-pre-wrap text-xs leading-relaxed">
                            {rev.content}
                          </p>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        ) : fallbackCritique ? (
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{fallbackCritique}</p>
          </CardContent>
        ) : null}
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
