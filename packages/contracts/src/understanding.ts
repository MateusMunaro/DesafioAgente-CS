import { z } from "zod";
import { ORDER_ID_REGEX } from "./orders.js";

export const INTENTS = [
  "CHECK_STATUS",
  "CANCEL_ORDER",
  "PRODUCT_QUESTION",
  "HUMAN_REQUEST",
  "OUT_OF_SCOPE",
  "RULE_OVERRIDE_ATTEMPT",
  "GREETING",
  "UNCLEAR",
] as const;
export const Intent = z.enum(INTENTS);
export type Intent = z.infer<typeof Intent>;

/** Minimum classifier confidence; below it the intent counts as UNCLEAR. */
export const MIN_CONFIDENCE = 0.6;

/** Output schema of the `understand` node. */
export const Understanding = z.object({
  intent: Intent,
  orderId: z.string().regex(ORDER_ID_REGEX).nullable(),
  confidence: z.number().min(0).max(1),
});
export type Understanding = z.infer<typeof Understanding>;
