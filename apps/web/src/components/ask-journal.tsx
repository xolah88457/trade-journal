"use client";

import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { postJson } from "@/lib/use-api";
import { AiNotice } from "./ai-notice";
import { AiPreviewDialog } from "./ai-preview-dialog";
import { useFilters } from "./filter-bar";
import { useAiRequest, type AiScope } from "@/lib/use-ai-request";
import type { AnalysisFilters } from "@luxalgo/journal-core";
import type { AiContextPreview } from "@/server/ai-prompt";

const SUGGESTIONS = [
  "What's my most expensive mistake?",
  "Which weekday should I stop trading?",
  "Am I better at longs or shorts?",
];

/** Natural-language questions against your own aggregates — BYO AI provider key. */
export function AskJournal() {
  const { values, query, timeZone } = useFilters();
  return <ScopedAskJournal key={`${timeZone}:${query}`} filters={values} timeZone={timeZone} />;
}

function ScopedAskJournal({ filters, timeZone }: { filters: AnalysisFilters; timeZone: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; scope: AiScope } | null>(null);
  const { run, busy, error, dismiss } = useAiRequest();
  const [lastQuestion, setLastQuestion] = useState("");

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<AiContextPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const busyRef = useRef(false);

  const prepareAsk = async (q: string) => {
    if (busy || previewLoading || busyRef.current || !q.trim()) return;
    busyRef.current = true;
    q = q.trim();
    setPendingQuestion(q);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const res = await postJson<{ preview: AiContextPreview; scope: AiScope }>("/api/ai/ask", {
        question: q,
        filters,
        timeZone,
        preview: true,
      });
      setPreviewData(res.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Couldn’t generate preview.");
    } finally {
      setPreviewLoading(false);
      busyRef.current = false;
    }
  };

  const confirmSend = async (fingerprint?: string) => {
    const q = pendingQuestion;
    if (!q) return;
    setLastQuestion(q);
    setAnswer(null);
    setPreviewOpen(false);
    await run(
      () =>
        postJson<{ answer: string; scope: AiScope }>("/api/ai/ask", {
          question: q,
          filters,
          timeZone,
          ...(fingerprint ? { snapshotFingerprint: fingerprint } : {}),
        }),
      setAnswer,
    );
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Ask your journal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Uses the selected accounts and journal filters. Changing filters clears the answer.
          </p>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (question.trim()) void prepareAsk(question);
            }}
          >
            <Input
              aria-label="Ask your journal a question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Why do my Monday shorts keep failing?"
            />
            <Button type="submit" disabled={busy || previewLoading || !question.trim()}>
              <Sparkles />
              {busy || previewLoading ? "Thinking…" : "Ask"}
            </Button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                disabled={busy || previewLoading}
                className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent disabled:cursor-wait disabled:opacity-50"
                onClick={() => {
                  setQuestion(suggestion);
                  void prepareAsk(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
          {(error || previewError) && (
            <AiNotice
              error={error || previewError!}
              onRetry={() => void prepareAsk(lastQuestion || question)}
              onDismiss={() => {
                dismiss();
                setPreviewError(null);
              }}
            />
          )}
          {answer && (
            <div className="space-y-2 pt-1">
              <p className="text-xs text-muted-foreground">{answer.scope.label}</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.answer}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <AiPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="Ask Journal Preview"
        preview={previewData}
        loading={previewLoading}
        error={previewError}
        sending={busy}
        onConfirm={confirmSend}
        onRefresh={() => void prepareAsk(pendingQuestion)}
      />
    </>
  );
}
