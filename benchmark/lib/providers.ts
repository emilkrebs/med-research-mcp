/**
 * Turns a `ModelSpec` into an AI SDK `LanguageModel`.
 *
 * Provider packages are imported lazily and cached, so a run that only touches
 * DeepSeek never needs `@ai-sdk/openai` or `@ai-sdk/anthropic` installed — and a
 * missing key or package fails loudly with an actionable message, not a stack trace.
 */

import type { LanguageModel } from "ai";
import type { ModelSpec, Provider } from "./config.js";

type ProviderFactory = (apiKey: string) => (modelId: string) => LanguageModel;

const cache = new Map<Provider, ProviderFactory>();

async function loadProvider(provider: Provider): Promise<ProviderFactory> {
  const cached = cache.get(provider);
  if (cached) return cached;

  let factory: ProviderFactory;
  try {
    switch (provider) {
      case "openai": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        factory = (apiKey) => createOpenAI({ apiKey });
        break;
      }
      case "anthropic": {
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        factory = (apiKey) => createAnthropic({ apiKey });
        break;
      }
      case "deepseek": {
        const { createDeepSeek } = await import("@ai-sdk/deepseek");
        factory = (apiKey) => createDeepSeek({ apiKey });
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
  const factory = await loadProvider(spec.provider);
  return factory(apiKey)(spec.modelId);
}
