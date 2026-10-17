/**
 * Turns a `ModelSpec` into an AI SDK `LanguageModel`.
 *
 * Provider packages are imported lazily and cached, so a run that only touches
 * DeepSeek never needs `@ai-sdk/openai` or `@ai-sdk/anthropic` installed — and a
 * missing key or package fails loudly with an actionable message, not a stack trace.
 *
 * When `legacyFunctions:true` is set on a model spec, a custom fetch interceptor
 * maps the `role:"developer"` system message the SDK emits for "reasoning"
 * models back to `role:"system"`, which strict OpenAI-compatible endpoints
 * (DashScope MaaS) require. (The flag keeps its historical name; it no longer
 * rewrites tool results, since this endpoint wants the modern `role:"tool"`.)
 */

import type { LanguageModel } from "ai";
import { missingKeyFor, type ModelSpec, type Provider } from "./config.js";

// ─── Legacy function-calling fetch interceptor ───────────────────────────────

type AnyMsg = { role: string };

/**
 * Returns a `fetch` replacement that maps `role:"developer"` → `role:"system"`
 * before each request is sent. AI SDK v5 emits the system prompt as `developer`
 * for models it classifies as "reasoning" (the Qwen *thinking* models qualify),
 * but strict OpenAI-*compatible* endpoints (Alibaba MaaS, etc.) only allow
 * system/assistant/user/tool/function and 400 on `developer`.
 *
 * Tool-result messages are deliberately left as `role:"tool"`: this endpoint
 * accepts the modern format, and some models (e.g. qwen-max) *reject* the legacy
 * `role:"function"` rewrite ("tool_calls must be followed by tool messages").
 * Only touches requests that actually carry a `developer` role.
 */
function makeCompatRoleFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as { messages?: AnyMsg[] };
        const messages = body.messages;
        if (Array.isArray(messages) && messages.some((m) => m.role === "developer")) {
          body.messages = messages.map((m) => (m.role === "developer" ? { ...m, role: "system" } : m));
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        /* JSON parse error — send as-is */
      }
    }
    return globalThis.fetch(input, init);
  };
}

// ─── Provider factory ─────────────────────────────────────────────────────────

type ProviderFactory = (apiKey: string, baseURL?: string, customFetch?: typeof fetch) => (modelId: string) => LanguageModel;

const cache = new Map<Provider, ProviderFactory>();

async function loadProvider(provider: Provider): Promise<ProviderFactory> {
  const cached = cache.get(provider);
  if (cached) return cached;

  let factory: ProviderFactory;
  try {
    switch (provider) {
      case "openai": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        factory = (apiKey, baseURL, customFetch) => {
          const provider = createOpenAI({
            apiKey,
            ...(baseURL ? { baseURL } : {}),
            ...(customFetch ? { fetch: customFetch } : {}),
          });
          // Use Chat Completions, not the default Responses API. The Responses
          // API is OpenAI-proprietary; OpenAI-*compatible* endpoints (DashScope
          // MaaS, Ollama, most third parties) only implement /chat/completions,
          // and hitting /responses makes them 400 on tool calls (and leaves the
          // message array empty, so the legacyFunctions interceptor never fires).
          return (modelId) => provider.chat(modelId);
        };
        break;
      }
      case "anthropic": {
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        factory = (apiKey, baseURL) => createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
        break;
      }
      case "deepseek": {
        const { createDeepSeek } = await import("@ai-sdk/deepseek");
        factory = (apiKey, baseURL) => createDeepSeek({ apiKey, ...(baseURL ? { baseURL } : {}) });
        break;
      }
      case "ollama": {
        // Ollama has an OpenAI-compatible API at http://localhost:11434/v1
        const { createOpenAI } = await import("@ai-sdk/openai");
        factory = (apiKey, baseURL) => {
          const provider = createOpenAI({
            apiKey: apiKey || "ollama",
            ...(baseURL ? { baseURL } : { baseURL: "http://localhost:11434/v1" }),
          });
          // Chat Completions, not Responses — Ollama only implements the former.
          return (modelId) => provider.chat(modelId);
        };
        break;
      }
      default: {
        const exhaustive: never = provider;
        throw new Error(`Unknown provider: ${String(exhaustive)}`);
      }
    }
  } catch (err) {
    throw new Error(
      `Could not load the AI SDK provider "${provider}". Install it in benchmark/ ` +
        `(e.g. \`npm i @ai-sdk/${provider}\`). Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cache.set(provider, factory);
  return factory;
}

/** Resolve a model spec to a live model handle, reading its API key from env. */
export async function resolveModel(spec: ModelSpec): Promise<LanguageModel> {
  const missing = missingKeyFor(spec);
  if (missing) {
    throw new Error(`Missing API key: set ${missing} to run model "${spec.label}" (${spec.provider}/${spec.modelId}).`);
  }
  // Only ollama can reach here without a key (local server); the factory defaults it.
  const apiKey = process.env[spec.apiKeyEnv] ?? "";
  const baseURL = spec.baseUrlEnv ? process.env[spec.baseUrlEnv] : undefined;
  const factory = await loadProvider(spec.provider);
  return factory(apiKey, baseURL, spec.legacyFunctions ? makeCompatRoleFetch() : undefined)(spec.modelId);
}

