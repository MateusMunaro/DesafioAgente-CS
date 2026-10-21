import type { CancelReason, OrderStatus } from "@desafio/contracts";

/** Why a technical failure happened. Never contains PII or raw payloads. */
export type TechnicalCause = "TIMEOUT" | "NETWORK" | "HTTP_5XX" | "UNAUTHORIZED" | "INVALID_RESPONSE" | "UNEXPECTED_STATUS";

/** Discriminated result of an Order API call. Expected failures are values, never exceptions. */
export type ApiResult<T> =
  | { kind: "OK"; data: T; code: "OK" | "CANCELLED"; requestId: string }
  | { kind: "NOT_FOUND" }
  | { kind: "NOT_CANCELLABLE"; reason: CancelReason; currentStatus: OrderStatus }
  | { kind: "VALIDATION_ERROR"; message: string }
  | { kind: "TECHNICAL_ERROR"; cause: TechnicalCause; attempts: number };

export type ExternalFailure = "TIMEOUT" | "NETWORK" | "HTTP_ERROR" | "NOT_FOUND" | "INVALID_RESPONSE";

/** Discriminated result of a call to an external, non critical system (Fake Store). */
export type ExternalResult<T> = { kind: "OK"; data: T; cached: boolean } | { kind: "UNAVAILABLE"; reason: ExternalFailure };

export type CallContext = { traceId?: string };
