import type { CancellationView, OrderView } from "@desafio/contracts";
import type { ApiResult, CallContext } from "./results.js";

export interface OrderApiPort {
  /** customerRef is resolved by the system from the channel phone, never chosen by the LLM. */
  getOrder(customerRef: string, orderId: string, ctx?: CallContext): Promise<ApiResult<OrderView>>;
  /** The same idempotencyKey must be reused by callers that retry on their own. */
  cancel(customerRef: string, orderId: string, idempotencyKey: string, ctx?: CallContext): Promise<ApiResult<CancellationView>>;
}
