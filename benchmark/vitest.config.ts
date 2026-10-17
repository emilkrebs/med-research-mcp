import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Tests must be offline: anything that would hit PubMed or a model provider is stubbed.
    globals: false,
  },
});
