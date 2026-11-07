"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { ManualTradeEntry } from "./manual-trade-entry";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

export function AddTradeDialog({ onSaved }: { onSaved?: (tradeKey?: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" />
          Add trade
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add trade</DialogTitle>
          <DialogDescription>
            Choose an account and record an entry. Set planned SL/TP price levels, and save as Open
            or select which target was hit.
          </DialogDescription>
        </DialogHeader>
        <ManualTradeEntry
          onSaved={(tradeKey) => {
            setOpen(false);
            if (onSaved) onSaved(tradeKey);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
