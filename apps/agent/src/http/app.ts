import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentRuntime } from "../runtime/agentRuntime.js";

export const WebhookBody = z.object({
  /** Channel id; part of the thread id. */
  channel: z.string().min(1).max(16).regex(/^[a-z0-9_-]+$/i).default("wa"),
  /** Sender phone (E.164). */
  from: z.string().min(1).max(32),
  /** Message text. Length and emptiness are enforced by the graph's input_guard, not here. */
  text: z.string().max(20_000),
});

export interface AppOptions {
  runtime: AgentRuntime;
  logger: Logger;
}

/**
 * Express app of the agent: POST /webhook/messages and GET /health.
 * The response carries the reply for convenience; the delivery itself goes through the MessagingPort.
 */
export function createApp({ runtime, logger }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "agent" });
  });

  app.post("/webhook/messages", async (req, res, next) => {
    const parsed = WebhookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid webhook payload", fields: parsed.error.issues.map((i) => i.path.join(".")) } });
      return;
    }
    const traceId = req.header("x-trace-id") ?? req.header("x-request-id") ?? `tr_${randomUUID().slice(0, 8)}`;
    try {
      const turn = await runtime.handleInbound({ ...parsed.data, traceId });
      res.setHeader("x-trace-id", turn.traceId);
      res.json({
        threadId: turn.threadId,
        traceId: turn.traceId,
        reply: turn.reply,
        awaitingConfirmation: turn.awaitingConfirmation,
        handoff: turn.handoff,
      });
    } catch (err) {
      next(err);
    }
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status = typeof (err as { status?: unknown })?.status === "number" ? ((err as { status: number }).status) : 500;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: { code: "BAD_REQUEST", message: "Malformed request" } });
      return;
    }
    logger.error({ event: "agent.http.failed", error: err instanceof Error ? err.name : "UNKNOWN" });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal error" } });
  };
  app.use(onError);
  return app;
}
