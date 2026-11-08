"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { AiContextPreview } from "@/server/ai-prompt";

/** Use in a component keyed by its filter snapshot so old results cannot cross scopes. */
export function useAiRequest() {
  const active = useRef(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function run<T>(request: () => Promise<T>, accept: (result: T) => void) {
    if (pending.current || !active.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await request();
      if (active.current) accept(result);
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : "AI request failed");
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return { run, busy, error, dismiss: () => setError(null) };
}

/**
 * Preview-before-send state: dialog visibility, the fetched preview, loading and error. `prepare`
 * ignores calls while a preview is already loading, and `reset` discards any in-flight preview so a
 * response that arrives late cannot leak into the next scope.
 */
export function useAiPreview(failureMessage: string) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AiContextPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);

  async function prepare(request: () => Promise<AiContextPreview>) {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = generation.current;
    setError(null);
    setLoading(true);
    setOpen(true);
    try {
      const preview = await request();
      if (generation.current === mine) setData(preview);
    } catch (cause) {
      if (generation.current === mine) {
        setError(cause instanceof Error ? cause.message : failureMessage);
      }
    } finally {
      if (generation.current === mine) {
        setLoading(false);
        inFlight.current = false;
      }
    }
  }

  function reset() {
    generation.current += 1;
    inFlight.current = false;
    setOpen(false);
    setData(null);
    setError(null);
    setLoading(false);
  }

  return { open, setOpen, data, loading, error, setError, prepare, reset };
}

export interface AiScope {
  label: string;
  timeZone: string;
}
