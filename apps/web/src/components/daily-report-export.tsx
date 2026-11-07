"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  ImageIcon,
  Info,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePrivacy } from "@/components/privacy";
import type { DailyReport } from "@/lib/daily-report-types";
import type { ExportFile } from "@/lib/export-review";
import type {
  DailyReportPage,
  PreparedDailyReport,
  PrepareReportOptions,
} from "@/lib/daily-report-render";
import { cn } from "@/lib/utils";

export type { DailyReportPage, PreparedDailyReport };

export interface DailyReportRenderModule {
  prepareDailyReport(
    report: DailyReport,
    options?: PrepareReportOptions,
  ): Promise<PreparedDailyReport>;
}

export interface DailyReportExportProps {
  date: string;
  query?: string;
  note?: string;
  className?: string;
  loadRenderer?: () => Promise<DailyReportRenderModule>;
}

export function DailyReportExport({
  date,
  query = "",
  note,
  className,
  loadRenderer,
}: DailyReportExportProps) {
  // Always enforce privacy guard for daily financial reports
  const concealed = usePrivacy();

  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<"pdf" | "png">("pdf");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const [report, setReport] = useState<DailyReport | null>(null);
  const [prepared, setPrepared] = useState<PreparedDailyReport | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [thumbnailErrors, setThumbnailErrors] = useState<Record<string, string>>({});
  const [thumbnailProgress, setThumbnailProgress] = useState<{ loaded: number; total: number }>({
    loaded: 0,
    total: 0,
  });
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());

  const leaseRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const preparedRef = useRef<PreparedDailyReport | null>(null);
  const thumbnailUrlsRef = useRef<string[]>([]);
  const downloadingRef = useRef(false);
  const noteSnapshotRef = useRef<string | undefined>(note);

  // Keep latest note snapshot ref updated (undefined when user hasn't edited)
  noteSnapshotRef.current = note;

  const cleanup = useCallback(() => {
    leaseRef.current++;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (preparedRef.current) {
      try {
        preparedRef.current.dispose();
      } catch {
        // ignore disposal errors
      }
      preparedRef.current = null;
    }

    // Revoke thumbnail URLs immediately upon closing or resetting
    for (const url of thumbnailUrlsRef.current) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore revoke errors
      }
    }
    thumbnailUrlsRef.current = [];

    // Note: Download URLs are NOT revoked here; native WKDownload needs them
    // to survive until their 15-second expiration timer completes.

    downloadingRef.current = false;
    setPrepared(null);
    setReport(null);
    setThumbnails({});
    setThumbnailErrors({});
    setLoading(false);
    setDownloading(false);
    setError(null);
    setDownloadError(null);
    setThumbnailProgress({ loaded: 0, total: 0 });
    setSelectedPageIds(new Set());
    setActivePageIndex(0);
  }, []);

  const handleClose = useCallback(() => {
    cleanup();
    setOpen(false);
  }, [cleanup]);

  // If privacy mode activates mid-preview, immediately abort and close
  useEffect(() => {
    if (concealed && open) {
      handleClose();
    }
  }, [concealed, open, handleClose]);

  // Clean up if date or query parameters change
  useEffect(() => {
    if (open) {
      handleClose();
    }
  }, [date, query, handleClose]);

  // Cleanup on unmount: immediately revokes thumbnails and disposes prepared report
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const renderSingleThumbnail = useCallback(
    async (pageId: string, prepInstance?: PreparedDailyReport) => {
      const prep = prepInstance ?? preparedRef.current;
      if (!prep) return;
      const lease = leaseRef.current;

      setThumbnailErrors((prev) => {
        const next = { ...prev };
        delete next[pageId];
        return next;
      });

      try {
        const blob = await prep.renderPage(pageId, 0.65);
        if (leaseRef.current !== lease || abortRef.current?.signal.aborted || concealed) {
          return;
        }
        const blobUrl = URL.createObjectURL(blob);
        thumbnailUrlsRef.current.push(blobUrl);
        setThumbnails((prev) => ({ ...prev, [pageId]: blobUrl }));
      } catch (renderErr) {
        if (leaseRef.current !== lease || abortRef.current?.signal.aborted) return;
        const message = renderErr instanceof Error ? renderErr.message : "Failed to render preview";
        setThumbnailErrors((prev) => ({ ...prev, [pageId]: message }));
      }
    },
    [concealed],
  );

  const startExport = useCallback(
    async (initialFormat: "pdf" | "png") => {
      if (concealed) return;

      cleanup();
      const lease = ++leaseRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      setFormat(initialFormat);
      setOpen(true);
      setLoading(true);
      setError(null);
      setDownloadError(null);

      // Snapshot note right when user clicks export (avoids losing unsaved editor changes)
      const capturedNote = noteSnapshotRef.current;

      try {
        const cleanQuery = query.replace(/^\?/, "");
        const exportUrl = cleanQuery
          ? `/api/journal/${encodeURIComponent(date)}/export?${cleanQuery}`
          : `/api/journal/${encodeURIComponent(date)}/export`;

        const res = await fetch(exportUrl, { signal: controller.signal });
        if (leaseRef.current !== lease || controller.signal.aborted) return;

        if (!res.ok) {
          throw new Error(
            `Failed to load export data for ${date} (${res.status} ${res.statusText})`,
          );
        }

        const data = (await res.json()) as DailyReport;
        if (leaseRef.current !== lease || controller.signal.aborted) return;

        // Client-side note override ONLY:
        // If capturedNote is a string (even an intentional empty string draft ""),
        // override data.note. When it differs from server note, set noteUpdatedAt = null.
        // If capturedNote is undefined (no draft/unloaded editor), preserve DB note intact!
        if (typeof capturedNote === "string") {
          if (capturedNote !== data.note) {
            data.note = capturedNote;
            data.noteUpdatedAt = null;
          }
        }

        // Dynamically import canonical renderer library on demand
        const renderModule = loadRenderer
          ? await loadRenderer()
          : await import("@/lib/daily-report-render");
        if (leaseRef.current !== lease || controller.signal.aborted) return;

        const prep = await renderModule.prepareDailyReport(data, {
          signal: controller.signal,
        });
        if (leaseRef.current !== lease || controller.signal.aborted || concealed) {
          prep.dispose();
          return;
        }

        preparedRef.current = prep;
        setReport(data);
        setPrepared(prep);
        setLoading(false);
        setActivePageIndex(0);

        // Default all pages selected for export
        const allIds = prep.pages.map((p) => p.id);
        setSelectedPageIds(new Set(allIds));
        setThumbnailProgress({ loaded: 0, total: prep.pages.length });

        // Sequential / bounded thumbnail rendering: scale 0.65
        for (let i = 0; i < prep.pages.length; i++) {
          if (leaseRef.current !== lease || controller.signal.aborted || concealed) {
            return;
          }
          const page = prep.pages[i];
          if (!page) continue;
          try {
            const blob = await prep.renderPage(page.id, 0.65);
            if (leaseRef.current !== lease || controller.signal.aborted || concealed) {
              return;
            }
            const blobUrl = URL.createObjectURL(blob);
            thumbnailUrlsRef.current.push(blobUrl);
            setThumbnails((prev) => ({ ...prev, [page.id]: blobUrl }));
            setThumbnailProgress((prev) => ({ ...prev, loaded: prev.loaded + 1 }));
          } catch (renderErr) {
            if (leaseRef.current !== lease || controller.signal.aborted) return;
            const message =
              renderErr instanceof Error ? renderErr.message : "Failed to render preview";
            setThumbnailErrors((prev) => ({ ...prev, [page.id]: message }));
          }
        }
      } catch (err) {
        if (leaseRef.current !== lease || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to prepare export.");
        setLoading(false);
      }
    },
    [concealed, cleanup, date, query, loadRenderer],
  );

  const togglePageSelection = (id: string) => {
    setSelectedPageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllPages = () => {
    if (!prepared) return;
    setSelectedPageIds(new Set(prepared.pages.map((p) => p.id)));
  };

  const clearAllPages = () => {
    setSelectedPageIds(new Set());
  };

  const handleDownload = async () => {
    if (downloadingRef.current || downloading) return;
    if (!preparedRef.current || !report) return;
    if (concealed) {
      setDownloadError("Turn off privacy mode to export financial figures.");
      return;
    }

    const currentPrepared = preparedRef.current;
    const lease = leaseRef.current;

    setDownloading(true);
    downloadingRef.current = true;
    setDownloadError(null);

    try {
      let file: ExportFile;

      // Capture selected IDs at download time and preserve page order!
      const orderedSelectedIds = currentPrepared.pages
        .map((p) => p.id)
        .filter((id) => selectedPageIds.has(id));

      if (orderedSelectedIds.length === 0) {
        throw new Error("Select at least one page to export.");
      }

      if (format === "pdf") {
        file = await currentPrepared.buildPdf(orderedSelectedIds);
      } else {
        file = await currentPrepared.buildPngDownload(orderedSelectedIds);
      }

      // Check lease and privacy before initiating download
      if (leaseRef.current !== lease || concealed) {
        return;
      }

      // Safe WebKit native WKDownload pattern:
      // Append to body, trigger native link click, and leave URL alive until
      // the 15-second timeout fires so background stream download succeeds.
      const url = URL.createObjectURL(file.blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();

      // Revoke after 15s to allow WKDownload enough time to consume the blob stream
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }, 15000);
    } catch (err) {
      if (leaseRef.current === lease) {
        setDownloadError(err instanceof Error ? err.message : "Download failed.");
      }
    } finally {
      if (leaseRef.current === lease) {
        setDownloading(false);
        downloadingRef.current = false;
      }
    }
  };

  const totalPages = prepared?.pages.length ?? 0;
  const currentPage = prepared?.pages[activePageIndex] ?? null;
  const selectedCount = selectedPageIds.size;
  const closedTradesCount = report?.trades?.length ?? 0;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading || concealed}
          onClick={() => void startExport("pdf")}
        >
          <Download />
          Export PDF
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading || concealed}
          onClick={() => void startExport("png")}
        >
          <ImageIcon />
          Export PNG
        </Button>
      </div>

      {concealed && (
        <p className="text-xs text-muted-foreground">
          Turn off privacy mode to export financial figures.
        </p>
      )}

      {error && !open && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <Dialog
        open={open && !concealed}
        onOpenChange={(next) => {
          if (!next) handleClose();
        }}
      >
        <TooltipProvider delayDuration={0}>
          <DialogContent className="max-h-[92vh] w-[calc(100%-24px)] max-w-4xl overflow-y-auto p-4 sm:p-6">
            <DialogHeader className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3 pr-6">
                <div>
                  <DialogTitle className="text-lg font-semibold tracking-tight">
                    Daily journal report
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">
                    Complete day overview, trade breakdown, and chart screenshots
                  </DialogDescription>
                </div>

                {/* Format buttons/tabs in modal switch without re-rendering */}
                <Tabs
                  value={format}
                  onValueChange={(val) => setFormat(val as "pdf" | "png")}
                  className="shrink-0"
                >
                  <TabsList className="h-8">
                    <TabsTrigger value="pdf" className="text-xs">
                      PDF Document
                    </TabsTrigger>
                    <TabsTrigger value="png" className="text-xs">
                      PNG Images
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {/* Scope / Snapshot labels */}
              {report && (
                <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                  <Badge variant="outline" className="font-mono">
                    {report.date}
                  </Badge>
                  <Badge variant="secondary">
                    {report.scope?.label || (query ? `Filters: ${query}` : "All accounts")}
                  </Badge>
                  <span className="text-muted-foreground">
                    {closedTradesCount} {closedTradesCount === 1 ? "trade" : "trades"} ·{" "}
                    {totalPages} {totalPages === 1 ? "page" : "pages"}
                  </span>
                  <Badge variant="outline" className="bg-background">
                    {selectedCount} of {totalPages} selected
                  </Badge>
                </div>
              )}
            </DialogHeader>

            {loading && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Loader2 className="mb-3 size-8 animate-spin text-primary" />
                <p className="text-sm font-medium">Preparing daily report...</p>
                <p className="mb-4 text-xs text-muted-foreground">
                  Collecting trade metrics, executions, notes, and chart captures
                </p>
                <Button size="sm" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
              </div>
            )}

            {error && (
              <div className="my-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                <div className="flex items-center gap-2 font-medium">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>Export preparation failed</span>
                </div>
                <p className="mt-1 text-xs">{error}</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void startExport(format)}>
                    Retry
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleClose}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {!loading && !error && prepared && (
              <div className="space-y-4">
                {/* Main preview and thumbnail browser grid */}
                <div className="grid gap-4 lg:grid-cols-12">
                  {/* Full page preview column (8 cols on lg) */}
                  <div className="space-y-3 lg:col-span-8">
                    {/* Page preview header & pagination controls */}
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={activePageIndex === 0}
                          onClick={() => setActivePageIndex((p) => Math.max(0, p - 1))}
                          title="Previous page"
                          aria-label="Previous page"
                        >
                          <ChevronLeft className="size-4" />
                        </Button>
                        <span className="font-medium">
                          Page {activePageIndex + 1} of {totalPages}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={activePageIndex >= totalPages - 1}
                          onClick={() => setActivePageIndex((p) => Math.min(totalPages - 1, p + 1))}
                          title="Next page"
                          aria-label="Next page"
                        >
                          <ChevronRight className="size-4" />
                        </Button>
                      </div>

                      <div className="flex items-center gap-2">
                        {currentPage && (
                          <Badge
                            variant={
                              currentPage.kind === "daily"
                                ? "default"
                                : currentPage.kind === "trade"
                                  ? "secondary"
                                  : "outline"
                            }
                            className="capitalize"
                          >
                            {currentPage.kind}
                          </Badge>
                        )}
                        <span className="max-w-[200px] truncate text-muted-foreground">
                          {currentPage?.title}
                        </span>
                      </div>

                      {/* Checkbox for current page */}
                      {currentPage && (
                        <label className="flex cursor-pointer items-center gap-1.5 font-medium">
                          <Checkbox
                            checked={selectedPageIds.has(currentPage.id)}
                            onCheckedChange={() => togglePageSelection(currentPage.id)}
                            aria-label={`Include page ${activePageIndex + 1} in export`}
                          />
                          <span>Include</span>
                        </label>
                      )}
                    </div>

                    {/* Rendered full page preview display */}
                    <div className="flex min-h-[380px] max-h-[56vh] items-center justify-center overflow-hidden rounded-xl border bg-background p-2 shadow-xs">
                      {currentPage && thumbnails[currentPage.id] ? (
                        <img
                          src={thumbnails[currentPage.id]}
                          alt={currentPage.title}
                          className="max-h-[52vh] w-auto max-w-full rounded border border-border/60 object-contain shadow-xs"
                        />
                      ) : currentPage && thumbnailErrors[currentPage.id] ? (
                        <div className="flex flex-col items-center justify-center p-8 text-center text-xs">
                          <AlertCircle className="mb-2 size-6 text-destructive" />
                          <span className="font-medium text-destructive">
                            Failed to render preview for {currentPage.title}
                          </span>
                          <span className="mt-1 max-w-sm text-muted-foreground">
                            {thumbnailErrors[currentPage.id]}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-3 gap-1.5"
                            onClick={() => void renderSingleThumbnail(currentPage.id)}
                          >
                            <RotateCcw className="size-3.5" />
                            Retry preview
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center p-8 text-center text-xs text-muted-foreground">
                          <Loader2 className="mb-2 size-6 animate-spin text-primary" />
                          <span>Rendering page preview...</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Thumbnails sidebar (4 cols on lg) */}
                  <div className="space-y-2 lg:col-span-4">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-muted-foreground uppercase tracking-wider text-[11px]">
                        Pages ({totalPages})
                      </span>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[11px]"
                          onClick={selectAllPages}
                        >
                          Select all
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[11px]"
                          onClick={clearAllPages}
                        >
                          Clear
                        </Button>
                      </div>
                    </div>

                    {/* Scrollable thumbnail container with accessible button elements */}
                    <div
                      tabIndex={0}
                      aria-label="Page thumbnail list"
                      className="max-h-[56vh] space-y-2 overflow-y-auto pr-1"
                    >
                      {prepared.pages.map((p, index) => {
                        const isActive = index === activePageIndex;
                        const isSelected = selectedPageIds.has(p.id);
                        const hasError = Boolean(thumbnailErrors[p.id]);

                        return (
                          <div
                            key={p.id}
                            className={cn(
                              "flex items-center gap-2 rounded-lg border p-1.5 text-xs transition-colors",
                              isActive
                                ? "border-primary bg-primary/5 ring-1 ring-primary"
                                : "border-border/70 hover:border-foreground/30 bg-card",
                            )}
                          >
                            {/* Checkbox sibling */}
                            <div className="flex shrink-0 items-center pl-1">
                              <Checkbox
                                id={`select-page-${p.id}`}
                                checked={isSelected}
                                onCheckedChange={() => togglePageSelection(p.id)}
                                aria-label={`Select page ${index + 1}: ${p.title}`}
                              />
                            </div>

                            {/* Real button thumbnail/title: Enter/Space activates page */}
                            <button
                              type="button"
                              onClick={() => setActivePageIndex(index)}
                              aria-label={`Show page ${index + 1}: ${p.title}`}
                              aria-current={isActive ? "page" : undefined}
                              className="flex min-w-0 flex-1 items-center gap-2 rounded p-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {/* Mini thumbnail preview */}
                              <div className="relative flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted">
                                {thumbnails[p.id] ? (
                                  <img
                                    src={thumbnails[p.id]}
                                    alt=""
                                    className="h-full w-full object-cover"
                                  />
                                ) : hasError ? (
                                  <AlertCircle className="size-4 text-destructive/70" />
                                ) : (
                                  <FileText className="size-4 text-muted-foreground/60" />
                                )}
                                <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 py-0.2 text-[9px] font-mono text-white">
                                  {index + 1}
                                </span>
                              </div>

                              {/* Page title and kind */}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate font-medium">{p.title}</span>
                                </div>
                                <span className="text-[11px] capitalize text-muted-foreground">
                                  {p.kind}
                                  {p.tradeKey ? ` · ${p.tradeKey}` : ""}
                                </span>
                                {hasError && (
                                  <div className="text-[10px] text-destructive">Preview failed</div>
                                )}
                              </div>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Editorial notices and disclosures */}
                <Card className="border-border/60 bg-muted/30">
                  <CardContent className="space-y-1.5 p-3 text-xs text-muted-foreground">
                    <div className="flex items-start gap-2">
                      <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <div className="space-y-1">
                        <p>
                          <strong>Day note disclosure:</strong> Day notes are shared across
                          accounts. Written reflections and chart captures may contain private
                          trading information.
                        </p>
                        <p>
                          <strong>PDF attachments:</strong> Attached PDF documents are listed by
                          filename and size; they are not merged into this report.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {downloadError && (
                  <p role="alert" className="text-xs text-destructive">
                    {downloadError}
                  </p>
                )}

                {/* Action buttons and download triggers */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <div className="text-xs text-muted-foreground">
                    {format === "pdf" ? (
                      <span>
                        {selectedCount === 0
                          ? "Select at least 1 page to export"
                          : selectedCount === totalPages
                            ? `Exports complete PDF with overview and all trades (${totalPages} ${totalPages === 1 ? "page" : "pages"})`
                            : `${selectedCount} ${selectedCount === 1 ? "page" : "pages"} selected · PDF document`}
                      </span>
                    ) : (
                      <span>
                        {selectedCount === 0
                          ? "Select at least 1 page to export"
                          : selectedCount === 1
                            ? "1 page selected · single PNG image"
                            : `${selectedCount} pages selected · ZIP archive`}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleClose}
                      disabled={downloading}
                    >
                      Cancel
                    </Button>

                    {format === "pdf" ? (
                      <Button
                        size="sm"
                        disabled={downloading || selectedCount === 0 || concealed}
                        onClick={() => void handleDownload()}
                      >
                        {downloading ? (
                          <>
                            <Loader2 className="animate-spin" />
                            Building PDF...
                          </>
                        ) : selectedCount === 0 ? (
                          "Select at least 1 page"
                        ) : selectedCount === totalPages ? (
                          <>
                            <Download />
                            Download full PDF ({totalPages} {totalPages === 1 ? "page" : "pages"})
                          </>
                        ) : (
                          <>
                            <Download />
                            Download selected PDF ({selectedCount}{" "}
                            {selectedCount === 1 ? "page" : "pages"})
                          </>
                        )}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={downloading || selectedCount === 0 || concealed}
                        onClick={() => void handleDownload()}
                      >
                        {downloading ? (
                          <>
                            <Loader2 className="animate-spin" />
                            Exporting PNG...
                          </>
                        ) : selectedCount === 0 ? (
                          "Select at least 1 page"
                        ) : selectedCount === 1 ? (
                          <>
                            <Download />
                            Download selected PNG (1 page)
                          </>
                        ) : (
                          <>
                            <Download />
                            Download ZIP ({selectedCount} pages)
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </DialogContent>
        </TooltipProvider>
      </Dialog>
    </div>
  );
}
