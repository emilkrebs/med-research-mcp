import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Live NCBI/LLM integration tests are opt-in via env and skipped otherwise.
    globals: false,
  },
});
