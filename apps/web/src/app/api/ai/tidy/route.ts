import { RequestError, handler, ok } from "@/server/api";
import { runAi } from "@/server/ai";
import { buildTidyPromptContext, cleanTidyOutput } from "@/server/ai-prompt";

/** Rewrite one note, usually dictated, into cleaner and better-structured writing. */
export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as Parameters<typeof buildTidyPromptContext>[0];
  const { text, fullPrompt, effectiveSystemPrompt, preview } = buildTidyPromptContext(body);

  if (body?.preview === true) return ok({ preview });

  // Room for the rewrite and any reasoning: about two tokens per three characters of note.
  const maxOutputTokens = Math.min(8000, Math.max(1500, Math.ceil(text.length / 1.5)));
  const tidied = cleanTidyOutput(await runAi(fullPrompt, maxOutputTokens, effectiveSystemPrompt));
  if (!tidied) throw new RequestError("The AI returned an empty note. Try again.");
  return ok({ text: tidied });
});
