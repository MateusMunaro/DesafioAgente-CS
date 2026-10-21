import type { Order, OrderStatus } from "./order.js";

export interface CancelCommand {
  orderId: string;
  customerId: string;
  idempotencyKey: string;
  channel?: string | undefined;
  reasonCode?: string | undefined;
}

export type CancelOutcome =
  | { kind: "CANCELLED"; cancelledAt: Date; replayed: boolean }
  | { kind: "NOT_CANCELLABLE"; currentStatus: OrderStatus }
  | { kind: "NOT_FOUND" }
  /** The Idempotency-Key was already used for a different order. */
  | { kind: "KEY_CONFLICT" };

export interface OrderRepository {
  /** Returns null when the order does not exist OR belongs to another customer. */
  findForCustomer(orderId: string, customerId: string): Promise<Order | null>;
  /**
   * Atomic PROCESSING -> CANCELLED. Same Idempotency-Key replays the stored result and never cancels twice.
   */
  cancelIfProcessing(cmd: CancelCommand): Promise<CancelOutcome>;
  /** Throws when the backing store is unreachable. */
  ping(): Promise<void>;
}
