import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, RetryError, generateText } from "ai";
import {
  aiProviderConfigured,
  getAiKey,
  getAiModel,
  getAiProvider,
  getCompatibleBaseUrl,
  getAiInstructions,
} from "./settings";
import { AI_PROVIDER_NAMES, type AiProvider } from "@/lib/ai-settings";
import { BASE_AI_SYSTEM, buildAiSystemPrompt } from "./ai-prompt";

/**
 * BYO-key AI. Self-hosted means YOUR key on YOUR box: the key is read from the
 * encrypted settings store (or the selected provider's environment variable).
 * Requests go straight from this server to the selected provider.
 */
export const aiConfigured = (): boolean => aiProviderConfigured(getAiProvider());

export const languageModel = (provider: AiProvider, apiKey: string | null, model: string) => {
  if (provider === "compatible")
    // Chat Completions is the API compatible servers share. Only the key saved for
    // this server is sent: this adapter never reads provider environment variables.
    return createOpenAICompatible({
      name: "compatible",
      baseURL: getCompatibleBaseUrl()!,
      apiKey: apiKey ?? undefined,
    })(model);
  return provider === "openai"
    ? createOpenAI({ apiKey: apiKey! }).responses(model)
    : createAnthropic({ apiKey: apiKey! })(model);
};

/** OpenAI Responses requests must opt out of server-side storage. */
export const providerOptions = (provider: AiProvider) =>
  provider === "openai" ? { providerOptions: { openai: { store: false } } } : {};

/**
 * Output budget for short coaching replies. The prompts ask for 150-200 words, but reasoning models
 * spend their hidden reasoning from the same budget, and 1,200 tokens could run out before any text.
 */
export const AI_REPLY_TOKENS = 2500;

export const runAi = async (
  prompt: string,
  maxOutputTokens = 1200,
  systemPrompt?: string,
): Promise<string> => {
  const provider = getAiProvider();
  if (!aiProviderConfigured(provider)) {
    throw new Error(
      provider === "compatible"
        ? "AI is not configured — add your OpenAI-compatible server URL and model in Settings."
        : `AI is not configured — add your ${AI_PROVIDER_NAMES[provider]} API key in Settings.`,
    );
  }
  const system = systemPrompt ?? buildAiSystemPrompt(getAiInstructions());
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model: languageModel(provider, getAiKey(provider), getAiModel(provider)),
      ...providerOptions(provider),
      system,
      prompt,
      maxOutputTokens,
    });
  } catch (error) {
    if (RetryError.isInstance(error)) error = error.lastError;
    // Provider error messages can contain key fragments or request data. Never relay them.
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 401 || error.statusCode === 403)
        throw new Error(
          "AI authentication_error: check your provider key and permissions in Settings.",
        );
      if (
        /credit balance|billing|insufficient_quota|exceeded your current quota/i.test(error.message)
      )
        throw new Error("AI billing: check your provider account's credits and quota.");
      if (error.statusCode === 429 || error.statusCode === 529)
        throw new Error("AI rate limit: please try again shortly.");
      if (
        error.statusCode === 404 ||
        /model.*(?:not found|does not exist|access)/i.test(error.message)
      )
        throw new Error(
          "AI model unavailable: check the model ID and your provider access in Settings.",
        );
      if (
        /context length|context window|context_length|maximum.*tokens|max_tokens|max_completion_tokens/i.test(
          error.message,
        )
      )
        throw new Error(
          "AI context too small: this model can't fit the request and its reply. Choose a model with a larger context window in Settings.",
        );
      // No status code means no HTTP response: the server is down or the URL is wrong.
      if (provider === "compatible" && error.statusCode === undefined)
        throw new Error(
          "AI server unreachable: check the server URL in Settings and that the server is running.",
        );
    }
    throw new Error("AI request failed. Check your provider settings or try again shortly.");
  }
  if (!result.text.trim())
    throw new Error(
      result.finishReason === "length"
        ? "AI returned no text: the model used its whole reply budget, usually on hidden reasoning, before answering. Try again or choose a non-reasoning model in Settings."
        : "AI returned no text. Check the model or try again.",
    );
  return result.text;
};
