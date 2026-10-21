import { z } from "zod";

export const ORDER_STATUSES = ["PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"] as const;
export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** Order ids are numeric strings of 4 to 10 digits (e.g. "1042"). */
export const ORDER_ID_REGEX = /^\d{4,10}$/;
export const OrderId = z.string().regex(ORDER_ID_REGEX, "orderId must be 4 to 10 digits");
export type OrderId = z.infer<typeof OrderId>;

export const OrderItemView = z.object({
  /** Id of the product in the Fake Store API (1..20). No FK: external system. */
  productExternalId: z.number().int().positive(),
  /** Title snapshot taken when the order was placed. */
  productTitle: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
});
export type OrderItemView = z.infer<typeof OrderItemView>;

export const OrderView = z.object({
  id: OrderId,
  status: OrderStatus,
  totalAmount: z.number().nonnegative(),
  currency: z.string().length(3),
  items: z.array(OrderItemView),
  createdAt: z.string().datetime({ offset: true }),
  shippedAt: z.string().datetime({ offset: true }).nullable(),
  cancelledAt: z.string().datetime({ offset: true }).nullable(),
});
export type OrderView = z.infer<typeof OrderView>;

export const CANCEL_REASONS = ["ALREADY_SHIPPED", "ALREADY_DELIVERED", "ALREADY_CANCELLED"] as const;
export const CancelReason = z.enum(CANCEL_REASONS);
export type CancelReason = z.infer<typeof CancelReason>;

export const CancellationView = z.object({
  orderId: OrderId,
  status: z.literal("CANCELLED"),
  cancelledAt: z.string().datetime({ offset: true }),
  /** True when the same Idempotency-Key was replayed and the stored result returned. */
  replayed: z.boolean(),
});
export type CancellationView = z.infer<typeof CancellationView>;
