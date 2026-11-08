export const AI_PROVIDERS = ["anthropic", "openai", "compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** OpenAI-compatible servers host different models, so that provider has no default. */
export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-4.1-mini",
  compatible: "",
};

export const AI_PROVIDER_NAMES: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  compatible: "OpenAI-compatible",
};

/** Hosted providers only: a compatible server never receives an environment key. */
export const AI_KEY_VARIABLES: Partial<Record<AiProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export const AI_INSTRUCTIONS_MAX_LENGTH = 2000;

/**
 * Hosted OpenAI-compatible services with a free tier, offered as one-click setups
 * for people who do not want to pay for API usage. Free model lineups rotate, so
 * each entry also links the provider's own model list.
 */
export const FREE_AI_SERVICES = [
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    keysUrl: "https://openrouter.ai/keys",
    modelsUrl: "https://openrouter.ai/models?max_price=0",
    about:
      "openrouter/free picks an available free model for each request. You can also enter any model ID ending in :free. Free models have a daily request limit.",
  },
  {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    keysUrl: "https://console.groq.com/keys",
    modelsUrl: "https://console.groq.com/docs/models",
    about:
      "Fast responses on a free, rate-limited plan. Any production model in Groq's list works.",
  },
] as const;

export interface AiConnection {
  configured: boolean;
  source: "environment" | "saved" | null;
  model: string;
  /** Server URL of the OpenAI-compatible provider; null for hosted providers. */
  baseUrl: string | null;
}

export interface AiSettingsPayload {
  aiProvider: AiProvider;
  aiConfigured: boolean;
  aiModel: string;
  aiConnections: Record<AiProvider, AiConnection>;
  aiInstructions: string;
}

export const isAiProvider = (value: unknown): value is AiProvider =>
  typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
