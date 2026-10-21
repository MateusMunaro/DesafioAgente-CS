import type { CancellationView, CancelReason, OrderStatus, OrderView, ProductInfo } from "@desafio/contracts";
import type {
  ApiResult,
  CallContext,
  ExternalResult,
  OrderApiPort,
  ProductCatalogPort,
  ProductsLookup,
} from "../ports/index.js";

interface SeedItem {
  productId: number;
  title: string;
  quantity: number;
  unitPrice: number;
}

interface SeedOrder {
  id: string;
  customerRef: string;
  status: OrderStatus;
  items: SeedItem[];
  createdAt: string;
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

/** Same orders as apps/order-api/seed.sql (subset), for running the agent without the Order API. */
export const OFFLINE_ORDERS: readonly SeedOrder[] = [
  { id: "1042", customerRef: A, status: "PROCESSING", createdAt: "2026-10-19T14:00:00Z", items: [{ productId: 1, title: "Fjallraven Backpack", quantity: 1, unitPrice: 109.95 }] },
  { id: "1043", customerRef: A, status: "SHIPPED", createdAt: "2026-10-17T09:30:00Z", items: [{ productId: 3, title: "Mens Cotton Jacket", quantity: 1, unitPrice: 55.99 }, { productId: 9, title: "WD 2TB Portable Hard Drive", quantity: 1, unitPrice: 64 }] },
  { id: "1044", customerRef: A, status: "DELIVERED", createdAt: "2026-10-05T11:00:00Z", items: [{ productId: 2, title: "Mens Slim Fit T-Shirt", quantity: 2, unitPrice: 22.3 }] },
  { id: "1045", customerRef: A, status: "CANCELLED", createdAt: "2026-10-14T16:20:00Z", items: [{ productId: 13, title: "Acer 21.5 inch Monitor", quantity: 1, unitPrice: 599 }] },
  { id: "1050", customerRef: B, status: "PROCESSING", createdAt: "2026-10-19T10:15:00Z", items: [{ productId: 10, title: "SanDisk SSD PLUS 1TB", quantity: 1, unitPrice: 109 }, { productId: 19, title: "Women Short Sleeve Shirt", quantity: 2, unitPrice: 7.95 }] },
  { id: "1051", customerRef: B, status: "SHIPPED", createdAt: "2026-10-16T13:40:00Z", items: [{ productId: 14, title: "Samsung 49 inch Gaming Monitor", quantity: 1, unitPrice: 999.99 }] },
  { id: "1060", customerRef: C, status: "PROCESSING", createdAt: "2026-10-20T08:00:00Z", items: [{ productId: 5, title: "John Hardy Dragon Bracelet", quantity: 1, unitPrice: 695 }] },
];

/** In-memory Order API stand-in with the same rules as the real one (ownership, PROCESSING only, idempotency). */
export class InMemoryOrderApi implements OrderApiPort {
  private readonly orders = new Map<string, { status: OrderStatus; seed: SeedOrder; cancelledAt: string | null }>();
  private readonly keys = new Map<string, CancellationView>();
  /** Every cancel call received: lets tests assert on keys and counts. */
  readonly cancelCalls: Array<{ customerRef: string; orderId: string; idempotencyKey: string }> = [];

  constructor(seed: readonly SeedOrder[] = OFFLINE_ORDERS) {
    for (const s of seed) this.orders.set(s.id, { status: s.status, seed: s, cancelledAt: null });
  }

  async getOrder(customerRef: string, orderId: string, _ctx?: CallContext): Promise<ApiResult<OrderView>> {
    const o = this.orders.get(orderId);
    if (!o || o.seed.customerRef !== customerRef) return { kind: "NOT_FOUND" };
    return { kind: "OK", code: "OK", requestId: "offline", data: this.view(orderId) };
  }

  async cancel(customerRef: string, orderId: string, idempotencyKey: string, _ctx?: CallContext): Promise<ApiResult<CancellationView>> {
    this.cancelCalls.push({ customerRef, orderId, idempotencyKey });
    const o = this.orders.get(orderId);
    if (!o || o.seed.customerRef !== customerRef) return { kind: "NOT_FOUND" };
    const replay = this.keys.get(idempotencyKey);
    if (replay) return { kind: "OK", code: "CANCELLED", requestId: "offline", data: { ...replay, replayed: true } };
    if (o.status !== "PROCESSING") {
      const reason: CancelReason = o.status === "SHIPPED" ? "ALREADY_SHIPPED" : o.status === "DELIVERED" ? "ALREADY_DELIVERED" : "ALREADY_CANCELLED";
      return { kind: "NOT_CANCELLABLE", reason, currentStatus: o.status };
    }
    o.status = "CANCELLED";
    o.cancelledAt = new Date().toISOString();
    const view: CancellationView = { orderId, status: "CANCELLED", cancelledAt: o.cancelledAt, replayed: false };
    this.keys.set(idempotencyKey, view);
    return { kind: "OK", code: "CANCELLED", requestId: "offline", data: view };
  }

  /** Test helper: moves an order to another status (e.g. the shipping race, TC-08). */
  setStatus(orderId: string, status: OrderStatus): void {
    const o = this.orders.get(orderId);
    if (o) o.status = status;
  }

  private view(orderId: string): OrderView {
    const o = this.orders.get(orderId) as NonNullable<ReturnType<typeof this.orders.get>>;
    const total = o.seed.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    return {
      id: orderId,
      status: o.status,
      totalAmount: Math.round(total * 100) / 100,
      currency: "BRL",
      items: o.seed.items.map((i) => ({ productExternalId: i.productId, productTitle: i.title, quantity: i.quantity, unitPrice: i.unitPrice })),
      createdAt: o.seed.createdAt,
      shippedAt: o.status === "SHIPPED" || o.status === "DELIVERED" ? o.seed.createdAt : null,
      cancelledAt: o.cancelledAt,
    };
  }
}

const PRODUCTS: readonly ProductInfo[] = [
  { id: 1, title: "Fjallraven Foldsack No. 1 Backpack", category: "men's clothing", price: 109.95 },
  { id: 2, title: "Mens Casual Premium Slim Fit T-Shirts", category: "men's clothing", price: 22.3 },
  { id: 3, title: "Mens Cotton Jacket", category: "men's clothing", price: 55.99 },
  { id: 5, title: "John Hardy Women's Legends Naga Bracelet", category: "jewelery", price: 695 },
  { id: 9, title: "WD 2TB Elements Portable External Hard Drive", category: "electronics", price: 64 },
  { id: 10, title: "SanDisk SSD PLUS 1TB Internal SSD", category: "electronics", price: 109 },
  { id: 13, title: "Acer SB220Q bi 21.5 inches Full HD Monitor", category: "electronics", price: 599 },
  { id: 14, title: "Samsung 49-Inch CHG90 Gaming Monitor", category: "electronics", price: 999.99 },
  { id: 19, title: "Women's Short Sleeve Moisture T-Shirt", category: "women's clothing", price: 7.95 },
];

/** Static catalog for offline mode and tests. `unavailable` simulates a Fake Store outage. */
export class StaticProductCatalog implements ProductCatalogPort {
  constructor(
    private readonly products: readonly ProductInfo[] = PRODUCTS,
    private readonly unavailable = false,
  ) {}

  async getProduct(id: number, _ctx?: CallContext): Promise<ExternalResult<ProductInfo>> {
    if (this.unavailable) return { kind: "UNAVAILABLE", reason: "NETWORK" };
    const p = this.products.find((x) => x.id === id);
    return p ? { kind: "OK", data: { ...p }, cached: false } : { kind: "UNAVAILABLE", reason: "NOT_FOUND" };
  }

  async getProducts(ids: readonly number[], ctx?: CallContext): Promise<ProductsLookup> {
    const found: ProductInfo[] = [];
    for (const id of ids) {
      const r = await this.getProduct(id, ctx);
      if (r.kind === "OK") found.push(r.data);
    }
    if (found.length === ids.length) return { products: found, status: "ok" };
    return { products: found, status: found.length === 0 ? "unavailable" : "degraded" };
  }
}
