import { handler, ok } from "@/server/api";
import { AI_REPLY_TOKENS, runAi } from "@/server/ai";
import { buildRecapPromptContext } from "@/server/ai-prompt";

/** Generate a session recap for one trading day from the day's actual trades. */
export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as Record<string, unknown>;
  const { scope, fullPrompt, effectiveSystemPrompt, preview } = buildRecapPromptContext(
    body as Parameters<typeof buildRecapPromptContext>[0],
  );

  if (body?.preview === true) {
    return ok({ preview, scope: scope.scope });
  }

  const recap = await runAi(fullPrompt, AI_REPLY_TOKENS, effectiveSystemPrompt);
  return ok({ recap, scope: scope.scope });
});
