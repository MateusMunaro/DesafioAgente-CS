import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  ApiErrorCode,
  CANCEL_REASONS,
  CancelReason,
  CancellationView,
  CUSTOMER_FIXTURES,
  E164_REGEX,
  ErrorEnvelope,
  INTENTS,
  OrderStatus,
  OrderView,
  ProductInfo,
  Understanding,
  findCustomerByPhone,
  successEnvelope,
} from "../src/index.js";

const order = {
  id: "1042",
  status: "PROCESSING",
  totalAmount: 109.95,
  currency: "BRL",
  items: [{ productExternalId: 1, productTitle: "Backpack", quantity: 1, unitPrice: 109.95 }],
  createdAt: "2026-10-19T14:00:00.000Z",
  shippedAt: null,
  cancelledAt: null,
};

describe("OrderStatus / CancelReason", () => {
  it("accepts the four statuses only", () => {
    for (const s of ["PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]) expect(OrderStatus.safeParse(s).success).toBe(true);
    expect(OrderStatus.safeParse("PENDING").success).toBe(false);
  });
  it("has the three cancel reasons", () => {
    expect([...CANCEL_REASONS]).toEqual(["ALREADY_SHIPPED", "ALREADY_DELIVERED", "ALREADY_CANCELLED"]);
    expect(CancelReason.safeParse("ALREADY_SHIPPED").success).toBe(true);
    expect(CancelReason.safeParse("OTHER").success).toBe(false);
  });
});

describe("OrderView", () => {
  it("parses a valid order", () => {
    expect(OrderView.parse(order).id).toBe("1042");
  });
  it("rejects bad ids, statuses and quantities", () => {
    expect(OrderView.safeParse({ ...order, id: "12" }).success).toBe(false);
    expect(OrderView.safeParse({ ...order, id: "abc123" }).success).toBe(false);
    expect(OrderView.safeParse({ ...order, status: "LOST" }).success).toBe(false);
    expect(OrderView.safeParse({ ...order, items: [{ ...order.items[0], quantity: 0 }] }).success).toBe(false);
  });
});

describe("CancellationView", () => {
  it("requires CANCELLED status", () => {
    const ok = { orderId: "1042", status: "CANCELLED", cancelledAt: "2026-10-19T14:05:00Z", replayed: false };
    expect(CancellationView.safeParse(ok).success).toBe(true);
    expect(CancellationView.safeParse({ ...ok, status: "SHIPPED" }).success).toBe(false);
  });
});

describe("envelopes", () => {
  it("validates the 409 error envelope", () => {
    const env = {
      ok: false,
      code: "ORDER_NOT_CANCELLABLE",
      message: "Order cannot be cancelled in its current status",
      details: { orderId: "1043", currentStatus: "SHIPPED", reason: "ALREADY_SHIPPED" },
      requestId: "req_01JB7Q2M4X",
    };
    expect(ErrorEnvelope.parse(env).code).toBe("ORDER_NOT_CANCELLABLE");
  });
  it("rejects unknown codes and ok=true on errors", () => {
    const base = { ok: false, code: "VALIDATION_ERROR", message: "x", details: null, requestId: "r" };
    expect(ErrorEnvelope.safeParse(base).success).toBe(true);
    expect(ErrorEnvelope.safeParse({ ...base, code: "NOPE" }).success).toBe(false);
    expect(ErrorEnvelope.safeParse({ ...base, ok: true }).success).toBe(false);
  });
  it("maps every error code to an HTTP status", () => {
    for (const c of API_ERROR_CODES) expect(API_ERROR_HTTP_STATUS[c]).toBeGreaterThanOrEqual(400);
    expect(ApiErrorCode.options).toHaveLength(API_ERROR_CODES.length);
  });
  it("builds a success envelope around data", () => {
    const schema = successEnvelope(OrderView);
    expect(schema.safeParse({ ok: true, code: "OK", message: "ok", data: order, requestId: "req_1" }).success).toBe(true);
    expect(schema.safeParse({ ok: true, code: "OK", message: "ok", data: { id: 1 }, requestId: "req_1" }).success).toBe(false);
  });
});

describe("Understanding", () => {
  it("accepts a valid classification", () => {
    expect(Understanding.parse({ intent: "CANCEL_ORDER", orderId: "1042", confidence: 0.94 }).orderId).toBe("1042");
    expect(Understanding.safeParse({ intent: "GREETING", orderId: null, confidence: 1 }).success).toBe(true);
  });
  it("lists all eight intents", () => {
    expect(INTENTS).toHaveLength(8);
    expect(INTENTS).toContain("RULE_OVERRIDE_ATTEMPT");
  });
  it("rejects invalid intent, order id and confidence", () => {
    expect(Understanding.safeParse({ intent: "DROP_TABLE", orderId: null, confidence: 0.9 }).success).toBe(false);
    for (const orderId of ["123", "12345678901", "10 42", "1042; DROP", "-1042"]) {
      expect(Understanding.safeParse({ intent: "CHECK_STATUS", orderId, confidence: 0.9 }).success).toBe(false);
    }
    expect(Understanding.safeParse({ intent: "CHECK_STATUS", orderId: "1042", confidence: 1.2 }).success).toBe(false);
    expect(Understanding.safeParse({ intent: "CHECK_STATUS", orderId: "1042", confidence: -0.1 }).success).toBe(false);
    expect(Understanding.safeParse({ intent: "CHECK_STATUS", confidence: 0.5 }).success).toBe(false);
  });
});

describe("ProductInfo", () => {
  it("parses id/title/category/price and rejects malformed data", () => {
    expect(ProductInfo.safeParse({ id: 1, title: "Backpack", category: "clothing", price: 109.95 }).success).toBe(true);
    expect(ProductInfo.safeParse({ id: 1, title: "", category: "x", price: 1 }).success).toBe(false);
    expect(ProductInfo.safeParse({ id: "1", title: "a", category: "x", price: 1 }).success).toBe(false);
    expect(ProductInfo.safeParse({ id: 1, title: "a", category: "x" }).success).toBe(false);
  });
});

describe("customer fixtures", () => {
  it("has at least 2 customers with unique uuid and phone in E.164", () => {
    expect(CUSTOMER_FIXTURES.length).toBeGreaterThanOrEqual(2);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const c of CUSTOMER_FIXTURES) {
      expect(c.id).toMatch(uuid);
      expect(c.phoneE164).toMatch(E164_REGEX);
      expect(c.displayName.length).toBeGreaterThan(0);
    }
    expect(new Set(CUSTOMER_FIXTURES.map((c) => c.id)).size).toBe(CUSTOMER_FIXTURES.length);
    expect(new Set(CUSTOMER_FIXTURES.map((c) => c.phoneE164)).size).toBe(CUSTOMER_FIXTURES.length);
  });
  it("finds by phone", () => {
    const first = CUSTOMER_FIXTURES[0]!;
    expect(findCustomerByPhone(first.phoneE164)).toEqual(first);
    expect(findCustomerByPhone("+000")).toBeUndefined();
  });
});
