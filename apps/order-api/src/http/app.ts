import express, { type Express, type Request, type Response } from "express";
import type { Logger } from "pino";
import { OrderService } from "../application/order-service.js";
import { TechnicalError } from "../domain/errors.js";
import type { OrderRepository } from "../domain/order-repository.js";
import { docsHandlers } from "./docs.js";
import { getContext, sendSuccess } from "./envelope.js";
import { bearerAuth } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestContext } from "./middleware/request-context.js";
import { OrdersController } from "./orders-controller.js";

export interface AppDeps {
  repository: OrderRepository;
  logger: Logger;
  /** Expected Bearer token (ORDER_API_TOKEN). Required on every route except /health and /docs. */
  apiToken: string;
}

/** App factory: no listening, no environment access, so tests can build it with any repository. */
export function createApp(deps: AppDeps): Express {
  if (!deps.apiToken) throw new Error("apiToken is required");
  const app = express();
  app.disable("x-powered-by");

  const service = new OrderService(deps.repository);
  const orders = new OrdersController(service);

  app.use(requestContext(deps.logger));

  // Public routes (no token): liveness/db check for Docker, and the Swagger UI.
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await deps.repository.ping();
    } catch (err) {
      getContext(res).log.error({ event: "order.health.failed", httpStatus: 503 });
      throw new TechnicalError({ unavailable: true, cause: err });
    }
    sendSuccess(res, "OK", "healthy", { status: "ok" as const });
  });
  app.use("/docs", ...docsHandlers());

  app.use(bearerAuth(deps.apiToken));
  app.use(express.json({ limit: "10kb" }));

  app.get("/orders/:id", orders.getOrder);
  app.post("/orders/:id/cancellation", orders.requestCancellation);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
