import { z } from "zod";
import { CancelReason, OrderId, OrderStatus } from "./orders.js";

export const API_ERROR_CODES = ["VALIDATION_ERROR", "ORDER_NOT_FOUND", "ORDER_NOT_CANCELLABLE", "UNAUTHORIZED", "TECHNICAL_ERROR"] as const;
export const ApiErrorCode = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** Default HTTP status for each error code. TECHNICAL_ERROR may also be 503. */
export const API_ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  ORDER_NOT_FOUND: 404,
  ORDER_NOT_CANCELLABLE: 409,
  TECHNICAL_ERROR: 500,
};

export const RequestId = z.string().min(1);

export const NotCancellableDetails = z.object({
  orderId: OrderId,
  currentStatus: OrderStatus,
  reason: CancelReason,
});
export type NotCancellableDetails = z.infer<typeof NotCancellableDetails>;

export const SUCCESS_CODES = ["OK", "CANCELLED"] as const;

/** Success envelope. `code` is a machine readable string: "OK" or "CANCELLED". */
export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({
    ok: z.literal(true),
    code: z.enum(SUCCESS_CODES),
    message: z.string(),
    data,
    requestId: RequestId,
  });
}
export type SuccessEnvelope<T> = { ok: true; code: (typeof SUCCESS_CODES)[number]; message: string; data: T; requestId: string };

export const ErrorEnvelope = z.object({
  ok: z.literal(false),
  code: ApiErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
  requestId: RequestId,
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
