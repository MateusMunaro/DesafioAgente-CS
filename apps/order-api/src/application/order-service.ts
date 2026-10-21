import type { CancellationView, OrderView } from "@desafio/contracts";
import type { Logger } from "pino";
import { CancellationPolicy } from "../domain/cancellation-policy.js";
import { OrderNotCancellableError, OrderNotFoundError, TechnicalError, ValidationError } from "../domain/errors.js";
import type { Order } from "../domain/order.js";
import type { OrderRepository } from "../domain/order-repository.js";

export interface RequestContext {
  requestId: string;
  traceId: string;
  /** Child logger already bound to traceId/requestId. */
  log: Logger;
  startedAt: number;
}

export interface CancelOrderCommand {
  customerId: string;
  orderId: string;
  idempotencyKey: string;
  channel?: string | undefined;
  reasonCode?: string | undefined;
}

/** Short reference for logs (never the full customer id). */
export function maskCustomerRef(customerId: string): string {
  return `cus_…${customerId.slice(-4)}`;
}

export function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    status: order.status,
    totalAmount: order.totalAmount,
    currency: order.currency,
    items: order.items.map((i) => ({
      productExternalId: i.productExternalId,
      productTitle: i.productTitle,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    })),
    createdAt: order.createdAt.toISOString(),
    shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
    cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
  };
}

export class OrderService {
  constructor(
    private readonly repo: OrderRepository,
    private readonly policy: CancellationPolicy = new CancellationPolicy(),
  ) {}

  async getOrder(customerId: string, orderId: string, ctx: RequestContext): Promise<OrderView> {
    const order = await this.repo.findForCustomer(orderId, customerId);
    const durationMs = Date.now() - ctx.startedAt;
    if (!order) {
      ctx.log.info({ event: "order.lookup.not_found", orderId, customerRef: maskCustomerRef(customerId), httpStatus: 404, durationMs });
      throw new OrderNotFoundError();
    }
    ctx.log.info({ event: "order.lookup.succeeded", orderId, customerRef: maskCustomerRef(customerId), status: order.status, durationMs });
    return toOrderView(order);
  }

  async cancel(cmd: CancelOrderCommand, ctx: RequestContext): Promise<CancellationView> {
    const customerRef = maskCustomerRef(cmd.customerId);
    const outcome = await this.repo.cancelIfProcessing(cmd);
    const durationMs = Date.now() - ctx.startedAt;

    switch (outcome.kind) {
      case "CANCELLED":
        ctx.log.info({
          event: outcome.replayed ? "order.cancellation.replayed" : "order.cancellation.succeeded",
          orderId: cmd.orderId,
          customerRef,
          durationMs,
        });
        return {
          orderId: cmd.orderId,
          status: "CANCELLED",
          cancelledAt: outcome.cancelledAt.toISOString(),
          replayed: outcome.replayed,
        };
      case "NOT_FOUND":
        ctx.log.info({ event: "order.cancellation.not_found", orderId: cmd.orderId, customerRef, httpStatus: 404, durationMs });
        throw new OrderNotFoundError();
      case "KEY_CONFLICT":
        ctx.log.warn({ event: "order.cancellation.key_conflict", orderId: cmd.orderId, customerRef, httpStatus: 400, durationMs });
        throw new ValidationError([{ path: "Idempotency-Key", issue: "was already used for a different request" }]);
      case "NOT_CANCELLABLE": {
        const decision = this.policy.evaluateStatus(outcome.currentStatus);
        if (decision.cancellable) {
          // Repository says "not cancellable" for a PROCESSING order: inconsistent state, never guess.
          throw new TechnicalError();
        }
        ctx.log.info({
          event: "order.cancellation.rejected",
          orderId: cmd.orderId,
          customerRef,
          reason: decision.reason,
          httpStatus: 409,
          durationMs,
        });
        throw new OrderNotCancellableError(cmd.orderId, outcome.currentStatus, decision.reason);
      }
    }
  }
}
