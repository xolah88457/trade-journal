import { Button } from "./ui/button";

/** A failed-load message with a retry button. `panel` is the bordered card used by report widgets. */
export function LoadError({
  message,
  onRetry,
  variant = "inline",
}: {
  message: string;
  onRetry: () => void;
  variant?: "inline" | "panel";
}) {
  if (variant === "panel")
    return (
      <div role="alert" className="rounded-xl border p-5">
        <p className="text-sm text-destructive">{message}</p>
        <Button onClick={onRetry} variant="outline" size="sm" className="mt-3">
          Try again
        </Button>
      </div>
    );
  return (
    <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
