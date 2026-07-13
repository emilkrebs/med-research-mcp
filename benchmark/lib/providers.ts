/**
 * Turns a `ModelSpec` into an AI SDK `LanguageModel`.
 *
 * Provider packages are imported lazily and cached, so a run that only touches
 * DeepSeek never needs `@ai-sdk/openai` or `@ai-sdk/anthropic` installed — and a
 * missing key or package fails loudly with an actionable message, not a stack trace.
 *
 * When `compatibility:"compatible"` is set on a model spec, a custom fetch
 * interceptor rewrites `role:"tool"` result messages to the legacy
 * `role:"function"` format required by endpoints like DashScope MaaS that don't
 * fully implement the newer OpenAI tool-calling spec.
 */

import type { LanguageModel } from "ai";
import type { ModelSpec, Provider } from "./config.js";

// ─── Legacy function-calling fetch interceptor ───────────────────────────────

type AnyMsg = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string } }>;
};

/**
 * Returns a `fetch` replacement that transforms tool-result messages
 * (`role:"tool"`) into legacy function-result messages (`role:"function"`)
 * before each request is sent.  The function name is recovered from the
 * preceding assistant message's `tool_calls` list.
 */
function makeLegacyFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as { messages?: AnyMsg[] };
        if (body.messages?.some((m) => m.role === "tool")) {
          // Build tool_call_id → function name from preceding assistant turns.
          const nameById = new Map<string, string>();
          for (const msg of body.messages) {
            if (msg.role === "assistant" && msg.tool_calls) {
              for (const tc of msg.tool_calls) nameById.set(tc.id, tc.function.name);
            }
          }
          body.messages = body.messages.map((msg) => {
            if (msg.role !== "tool") return msg;
            return {
              role: "function",
              name: (msg.tool_call_id ? nameById.get(msg.tool_call_id) : undefined) ?? "tool",
              content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
            };
          });
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

type ProviderFactory = (apiKey: string, baseURL?: string, compatibility?: "strict" | "compatible") => (modelId: string) => LanguageModel;

const cache = new Map<Provider, ProviderFactory>();

async function loadProvider(provider: Provider): Promise<ProviderFactory> {
  const cached = cache.get(provider);
  if (cached) return cached;

  let factory: ProviderFactory;
  try {
    switch (provider) {
      case "openai": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        factory = (apiKey, baseURL, compatibility) =>
          createOpenAI({
            apiKey,
            ...(baseURL ? { baseURL } : {}),
            ...(compatibility ? { compatibility } : {}),
            ...(compatibility === "compatible" ? { fetch: makeLegacyFetch() } : {}),
          });
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
  const apiKey = process.env[spec.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing API key: set ${spec.apiKeyEnv} to run model "${spec.label}" (${spec.provider}/${spec.modelId}).`);
  }
  const baseURL = spec.baseUrlEnv ? process.env[spec.baseUrlEnv] : undefined;
  const factory = await loadProvider(spec.provider);
  return factory(apiKey, baseURL, spec.compatibility)(spec.modelId);
}

