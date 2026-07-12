/**
 * Provider-agnostic LLM adapters over `fetch` (no SDK dependencies).
 *
 * Each provider is reduced to a single call: given a system + user prompt,
 * return the model's text response. The deep-grader parses JSON out of it.
 * `local` targets any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM).
 */

import { errors } from "./errors.js";
import type { LlmConfig, LlmProvider } from "./types.js";

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  local: "llama3.1",
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** Build an LlmConfig from the PUBMED_LLM_* environment variables. */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const provider = env.PUBMED_LLM_PROVIDER as LlmProvider | undefined;
  if (!provider) return null;
  const config: LlmConfig = { provider };
  if (env.PUBMED_LLM_API_KEY) config.apiKey = env.PUBMED_LLM_API_KEY;
  if (env.PUBMED_LLM_MODEL) config.model = env.PUBMED_LLM_MODEL;
  if (env.PUBMED_LLM_BASE_URL) config.baseUrl = env.PUBMED_LLM_BASE_URL;
  return config;
}

/** True when the config can actually reach a model (key present where required). */
export function isLlmUsable(config: LlmConfig | null): config is LlmConfig {
  if (!config) return false;
  if (config.provider === "local") return Boolean(config.baseUrl);
  return Boolean(config.apiKey);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    if (ac.signal.aborted) throw errors.llmTimeout(timeoutMs);
    throw errors.llmUnavailable(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAiCompatible(
  config: LlmConfig,
  system: string,
  user: string,
  baseUrl: string,
  timeoutMs: number,
): Promise<string> {
  const model = config.model ?? DEFAULT_MODELS[config.provider];
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const res = await fetchWithTimeout(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    timeoutMs,
  );
  if (!res.ok) throw errors.llmUnavailable(`provider returned HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw errors.llmUnavailable("provider returned no content");
  return content;
}

async function callAnthropic(
  config: LlmConfig,
  system: string,
  user: string,
  timeoutMs: number,
): Promise<string> {
  const model = config.model ?? DEFAULT_MODELS.anthropic;
  const baseUrl = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      }),
    },
    timeoutMs,
  );
  if (!res.ok) throw errors.llmUnavailable(`provider returned HTTP ${res.status}`);
  const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
  const text = data.content?.find((b) => b.type === "text")?.text ?? data.content?.[0]?.text;
  if (!text) throw errors.llmUnavailable("provider returned no content");
  return text;
}

/** Dispatch to the configured provider and return the raw model text. */
export async function callLlm(config: LlmConfig, system: string, user: string): Promise<string> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (config.provider) {
    case "openai":
      return callOpenAiCompatible(
        config,
        system,
        user,
        config.baseUrl ?? "https://api.openai.com/v1",
        timeoutMs,
      );
    case "local":
      if (!config.baseUrl) throw errors.llmUnavailable("local provider requires PUBMED_LLM_BASE_URL");
      return callOpenAiCompatible(config, system, user, config.baseUrl, timeoutMs);
    case "anthropic":
      return callAnthropic(config, system, user, timeoutMs);
    default: {
      const exhaustive: never = config.provider;
      throw errors.llmUnavailable(`unknown provider: ${String(exhaustive)}`);
    }
  }
}
