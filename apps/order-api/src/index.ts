import { startServer } from "./server.js";

export const SERVICE_NAME = "order-api";

startServer()
  .then((running) => {
    const shutdown = (): void => {
      running.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
