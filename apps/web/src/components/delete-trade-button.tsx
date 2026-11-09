"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFilters } from "@/components/filter-bar";
import { postJson } from "@/lib/use-api";

/** Deletes one trade with its executions, notes, screenshots and AI reviews, then returns to the list. */
export function DeleteTradeButton({ tradeKey, label }: { tradeKey: string; label: string }) {
  const router = useRouter();
  const { query } = useFilters();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  const remove = async () => {
    if (
      !confirm(
        `Delete ${label}? Its executions, notes, screenshots and AI reviews are removed. This cannot be undone. Importing the same file or syncing the broker again can bring the trade back.`,
      )
    )
      return;
    setBusy(true);
    setFailure("");
    try {
      await postJson(`/api/trades/${encodeURIComponent(tradeKey)}`, undefined, "DELETE");
      router.push(`/trades${query ? `?${query}` : ""}`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Couldn’t delete the trade.");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={busy}
        onClick={() => void remove()}
      >
        <Trash2 />
        {busy ? "Deleting…" : "Delete trade"}
      </Button>
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
