import type { Order, OrderStatus } from "../domain/order.js";
import type { CancelCommand, CancelOutcome, OrderRepository } from "../domain/order-repository.js";

interface StoredRequest {
  orderId: string;
  outcome: "CANCELLED" | "REJECTED";
}

export interface StatusHistoryEntry {
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actor: string;
  reasonCode: string | null;
  at: Date;
}

/** Test double with the same semantics as PgOrderRepository (isolation, idempotency, conditional cancel). */
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();
  private readonly requests = new Map<string, StoredRequest>();
  readonly history: StatusHistoryEntry[] = [];
  /** When set, ping() rejects with it (simulates database down). */
  pingError: Error | null = null;
  /** When set, every call rejects with it (simulates an unexpected failure). */
  failWith: Error | null = null;

  constructor(
    orders: readonly Order[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {
    for (const o of orders) this.orders.set(o.id, o);
  }

  add(order: Order): void {
    this.orders.set(order.id, order);
  }

  /** Test helper: moves an order to another status without going through cancellation (e.g. shipping). */
  setStatus(orderId: string, status: OrderStatus): void {
    const current = this.orders.get(orderId);
    if (!current) throw new Error(`unknown order ${orderId}`);
    this.orders.set(orderId, current.with({ status, shippedAt: status === "SHIPPED" ? this.clock() : current.shippedAt }));
  }

  snapshot(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  get requestCount(): number {
    return this.requests.size;
  }

  async findForCustomer(orderId: string, customerId: string): Promise<Order | null> {
    if (this.failWith) throw this.failWith;
    const order = this.orders.get(orderId);
    return order && order.customerId === customerId ? order : null;
  }

  async cancelIfProcessing(cmd: CancelCommand): Promise<CancelOutcome> {
    if (this.failWith) throw this.failWith;
    // Single synchronous section: atomic, like the SQL transaction.
    const order = this.orders.get(cmd.orderId);
    if (!order || order.customerId !== cmd.customerId) return { kind: "NOT_FOUND" };

    const existing = this.requests.get(cmd.idempotencyKey);
    if (existing) {
      if (existing.orderId !== cmd.orderId) return { kind: "KEY_CONFLICT" };
      if (existing.outcome === "CANCELLED" && order.cancelledAt) {
        return { kind: "CANCELLED", cancelledAt: order.cancelledAt, replayed: true };
      }
      return { kind: "NOT_CANCELLABLE", currentStatus: order.status };
    }

    if (order.status === "PROCESSING") {
      const at = this.clock();
      this.orders.set(order.id, order.with({ status: "CANCELLED", cancelledAt: at }));
      this.requests.set(cmd.idempotencyKey, { orderId: order.id, outcome: "CANCELLED" });
      this.history.push({
        orderId: order.id,
        fromStatus: "PROCESSING",
        toStatus: "CANCELLED",
        actor: "AGENT",
        reasonCode: cmd.reasonCode ?? null,
        at,
      });
      return { kind: "CANCELLED", cancelledAt: at, replayed: false };
    }

    this.requests.set(cmd.idempotencyKey, { orderId: order.id, outcome: "REJECTED" });
    return { kind: "NOT_CANCELLABLE", currentStatus: order.status };
  }

  async ping(): Promise<void> {
    if (this.pingError) throw this.pingError;
  }
}
