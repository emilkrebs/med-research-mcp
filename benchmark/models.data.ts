/**
 * Model catalog for the med-research-mcp benchmark. Edit this array to add or
 * remove models; `tsc` checks each entry against `ModelSpec`. `provider` is one
 * of: openai, anthropic, deepseek, ollama.
 *
 * Only entries without `enabled: false` run by default (`DEFAULT_MODELS`); the
 * rest are kept for reproducibility and are still selectable with
 * `--models <label>`. Set `legacyFunctions: true` for OpenAI-compatible
 * endpoints (e.g. DashScope MaaS) that reject the `role:"developer"` system
 * message the SDK emits for reasoning models — it maps `developer` → `system`
 * (tool results stay `role:"tool"`). Set `unpinned: true` on moving aliases.
 */

import type { ModelSpec } from "./lib/config.js";

export const MODELS: ModelSpec[] = [
  // ── Alibaba Cloud Model Studio, Singapore (international) endpoint ──
  // Both use the DashScope OpenAI-compatible API; the key is separate from the
  // generic OPENAI_* vars so it can't collide with another OpenAI-compatible provider.
  {
    label: "deepseek-v4.1-flash",
    provider: "openai",
    modelId: "deepseek-v4.1-flash",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3.8-flash",
    provider: "openai",
    modelId: "qwen3.8-flash",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3.8-27b",
    provider: "openai",
    modelId: "qwen3.8-27b",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3.7-flash-2026-07-15",
    provider: "openai",
    modelId: "qwen3.7-flash-2026-07-15",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "deepseek-v4-flash-0731",
    provider: "openai",
    modelId: "deepseek-v4-flash-0731",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    legacyFunctions: true,
  },
  // ── Fresh quota — different provider / untouched model IDs ────────
  {
    // WARNING: Ollama's default context window is 4096 tokens and its OpenAI-compatible API cannot
    // raise it per request. Long tool results then silently push the start of the conversation out
    // of the window and the model answers a question it never saw (the run is flagged
    // `contextTruncated` and scored `truncated`). Start the server with
    // `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` (or larger) or results are invalid.
    label: "gemma4-4b",
    provider: "ollama",
    modelId: "gemma4:latest",
    unpinned: true,
    apiKeyEnv: "OLLAMA_API_KEY",
    baseUrlEnv: "OLLAMA_BASE_URL",
    legacyFunctions: false,
  },
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
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3.5-397b-a17b",
    provider: "openai",
    modelId: "qwen3.5-397b-a17b",
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  // ── Mid-range fallbacks ──────────────────────────────────────────
  {
    label: "qwen3.5-35b-a3b",
    provider: "openai",
    modelId: "qwen3.5-35b-a3b",
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3.6-27b",
    provider: "openai",
    modelId: "qwen3.6-27b",
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  // ── Fast / small fallbacks ───────────────────────────────────────
  {
    label: "qwen3.5-flash",
    provider: "openai",
    modelId: "qwen3.5-flash",
    unpinned: true,
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  // ── Previously used (kept for reproducibility) ───────────────────
  {
    label: "qwen3-30b-a3b-thinking-2507",
    provider: "openai",
    modelId: "qwen3-30b-a3b-thinking-2507",
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true, // thinking model → needs the developer→system role fixup
  },
  {
    label: "deepseek-v4-flash",
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    enabled: false,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    legacyFunctions: false,
  },
  {
    label: "qwen3-235b-a22b-thinking-2507",
    provider: "openai",
    modelId: "qwen3-235b-a22b-thinking-2507",
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen-max",
    provider: "openai",
    modelId: "qwen-max",
    unpinned: true,
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
  {
    label: "qwen3-32b",
    provider: "openai",
    modelId: "qwen3-32b",
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    legacyFunctions: true,
  },
];
