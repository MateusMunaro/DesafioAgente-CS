import { API_ERROR_HTTP_STATUS, type ApiErrorCode, type CancelReason, type OrderStatus } from "@desafio/contracts";

/** Base of every error that maps to the standard envelope. */
export class DomainError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class OrderNotFoundError extends DomainError {
  constructor() {
    // Identical for "does not exist" and "belongs to another customer": nothing in here depends on the order.
    super("ORDER_NOT_FOUND", API_ERROR_HTTP_STATUS.ORDER_NOT_FOUND, "Order not found");
  }
}

export class OrderNotCancellableError extends DomainError {
  constructor(orderId: string, currentStatus: OrderStatus, reason: CancelReason) {
    super("ORDER_NOT_CANCELLABLE", API_ERROR_HTTP_STATUS.ORDER_NOT_CANCELLABLE, "Order cannot be cancelled in its current status", {
      orderId,
      currentStatus,
      reason,
    });
  }
}

export interface FieldIssue {
  path: string;
  issue: string;
}

export class ValidationError extends DomainError {
  constructor(fields: FieldIssue[]) {
    super("VALIDATION_ERROR", API_ERROR_HTTP_STATUS.VALIDATION_ERROR, "Invalid request", { fields });
  }
}

export class UnauthorizedError extends DomainError {
  constructor() {
    super("UNAUTHORIZED", API_ERROR_HTTP_STATUS.UNAUTHORIZED, "Missing or invalid credentials");
  }
}

export class TechnicalError extends DomainError {
  constructor(options: { unavailable?: boolean; cause?: unknown } = {}) {
    super(
      "TECHNICAL_ERROR",
      options.unavailable ? 503 : API_ERROR_HTTP_STATUS.TECHNICAL_ERROR,
      options.unavailable ? "Service temporarily unavailable" : "Unexpected error",
    );
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
