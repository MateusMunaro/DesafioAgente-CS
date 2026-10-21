import {
  CancellationView,
  ErrorEnvelope,
  NotCancellableDetails,
  OrderView,
  successEnvelope,
  type CancellationView as CancellationViewT,
  type OrderView as OrderViewT,
} from "@desafio/contracts";
import type { z } from "zod";
import type { ApiResult, CallContext, OrderApiPort, TechnicalCause } from "../../ports/index.js";
import { createLogger, type Logger } from "../logging.js";
import { fetchJson, type FetchOutcome } from "../http.js";

export interface HttpOrderApiClientOptions {
  baseUrl: string;
  token: string;
  /** Per attempt deadline. Default 3000 ms. */
  timeoutMs?: number;
  /** Extra attempts for GET on timeout/5xx. Default 0. */
  getRetries?: number;
  /** Extra attempts for cancel on timeout/5xx, always with the SAME Idempotency-Key. Default 1. */
  cancelRetries?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const OrderEnvelope = successEnvelope(OrderView);
const CancellationEnvelope = successEnvelope(CancellationView);

type Attempt<T> = { done: true; result: ApiResult<T> } | { done: false; cause: TechnicalCause };

interface CallParams<T> {
  op: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  retries: number;
  schema: z.ZodType<{ data: T; code: "OK" | "CANCELLED"; requestId: string }>;
  orderId: string;
  ctx: CallContext;
}

export class HttpOrderApiClient implements OrderApiPort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly getRetries: number;
  private readonly cancelRetries: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(o: HttpOrderApiClientOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.token = o.token;
    this.timeoutMs = o.timeoutMs ?? 3000;
    this.getRetries = o.getRetries ?? 0;
    this.cancelRetries = o.cancelRetries ?? 1;
    this.log = o.logger ?? createLogger();
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
  }

  getOrder(customerRef: string, orderId: string, ctx: CallContext = {}): Promise<ApiResult<OrderViewT>> {
    return this.call<OrderViewT>({
      op: "get_order",
      method: "GET",
      path: `/orders/${encodeURIComponent(orderId)}`,
      headers: this.headers(customerRef, ctx),
      retries: this.getRetries,
      schema: OrderEnvelope as unknown as CallParams<OrderViewT>["schema"],
      orderId,
      ctx,
    });
  }

  cancel(customerRef: string, orderId: string, idempotencyKey: string, ctx: CallContext = {}): Promise<ApiResult<CancellationViewT>> {
    return this.call<CancellationViewT>({
      op: "cancel_order",
      method: "POST",
      path: `/orders/${encodeURIComponent(orderId)}/cancellation`,
      // Same headers (and key) on every attempt: the API replays the stored result.
      headers: { ...this.headers(customerRef, ctx), "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" },
      body: "{}",
      retries: this.cancelRetries,
      schema: CancellationEnvelope as unknown as CallParams<CancellationViewT>["schema"],
      orderId,
      ctx,
    });
  }

  private headers(customerRef: string, ctx: CallContext): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}`, "X-Customer-Ref": customerRef, Accept: "application/json" };
    if (ctx.traceId) h["X-Trace-Id"] = ctx.traceId;
    return h;
  }

  private async call<T>(p: CallParams<T>): Promise<ApiResult<T>> {
    const maxAttempts = 1 + p.retries;
    let cause: TechnicalCause = "NETWORK";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      const outcome = await fetchJson(`${this.baseUrl}${p.path}`, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        method: p.method,
        headers: p.headers,
        body: p.body,
      });
      const res = this.interpret<T>(outcome, p.schema);
      const durationMs = Date.now() - started;
      if (res.done) {
        this.log.info({ event: "external.order_api.call", op: p.op, orderId: p.orderId, traceId: p.ctx.traceId, result: res.result.kind, attempt, durationMs });
        return res.result;
      }
      cause = res.cause;
      const willRetry = attempt < maxAttempts && retryable(cause);
      this.log.warn({ event: "external.order_api.failed", op: p.op, orderId: p.orderId, traceId: p.ctx.traceId, error: cause, attempt, willRetry, durationMs });
      if (!willRetry) return { kind: "TECHNICAL_ERROR", cause, attempts: attempt };
    }
    return { kind: "TECHNICAL_ERROR", cause, attempts: maxAttempts };
  }

  private interpret<T>(outcome: FetchOutcome, schema: CallParams<T>["schema"]): Attempt<T> {
    if (outcome.kind === "timeout") return { done: false, cause: "TIMEOUT" };
    if (outcome.kind === "network") return { done: false, cause: "NETWORK" };
    const { status, body, bodyValid } = outcome;
    if (status >= 500) return { done: false, cause: "HTTP_5XX" };
    if (status === 401 || status === 403) return { done: false, cause: "UNAUTHORIZED" };
    if (status === 200) {
      const parsed = bodyValid ? schema.safeParse(body) : undefined;
      if (!parsed?.success) return { done: false, cause: "INVALID_RESPONSE" };
      const env = parsed.data;
      return { done: true, result: { kind: "OK", data: env.data, code: env.code, requestId: env.requestId } };
    }
    const err = bodyValid ? ErrorEnvelope.safeParse(body) : undefined;
    if (status === 404) return { done: true, result: { kind: "NOT_FOUND" } };
    if (status === 400) return { done: true, result: { kind: "VALIDATION_ERROR", message: err?.success ? err.data.message : "Invalid request" } };
    if (status === 409 && err?.success && err.data.code === "ORDER_NOT_CANCELLABLE") {
      const d = NotCancellableDetails.safeParse(err.data.details);
      if (d.success) return { done: true, result: { kind: "NOT_CANCELLABLE", reason: d.data.reason, currentStatus: d.data.currentStatus } };
      return { done: false, cause: "INVALID_RESPONSE" };
    }
    return { done: false, cause: "UNEXPECTED_STATUS" };
  }
}

/** Retry only when the outcome is unknown or transient. Contract violations and auth errors will not heal. */
function retryable(cause: TechnicalCause): boolean {
  return cause === "TIMEOUT" || cause === "NETWORK" || cause === "HTTP_5XX";
}
