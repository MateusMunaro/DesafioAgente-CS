import { pathToFileURL } from "node:url";
import { createApp } from "./http/app.js";
import { createProductionContainer } from "./runtime/container.js";
import { loadConfig } from "./runtime/config.js";

/** Starts the webhook server (POST /webhook/messages, GET /health). */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<{ close(): Promise<void> }> {
  const cfg = loadConfig(env);
  const container = await createProductionContainer(env, cfg);
  const app = createApp({ runtime: container.runtime, logger: container.deps.logger });
  const server = app.listen(cfg.AGENT_PORT, () => {
    container.deps.logger.info({ event: "agent.server.started", port: cfg.AGENT_PORT, llmProvider: cfg.LLM_PROVIDER });
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await container.close();
  };
  const onSignal = (): void => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { close };
}

// Run only when executed directly (tsx src/server.ts or node dist/server.js).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startServer().catch((err: unknown) => {
    console.error("agent failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
