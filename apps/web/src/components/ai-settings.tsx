"use client";

import { useEffect, useRef, useState } from "react";
import {
  AI_DEFAULT_MODELS,
  AI_INSTRUCTIONS_MAX_LENGTH,
  AI_KEY_VARIABLES,
  AI_PROVIDER_NAMES,
  AI_PROVIDERS,
  FREE_AI_SERVICES,
  type AiProvider,
  type AiSettingsPayload,
} from "@/lib/ai-settings";
import { postJson, useApi } from "@/lib/use-api";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { OptionSelect } from "./ui/option-select";
import { Textarea } from "./ui/textarea";
import { VoiceNote } from "./voice-note";

export function AiSettings() {
  const { data, error, loading, refresh } = useApi<AiSettingsPayload>("/api/settings");
  const [provider, setProvider] = useState<AiProvider>("anthropic");
  const [model, setModel] = useState(AI_DEFAULT_MODELS.anthropic);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (!data) return;
    setProvider(data.aiProvider);
    setModel(data.aiModel);
    setBaseUrl(data.aiConnections.compatible.baseUrl ?? "");
    setInstructions(data.aiInstructions ?? "");
  }, [data]);

  const connection = data?.aiConnections[provider];
  const environment = connection?.source === "environment";
  const compatible = provider === "compatible";
  const freeService = compatible
    ? FREE_AI_SERVICES.find((service) => baseUrl.trim().replace(/\/+$/, "") === service.baseUrl)
    : undefined;
  const name = AI_PROVIDER_NAMES[provider];
  const disabled = busy || loading || !data;
  const keyHint = environment
    ? `Using ${AI_KEY_VARIABLES[provider]} from the server environment. Change or remove that variable on the server to update the key.`
    : compatible
      ? connection?.source === "saved"
        ? "Leave blank to keep your saved key. Saving a different server URL removes it."
        : freeService
          ? `Required for ${freeService.name}: paste the key you created on its site.`
          : "Only needed if your server requires one."
      : connection?.configured
        ? "Leave blank to keep your saved key, or enter a replacement."
        : "Add your API key, then save to use this provider.";

  const applyFreeService = (service: (typeof FREE_AI_SERVICES)[number]) => {
    setProvider("compatible");
    setBaseUrl(service.baseUrl);
    setModel(service.model);
    setApiKey("");
    setFailure("");
    setSaved(
      `${service.name} filled in. Paste your ${service.name} API key into the key field, then save.`,
    );
  };

  const save = async (remove = false) => {
    setBusy(true);
    setFailure("");
    setSaved("");
    try {
      await postJson(
        "/api/settings",
        remove
          ? {
              [`${provider}Key`]: null,
            }
          : {
              aiProvider: provider,
              aiModel: model.trim(),
              aiInstructions: instructions.trim(),
              ...(compatible ? { compatibleBaseUrl: baseUrl.trim() } : {}),
              ...(apiKey.trim() ? { [`${provider}Key`]: apiKey.trim() } : {}),
            },
        "PATCH",
      );
      setApiKey("");
      setSaved(remove ? `${name} key removed.` : `${name} settings saved.`);
      refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Couldn’t save AI settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="ai-settings" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>AI (bring your own key)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Use Anthropic, OpenAI, or an OpenAI-compatible server such as Ollama, LM Studio,
          OpenRouter or Groq for recaps, trade critiques, and “ask your journal”. Your key is
          encrypted at rest. AI requests go from your server directly to the provider you select.
        </p>
        <section
          aria-labelledby="ai-free-heading"
          className="space-y-2 rounded-md border bg-muted/40 p-3"
        >
          <h3 id="ai-free-heading" className="text-sm font-medium">
            Start free: no API fees
          </h3>
          <p className="text-xs text-muted-foreground">
            OpenRouter and Groq give free API keys with free models. Create a key, choose{" "}
            <span className="font-medium text-foreground">Use</span> below to fill in the server and
            model, paste the key, and save.
          </p>
          <ul className="space-y-2">
            {FREE_AI_SERVICES.map((service) => (
              <li
                key={service.name}
                className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 space-y-0.5 text-xs">
                  <p>
                    <span className="font-medium">{service.name}</span>{" "}
                    <span className="text-muted-foreground">
                      · model <code className="break-all">{service.model}</code>
                    </span>
                  </p>
                  <p className="text-muted-foreground">{service.about}</p>
                  <p className="flex flex-wrap gap-x-3">
                    <a
                      className="underline underline-offset-2"
                      href={service.keysUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Get a free {service.name} key
                    </a>
                    <a
                      className="underline underline-offset-2"
                      href={service.modelsUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Free models
                    </a>
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0 self-start"
                  disabled={disabled}
                  aria-label={`Use ${service.name} settings`}
                  onClick={() => applyFreeService(service)}
                >
                  Use {service.name}
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Free plans have request limits and the free model lineup changes over time. Free models
            may log prompts or use them for training, and prompts include your journal data. If
            OpenRouter finds no free endpoint, check the data policy options in its privacy
            settings.
          </p>
        </section>
        {data && (
          <p className="text-xs text-muted-foreground">
            Active provider: {AI_PROVIDER_NAMES[data.aiProvider]} ·{" "}
            {data.aiConfigured
              ? data.aiProvider === "compatible"
                ? "Server configured"
                : "Key configured"
              : "Not configured"}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ai-provider">Provider</Label>
            <OptionSelect
              id="ai-provider"
              value={provider}
              disabled={disabled}
              onValueChange={(value) => {
                const next = value as AiProvider;
                setProvider(next);
                setModel(data?.aiConnections[next].model ?? AI_DEFAULT_MODELS[next]);
                setApiKey("");
                setSaved("");
                setFailure("");
              }}
            >
              {AI_PROVIDERS.map((id) => (
                <option key={id} value={id}>
                  {AI_PROVIDER_NAMES[id]}
                </option>
              ))}
            </OptionSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-model">Model ID</Label>
            <Input
              id="ai-model"
              value={model}
              disabled={disabled}
              placeholder={compatible ? "e.g. llama3.1:8b" : AI_DEFAULT_MODELS[provider]}
              onChange={(event) => {
                setModel(event.target.value);
                setSaved("");
              }}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Use a text model available to your provider account or server. Each provider keeps its own
          model and key.
        </p>
        {compatible && (
          <div className="space-y-1">
            <Label htmlFor="ai-base-url">Server URL</Label>
            <Input
              id="ai-base-url"
              type="url"
              value={baseUrl}
              disabled={disabled}
              placeholder="http://localhost:11434/v1"
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setSaved("");
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              The API root your server documents, usually ending in /v1, such as
              http://localhost:11434/v1 for Ollama or https://openrouter.ai/api/v1. It must be
              reachable from the machine running the journal.
            </p>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="ai-api-key">
            {freeService
              ? `${freeService.name} API key`
              : compatible
                ? "API key (optional)"
                : `${name} API key`}
          </Label>
          <Input
            id="ai-api-key"
            type="password"
            value={apiKey}
            disabled={disabled || environment}
            onChange={(event) => {
              setApiKey(event.target.value);
              setSaved("");
            }}
            placeholder={
              connection?.source
                ? "Key configured"
                : freeService
                  ? `Your ${freeService.name} key`
                  : compatible
                    ? "Optional"
                    : provider === "anthropic"
                      ? "sk-ant-…"
                      : "sk-…"
            }
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{keyHint}</p>
        </div>
        <div className="space-y-1.5 pt-2 border-t">
          <div className="flex items-center justify-between">
            <Label htmlFor="ai-instructions">Personal trading instructions (optional)</Label>
            <div className="flex items-center gap-2">
              <VoiceNote
                targetRef={instructionsRef}
                onText={(text) => {
                  if (text.length > AI_INSTRUCTIONS_MAX_LENGTH) {
                    if (instructionsRef.current) {
                      instructionsRef.current.value = instructions;
                    }
                    setFailure(
                      `Would exceed ${AI_INSTRUCTIONS_MAX_LENGTH}; existing instructions unchanged.`,
                    );
                  } else {
                    setInstructions(text);
                    setFailure("");
                  }
                  setSaved("");
                }}
              />
              <span
                className={`text-xs tabular-nums ${instructions.length > AI_INSTRUCTIONS_MAX_LENGTH ? "text-destructive" : "text-muted-foreground"}`}
              >
                {instructions.length}/{AI_INSTRUCTIONS_MAX_LENGTH}
              </span>
            </div>
          </div>
          <Textarea
            ref={instructionsRef}
            id="ai-instructions"
            value={instructions}
            disabled={disabled}
            maxLength={AI_INSTRUCTIONS_MAX_LENGTH}
            rows={4}
            placeholder="e.g. Focus on disciplined risk management. I primarily trade liquidity sweeps on 5m charts. Flag when I move stops early or revenge trade after losses."
            onChange={(event) => {
              setInstructions(event.target.value);
              setSaved("");
            }}
          />
          <p className="text-xs text-muted-foreground">
            Custom rules and guidance included in recaps, trade critiques, and “ask your journal”.
            Grounding in your recorded data always takes precedence over instructions.
          </p>
        </div>
        {(error || failure) && (
          <p role="alert" className="text-xs text-destructive">
            {failure || error}
          </p>
        )}
        {saved && (
          <p role="status" className="text-xs text-profit">
            {saved}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              disabled ||
              !model.trim() ||
              instructions.length > AI_INSTRUCTIONS_MAX_LENGTH ||
              (compatible ? !baseUrl.trim() : !apiKey.trim() && !connection?.configured)
            }
            onClick={() => save()}
          >
            {busy ? "Saving…" : "Save AI settings"}
          </Button>
          {connection?.source === "saved" && (
            <Button variant="outline" disabled={disabled} onClick={() => save(true)}>
              Remove {name} key
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
