"use client";
import { Download, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** "Export PDF" / "Export PNG" row shared by the report and review exporters. */
export function ExportButtons({
  disabled,
  concealed,
  onExport,
}: {
  disabled: boolean;
  /** Privacy mode hides financial figures, so exporting them is blocked. */
  concealed: boolean;
  onExport: (format: "pdf" | "png") => void;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || concealed}
          onClick={() => onExport("pdf")}
        >
          <Download />
          Export PDF
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || concealed}
          onClick={() => onExport("png")}
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
    </>
  );
}
