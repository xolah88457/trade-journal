type HitTarget = "stop_loss" | "profit_target" | null;

/**
 * Determine which planned target (if any) was hit on trade exit.
 * Returns null if trade is open, exit price is missing, no targets are hit,
 * or if roundoff proximity to both plans results in an ambiguous tie.
 */
export function hitTradeTarget(
  status: string | null | undefined,
  avgExit: number | null | undefined,
  stopLoss: number | null | undefined,
  profitTarget: number | null | undefined,
): HitTarget {
  if (status === "open" || avgExit == null) return null;

  const hasSl = stopLoss != null;
  const hasTp = profitTarget != null;
  if (!hasSl && !hasTp) return null;

  const slDist = hasSl ? Math.abs(avgExit - stopLoss) : Infinity;
  const tpDist = hasTp ? Math.abs(avgExit - profitTarget) : Infinity;

  const slTol = hasSl ? Number.EPSILON * 8 * Math.max(Math.abs(avgExit), Math.abs(stopLoss)) : 0;
  const tpTol = hasTp
    ? Number.EPSILON * 8 * Math.max(Math.abs(avgExit), Math.abs(profitTarget))
    : 0;

  const slNear = hasSl && slDist <= slTol;
  const tpNear = hasTp && tpDist <= tpTol;

  if (slNear && tpNear) {
    if (slDist < tpDist) return "stop_loss";
    if (tpDist < slDist) return "profit_target";
    return null;
  }
  if (slNear) return "stop_loss";
  if (tpNear) return "profit_target";

  return null;
}
