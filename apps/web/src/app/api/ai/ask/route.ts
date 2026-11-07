import { handler, ok } from "@/server/api";
import { runAi } from "@/server/ai";
import { buildAskPromptContext } from "@/server/ai-prompt";

/**
 * "Ask your journal" — natural-language questions answered from the trader's
 * own aggregates. The same questions an agent can ask through the MCP tools.
 */
export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as Record<string, unknown>;
  const { scope, fullPrompt, effectiveSystemPrompt, preview } = buildAskPromptContext(
    body as Parameters<typeof buildAskPromptContext>[0],
  );

  if (body?.preview === true) {
    return ok({ preview, scope: scope.scope });
  }

  const answer = await runAi(fullPrompt, 1200, effectiveSystemPrompt);
  return ok({ answer, scope: scope.scope });
});
