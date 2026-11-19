import { defineConfig } from "vitest/config";

// Server tests run in plain Node (no workerd). The Worker tests live in vitest.config.ts.
export default defineConfig({
  test: { include: ["test/node/**/*.test.ts"], environment: "node", testTimeout: 60_000, hookTimeout: 60_000 },
});
