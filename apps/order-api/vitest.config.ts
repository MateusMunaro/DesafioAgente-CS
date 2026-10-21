import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Run tests against contracts source, no build needed.
      "@desafio/contracts/fixtures": fileURLToPath(new URL("../../packages/contracts/src/fixtures/customers.ts", import.meta.url)),
      "@desafio/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], passWithNoTests: true, testTimeout: 15000 },
});
