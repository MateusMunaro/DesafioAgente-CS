import type { Server } from "node:http";
import pg from "pg";
import { loadConfig, type Config } from "./config.js";
import { createApp } from "./http/app.js";
import { runMigrations, runSeed } from "./infra/db/migrate.js";
import { createLogger } from "./infra/logger.js";
import { PgOrderRepository } from "./infra/pg-order-repository.js";

export { createApp } from "./http/app.js";
export type { AppDeps } from "./http/app.js";

export interface RunningServer {
  server: Server;
  close(): Promise<void>;
}

/** Production wiring: config -> pool -> repository -> app -> listen. */
export async function startServer(config: Config = loadConfig()): Promise<RunningServer> {
  const logger = createLogger({ level: config.LOG_LEVEL });
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  // An idle client dropping must not crash the process; the next query reports the failure.
  pool.on("error", (err) => logger.error({ event: "order.db.pool_error", errorCode: (err as { code?: string }).code }));

  if (config.AUTO_MIGRATE) {
    const applied = await runMigrations(pool);
    logger.info({ event: "order.db.migrated", applied });
  }
  if (config.AUTO_SEED) {
    await runSeed(pool);
    logger.info({ event: "order.db.seeded" });
  }

  const app = createApp({ repository: new PgOrderRepository(pool), logger, apiToken: config.ORDER_API_TOKEN });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(config.ORDER_API_PORT, () => resolve(s));
  });
  logger.info({ event: "order.server.started", port: config.ORDER_API_PORT });

  return {
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await pool.end();
    },
  };
}
