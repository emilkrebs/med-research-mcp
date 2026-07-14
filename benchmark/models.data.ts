/**
 * Model catalog for the med-research-mcp benchmark. Edit this array to add or
 * remove models; `tsc` checks each entry against `ModelSpec`. `provider` is one
 * of: openai, anthropic, deepseek, ollama. Set `legacyFunctions: true` for
 * OpenAI-compatible endpoints (e.g. DashScope MaaS) that expect the legacy
 * `role:"function"` tool-result format instead of `role:"tool"`.
 */

import type { ModelSpec } from "./lib/config.js";

export const MODELS: ModelSpec[] = [
  // {
  //   label: "qwen3.5-27b",
  //   provider: "openai",
  //   modelId: "qwen3.5-27b",
  //   apiKeyEnv: "OPENAI_API_KEY",
  //   baseUrlEnv: "OPENAI_BASE_URL",
  //   legacyFunctions: true,
  // },
  // {
  //   label: "qwen3.5-122b",
  //   provider: "openai",
  //   modelId: "qwen3.5-122b-a10b",
  //   apiKeyEnv: "OPENAI_API_KEY",
  //   baseUrlEnv: "OPENAI_BASE_URL",
  //   legacyFunctions: true,
  // },
  {
    // Was "qwen3-vl-30b-a3b-thinking" — an id not deployed on this MaaS endpoint
    // (100% "Unsupported model"). Swapped to the valid text thinking model that
    // the broken id appears to have conflated (a vision model is a poor fit for
    // this text benchmark). `legacyFunctions: true` is required: it drives the
    // developer→system role fixup these thinking models need on the endpoint.
    label: "qwen3-30b-a3b-thinking-2507",
    provider: "openai",
    modelId: "qwen3-30b-a3b-thinking-2507",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "deepseek-v4-flash",
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    legacyFunctions: false,
  },
  {
    label: "qwen3-235b-a22b-thinking-2507",
    provider: "openai",
    modelId: "qwen3-235b-a22b-thinking-2507",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true, // thinking model → needs the developer→system role fixup
  },
  {
    // Every openai-provider model on this MaaS endpoint gets the `developer`
    // system role from the SDK and needs the developer→system fixup, so
    // legacyFunctions stays ON. (It no longer rewrites tool results, so qwen-max's
    // requirement for the modern `role:"tool"` format is preserved.)
    label: "qwen-max",
    provider: "openai",
    modelId: "qwen-max",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3-32b",
    provider: "openai",
    modelId: "qwen3-32b",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  // {
  //   label: "qwen3-vl-235b-a22b-thinking",
  //   provider: "openai",
  //   modelId: "qwen3-vl-235b-a22b-thinking",
  //   apiKeyEnv: "OPENAI_API_KEY",
  //   baseUrlEnv: "OPENAI_BASE_URL",
  //   legacyFunctions: true,
  // },
];
