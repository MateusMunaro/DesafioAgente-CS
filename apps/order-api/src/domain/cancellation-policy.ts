import type { CancelReason, OrderStatus } from "@desafio/contracts";

export type CancellationDecision = { cancellable: true } | { cancellable: false; reason: CancelReason };

const REASON_BY_STATUS: Record<Exclude<OrderStatus, "PROCESSING">, CancelReason> = {
  SHIPPED: "ALREADY_SHIPPED",
  DELIVERED: "ALREADY_DELIVERED",
  CANCELLED: "ALREADY_CANCELLED",
};

/** Business rule S2/R3: only PROCESSING orders can be cancelled. */
export class CancellationPolicy {
  evaluate(order: { status: OrderStatus }): CancellationDecision {
    return this.evaluateStatus(order.status);
  }

  evaluateStatus(status: OrderStatus): CancellationDecision {
    if (status === "PROCESSING") return { cancellable: true };
    return { cancellable: false, reason: REASON_BY_STATUS[status] };
  }
}

/** Rejection reason for a status that is not cancellable. */
export function cancelReasonFor(status: Exclude<OrderStatus, "PROCESSING">): CancelReason {
  return REASON_BY_STATUS[status];
}
