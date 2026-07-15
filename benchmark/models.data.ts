/**
 * Model catalog for the med-research-mcp benchmark. Edit this array to add or
 * remove models; `tsc` checks each entry against `ModelSpec`. `provider` is one
 * of: openai, anthropic, deepseek, ollama. Set `legacyFunctions: true` for
 * OpenAI-compatible endpoints (e.g. DashScope MaaS) that expect the legacy
 * `role:"function"` tool-result format instead of `role:"tool"`.
 */

import type { ModelSpec } from "./lib/config.js";

export const MODELS: ModelSpec[] = [
  // ── Fresh quota — different provider / untouched model IDs ────────
  {
    label: "deepseek-v3.2",
    provider: "openai",
    modelId: "deepseek-v3.2",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3-max-2025-09-23",
    provider: "openai",
    modelId: "qwen3-max-2025-09-23",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen-plus-2025-09-11",
    provider: "openai",
    modelId: "qwen-plus-2025-09-11",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  // ── Free-tier flagships (quota likely exhausted) ──────────────────
  {
    label: "qwen3.5-122b-a10b",
    provider: "openai",
    modelId: "qwen3.5-122b-a10b",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3.5-397b-a17b",
    provider: "openai",
    modelId: "qwen3.5-397b-a17b",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  // ── Mid-range fallbacks ──────────────────────────────────────────
  {
    label: "qwen3.5-35b-a3b",
    provider: "openai",
    modelId: "qwen3.5-35b-a3b",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3.6-27b",
    provider: "openai",
    modelId: "qwen3.6-27b",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  // ── Fast / small fallbacks ───────────────────────────────────────
  {
    label: "qwen3.5-flash",
    provider: "openai",
    modelId: "qwen3.5-flash",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  // ── Previously used (kept for reproducibility) ───────────────────
  {
    label: "qwen3-30b-a3b-thinking-2507",
    provider: "openai",
    modelId: "qwen3-30b-a3b-thinking-2507",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true, // thinking model → needs the developer→system role fixup
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
    legacyFunctions: true,
  },
  {
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
];
