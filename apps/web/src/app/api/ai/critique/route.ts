import { handler, ok } from "@/server/api";
import { runAi } from "@/server/ai";
import { buildCritiquePromptContext } from "@/server/ai-prompt";

/** Critique one trade: entries, exits, sizing, and the trader's own annotations. */
export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as Record<string, unknown>;
  const { fullPrompt, effectiveSystemPrompt, preview } = buildCritiquePromptContext(
    body as Parameters<typeof buildCritiquePromptContext>[0],
  );

  if (body?.preview === true) {
    return ok({ preview });
  }

  const critique = await runAi(fullPrompt, 1200, effectiveSystemPrompt);
  return ok({ critique });
});
