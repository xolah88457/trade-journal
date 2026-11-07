"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Mic, MicOff, Loader2, Sparkles, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createLocalDictationSession,
  insertDictatedText,
  setupVoiceModel,
  type DictationSession,
  type DictationState,
} from "@/lib/dictation";

export interface VoiceNoteProps {
  onText: (text: string) => void;
  onPrepare?: () => void;
  targetRef?: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  size?: "sm" | "default" | "icon";
  variant?: "ghost" | "outline" | "default" | "secondary";
  className?: string;
  label?: string;
}

export function VoiceNote({
  onText,
  onPrepare,
  targetRef,
  size = "sm",
  variant = "outline",
  className,
  label,
}: VoiceNoteProps) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const textCallback = useRef(onText);
  textCallback.current = onText;

  const prepareCallback = useRef(onPrepare);
  prepareCallback.current = onPrepare;

  const sessionRef = useRef<DictationSession | null>(null);

  // Clean up any in-flight mic capture on unmount or navigation
  useEffect(() => {
    return () => {
      sessionRef.current?.dispose();
    };
  }, []);

  const handleTextReceived = (text: string) => {
    if (targetRef?.current) {
      const el = targetRef.current;
      const originalStart = el.selectionStart;
      const originalEnd = el.selectionEnd;
      const result = insertDictatedText({
        currentText: el.value,
        selectionStart: originalStart,
        selectionEnd: originalEnd,
        dictatedText: text,
      });
      textCallback.current(result.value);
      requestAnimationFrame(() => {
        el.focus();
        try {
          if (el.value === result.value) {
            el.setSelectionRange(result.selectionStart, result.selectionEnd);
          } else if (originalStart !== null && originalEnd !== null) {
            el.setSelectionRange(originalStart, originalEnd);
          }
        } catch {
          // Teardown: non-text or detached elements ignore setSelectionRange
        }
      });
    } else {
      textCallback.current(text);
    }
  };

  const startSession = () => {
    sessionRef.current?.dispose();
    setError("");
    prepareCallback.current?.();

    const session = createLocalDictationSession({
      onState: (nextState) => {
        setState(nextState);
        if (nextState === "setup-required") {
          setSetupOpen(true);
        }
      },
      onText: handleTextReceived,
      onError: (msg) => {
        setError(msg);
      },
      onAudioLevel: (level) => {
        setAudioLevel(level);
      },
    });

    sessionRef.current = session;
    session.start().catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to start dictation.");
      setState("idle");
    });
  };

  const handleToggle = () => {
    if (state === "listening") {
      sessionRef.current?.stop().catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to stop dictation.");
      });
    } else if (
      state === "transcribing" ||
      state === "preparing" ||
      state === "checking" ||
      state === "starting"
    ) {
      // Busy; do not trigger new action
      return;
    } else {
      startSession();
    }
  };

  const handleCancel = () => {
    sessionRef.current?.cancel();
  };

  const handleDownloadModel = async () => {
    setDownloading(true);
    setError("");
    try {
      await setupVoiceModel();
      setSetupOpen(false);
      setState("idle");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to download local speech model. Check your connection or disk space.",
      );
    } finally {
      setDownloading(false);
    }
  };

  const isBusy =
    state === "checking" ||
    state === "preparing" ||
    state === "starting" ||
    state === "transcribing";
  const isListening = state === "listening";

  return (
    <Popover.Root
      open={setupOpen || Boolean(error)}
      onOpenChange={(open) => {
        if (!open) {
          setSetupOpen(false);
          setError("");
        }
      }}
    >
      <div className="relative inline-flex items-center gap-1.5 shrink-0">
        <Popover.Anchor asChild>
          <Button
            type="button"
            variant={isListening ? "destructive" : variant}
            size={size}
            disabled={isBusy}
            onClick={handleToggle}
            aria-pressed={isListening}
            aria-busy={isBusy}
            aria-label={
              isListening
                ? "Stop dictation"
                : isBusy
                  ? state === "transcribing"
                    ? "Transcribing voice…"
                    : state === "starting"
                      ? "Starting microphone…"
                      : "Preparing local speech…"
                  : label || "Dictate note with local speech"
            }
            title={
              isListening
                ? "Stop dictation (Esc to cancel)"
                : "Dictate note using local Parakeet speech recognition"
            }
            className={`transition-all select-none ${isListening ? "pr-3 pl-2.5 shadow-sm" : ""} ${className || ""}`}
          >
            {isBusy ? (
              <Loader2 className="size-3.5 animate-spin text-current" />
            ) : isListening ? (
              <span className="relative flex size-3.5 items-center justify-center">
                <span
                  className="absolute inline-flex size-full rounded-full bg-white opacity-75 animate-ping"
                  style={{
                    transform: `scale(${1 + Math.min(1.5, audioLevel * 1.5)})`,
                  }}
                />
                <MicOff className="size-3.5 shrink-0 text-white" />
              </span>
            ) : (
              <Mic className="size-3.5 shrink-0" />
            )}

            <span>
              {state === "checking" || state === "preparing"
                ? "Preparing…"
                : state === "starting"
                  ? "Starting…"
                  : state === "transcribing"
                    ? "Transcribing…"
                    : isListening
                      ? "Stop"
                      : label || "Dictate"}
            </span>
          </Button>
        </Popover.Anchor>

        {(isListening || isBusy) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            title="Cancel dictation without saving (Esc)"
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Button>
        )}

        {/* Live status announcement for screen readers */}
        <span role="status" className="sr-only">
          {isListening
            ? "Microphone listening. Speak now, press Stop or Escape when finished."
            : state === "transcribing"
              ? "Transcribing speech on local device…"
              : state === "starting"
                ? "Starting microphone capture…"
                : state === "preparing"
                  ? "Preparing local speech model…"
                  : error
                    ? `Dictation error: ${error}`
                    : ""}
        </span>

        {/* Setup and Error Popover Content */}
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="journal-popup z-50 max-h-[var(--radix-popover-content-available-height)] w-84 max-w-[calc(100vw-24px)] space-y-3.5 overflow-y-auto rounded-xl border bg-card p-4 text-sm shadow-xl animate-in fade-in-50 zoom-in-95"
          >
            {setupOpen ? (
              <>
                <div className="flex items-start gap-2.5">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Sparkles className="size-4" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="font-semibold text-sm leading-none">Local Voice Dictation</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Sumi runs <strong>Parakeet Unified EN 0.6B</strong> with Silero VAD locally on
                      your Mac. Audio never leaves your computer.
                    </p>
                  </div>
                </div>

                <div className="rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  Model download size: ~730 MB. Downloaded once to your local cache and accelerated
                  via Apple Silicon Metal.
                </div>

                {error && (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSetupOpen(false);
                      setState("idle");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={downloading}
                    onClick={handleDownloadModel}
                    className="gap-1.5"
                  >
                    {downloading ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Downloading…
                      </>
                    ) : (
                      "Download & Enable"
                    )}
                  </Button>
                </div>
              </>
            ) : error ? (
              <>
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="size-5 shrink-0 text-destructive" />
                  <div className="space-y-1">
                    <h4 className="font-medium text-sm leading-none">Dictation Notice</h4>
                    <p role="alert" className="text-xs text-muted-foreground leading-relaxed">
                      {error}
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setError("");
                      setState("idle");
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              </>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
