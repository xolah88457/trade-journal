import { bad, handler, ok } from "@/server/api";
import { AI_REPLY_TOKENS, runAi } from "@/server/ai";
import { buildCritiquePromptContext } from "@/server/ai-prompt";
import { getTradeByKey } from "@/server/trades-query";
import {
  appendTradeAiReview,
  listTradeAiReviews,
  TradeNotFoundError,
} from "@/server/ai-review-history";

/**
 * Retrieve saved critique history for a single trade.
 * Validates trade existence strictly and makes zero AI calls.
 */
export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key || typeof key !== "string" || !key.trim()) {
    return bad("Trade key is required.", 400);
  }

  const tradeKey = key.trim();
  const trade = getTradeByKey(tradeKey);
  if (!trade) {
    return bad("Trade not found", 404);
  }

  const reviews = listTradeAiReviews(tradeKey);
  return ok({
    reviews,
    critique: reviews.length > 0 ? (reviews[reviews.length - 1]?.content ?? null) : null,
  });
});

/** Critique one trade: entries, exits, sizing, and the trader's own annotations. */
export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as Record<string, unknown>;
  const { fullPrompt, effectiveSystemPrompt, preview } = buildCritiquePromptContext(
    body as Parameters<typeof buildCritiquePromptContext>[0],
  );

  if (body?.preview === true) {
    return ok({ preview });
  }

  const critique = await runAi(fullPrompt, AI_REPLY_TOKENS, effectiveSystemPrompt);
  const tradeKey = (body.key as string).trim();

  try {
    const review = appendTradeAiReview(
      tradeKey,
      {
        content: critique,
        provider: preview.provider,
        model: preview.model,
      },
      { requireTradeExists: true },
    );

    return ok({
      critique,
      review,
      reviews: listTradeAiReviews(tradeKey),
    });
  } catch (error) {
    if (error instanceof TradeNotFoundError) {
      return bad("Trade not found", 404);
    }
    throw error;
  }
});
