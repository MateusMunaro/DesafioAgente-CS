import { defineConfig } from "vitest/config";

// Root config: `npm test` delegates to each workspace; this is for ad-hoc `npx vitest` from root.
export default defineConfig({
  test: { projects: ["packages/*", "apps/*"] },
});
