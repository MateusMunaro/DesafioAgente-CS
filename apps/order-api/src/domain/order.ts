import type { OrderStatus } from "@desafio/contracts";
import { CancellationPolicy } from "./cancellation-policy.js";

export type { OrderStatus };

export interface OrderItem {
  productExternalId: number;
  productTitle: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderProps {
  id: string;
  customerId: string;
  status: OrderStatus;
  totalAmount: number;
  currency: string;
  items: readonly OrderItem[];
  createdAt: Date;
  shippedAt: Date | null;
  cancelledAt: Date | null;
}

const policy = new CancellationPolicy();

/** Order aggregate as seen by the domain (immutable; transitions return a new instance). */
export class Order {
  readonly id: string;
  readonly customerId: string;
  readonly status: OrderStatus;
  readonly totalAmount: number;
  readonly currency: string;
  readonly items: readonly OrderItem[];
  readonly createdAt: Date;
  readonly shippedAt: Date | null;
  readonly cancelledAt: Date | null;

  constructor(props: OrderProps) {
    this.id = props.id;
    this.customerId = props.customerId;
    this.status = props.status;
    this.totalAmount = props.totalAmount;
    this.currency = props.currency;
    this.items = props.items;
    this.createdAt = props.createdAt;
    this.shippedAt = props.shippedAt;
    this.cancelledAt = props.cancelledAt;
  }

  isCancellable(): boolean {
    return policy.evaluate(this).cancellable;
  }

  with(changes: Partial<OrderProps>): Order {
    return new Order({ ...this, ...changes });
  }
}
