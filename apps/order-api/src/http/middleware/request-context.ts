import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import type { RequestContext } from "../../application/order-service.js";

const TRACE_ID_REGEX = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Binds requestId/traceId and a child logger to the request; logs one completion event per request. */
export function requestContext(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    const incoming = req.header("x-trace-id");
    const traceId = incoming && TRACE_ID_REGEX.test(incoming) ? incoming : `tr_${randomBytes(6).toString("hex")}`;
    const requestId = `req_${randomBytes(8).toString("hex")}`;
    const log = logger.child({ traceId, requestId });
    const ctx: RequestContext = { requestId, traceId, log, startedAt };
    res.locals.ctx = ctx;
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Trace-Id", traceId);

    res.on("finish", () => {
      const route = req.route as { path?: string } | undefined;
      const routePath = route?.path ? `${req.baseUrl}${route.path}` : "unmatched";
      const level = routePath === "/health" ? "debug" : "info";
      log[level]({
        event: "http.request.completed",
        method: req.method,
        route: routePath,
        httpStatus: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  };
}
