import type { Request, Response } from "express";
import type { OrderService } from "../application/order-service.js";
import { getContext, sendSuccess } from "./envelope.js";
import { GetOrderInput, parseCancelRequest, parseOrThrow } from "./schemas.js";

export class OrdersController {
  constructor(private readonly service: OrderService) {}

  getOrder = async (req: Request, res: Response): Promise<void> => {
    const input = parseOrThrow(GetOrderInput, { id: req.params.id, customerRef: req.header("x-customer-ref") });
    const order = await this.service.getOrder(input.customerRef, input.id, getContext(res));
    sendSuccess(res, "OK", "Order found", order);
  };

  requestCancellation = async (req: Request, res: Response): Promise<void> => {
    const input = parseCancelRequest({
      id: req.params.id,
      customerRef: req.header("x-customer-ref"),
      idempotencyKey: req.header("idempotency-key"),
      body: req.body,
    });
    const result = await this.service.cancel(
      {
        customerId: input.customerRef,
        orderId: input.id,
        idempotencyKey: input.idempotencyKey,
        channel: input.body.channel,
        reasonCode: input.body.reasonCode,
      },
      getContext(res),
    );
    sendSuccess(res, "CANCELLED", "Order cancelled", result);
  };
}
