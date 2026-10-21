import nock from "nock";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureLogger, hangingFetch } from "../testUtils.js";
import { HttpOrderApiClient } from "./httpOrderApiClient.js";

const BASE = "http://order-api.test";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const TOKEN = "secret-token";

const order = {
  id: "1042",
  status: "PROCESSING",
  totalAmount: 99.9,
  currency: "BRL",
  items: [{ productExternalId: 3, productTitle: "Mochila", quantity: 1, unitPrice: 99.9 }],
  createdAt: "2026-10-19T10:00:00.000Z",
  shippedAt: null,
  cancelledAt: null,
};
const ok = (data: unknown, code = "OK") => ({ ok: true, code, message: "ok", data, requestId: "req_1" });
const err = (code: string, message: string, details: unknown = null) => ({ ok: false, code, message, details, requestId: "req_2" });

function client(extra: { cancelRetries?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
  const log = captureLogger();
  return { log, api: new HttpOrderApiClient({ baseUrl: BASE, token: TOKEN, timeoutMs: extra.timeoutMs ?? 200, logger: log.logger, ...extra }) };
}

beforeAll(() => {
  nock.disableNetConnect();
});
beforeEach(() => nock.cleanAll());
afterEach(() => {
  expect(nock.pendingMocks()).toEqual([]);
});

describe("HttpOrderApiClient.getOrder", () => {
  it("200 -> OK with validated data and the required headers", async () => {
    nock(BASE, { reqheaders: { authorization: `Bearer ${TOKEN}`, "x-customer-ref": CUSTOMER, "x-trace-id": "tr_1" } })
      .get("/orders/1042")
      .reply(200, ok(order));
    const { api } = client();
    const r = await api.getOrder(CUSTOMER, "1042", { traceId: "tr_1" });
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") expect(r.data.status).toBe("PROCESSING");
  });

  it("404 -> NOT_FOUND", async () => {
    nock(BASE).get("/orders/9999").reply(404, err("ORDER_NOT_FOUND", "not found"));
    const { api } = client();
    expect(await api.getOrder(CUSTOMER, "9999")).toEqual({ kind: "NOT_FOUND" });
  });

  it("400 -> VALIDATION_ERROR", async () => {
    nock(BASE).get("/orders/12").reply(400, err("VALIDATION_ERROR", "bad id"));
    const { api } = client();
    expect(await api.getOrder(CUSTOMER, "12")).toEqual({ kind: "VALIDATION_ERROR", message: "bad id" });
  });

  it("500 -> TECHNICAL_ERROR without throwing", async () => {
    nock(BASE).get("/orders/1042").reply(500, err("TECHNICAL_ERROR", "boom"));
    const { api, log } = client();
    expect(await api.getOrder(CUSTOMER, "1042")).toEqual({ kind: "TECHNICAL_ERROR", cause: "HTTP_5XX", attempts: 1 });
    expect(log.lines().some((l) => l.event === "external.order_api.failed")).toBe(true);
  });

  it("timeout -> TECHNICAL_ERROR TIMEOUT", async () => {
    const { api } = client({ timeoutMs: 30, fetchImpl: hangingFetch(1).fetchImpl });
    expect(await api.getOrder(CUSTOMER, "1042")).toEqual({ kind: "TECHNICAL_ERROR", cause: "TIMEOUT", attempts: 1 });
  });

  it("network error -> TECHNICAL_ERROR NETWORK", async () => {
    nock(BASE).get("/orders/1042").replyWithError("ECONNRESET");
    const { api } = client();
    const r = await api.getOrder(CUSTOMER, "1042");
    expect(r).toMatchObject({ kind: "TECHNICAL_ERROR", cause: "NETWORK" });
  });

  it("malformed JSON and contract violations on 200 -> INVALID_RESPONSE", async () => {
    nock(BASE).get("/orders/1042").reply(200, "{not json", { "content-type": "application/json" });
    nock(BASE).get("/orders/1042").reply(200, ok({ ...order, status: "LOST_IN_SPACE" }));
    const { api } = client();
    expect(await api.getOrder(CUSTOMER, "1042")).toMatchObject({ kind: "TECHNICAL_ERROR", cause: "INVALID_RESPONSE" });
    expect(await api.getOrder(CUSTOMER, "1042")).toMatchObject({ kind: "TECHNICAL_ERROR", cause: "INVALID_RESPONSE" });
  });

  it("401 -> TECHNICAL_ERROR UNAUTHORIZED (no retry)", async () => {
    nock(BASE).get("/orders/1042").reply(401, err("UNAUTHORIZED", "no"));
    const { api } = client();
    expect(await api.getOrder(CUSTOMER, "1042")).toEqual({ kind: "TECHNICAL_ERROR", cause: "UNAUTHORIZED", attempts: 1 });
  });
});

describe("HttpOrderApiClient.cancel", () => {
  const cancelled = { orderId: "1042", status: "CANCELLED", cancelledAt: "2026-10-19T11:00:00.000Z", replayed: false };

  it("200 -> OK CANCELLED, sends Idempotency-Key", async () => {
    nock(BASE, { reqheaders: { "idempotency-key": "K1", authorization: `Bearer ${TOKEN}`, "x-customer-ref": CUSTOMER } })
      .post("/orders/1042/cancellation")
      .reply(200, ok(cancelled, "CANCELLED"));
    const { api } = client();
    const r = await api.cancel(CUSTOMER, "1042", "K1");
    expect(r).toMatchObject({ kind: "OK", code: "CANCELLED" });
  });

  it("409 -> NOT_CANCELLABLE with reason, never retried", async () => {
    nock(BASE)
      .post("/orders/1043/cancellation")
      .reply(409, err("ORDER_NOT_CANCELLABLE", "no", { orderId: "1043", currentStatus: "SHIPPED", reason: "ALREADY_SHIPPED" }));
    const { api } = client();
    expect(await api.cancel(CUSTOMER, "1043", "K2")).toEqual({ kind: "NOT_CANCELLABLE", reason: "ALREADY_SHIPPED", currentStatus: "SHIPPED" });
  });

  it("409 with broken details -> TECHNICAL_ERROR instead of guessing", async () => {
    nock(BASE).post("/orders/1043/cancellation").reply(409, err("ORDER_NOT_CANCELLABLE", "no", { foo: 1 }));
    const { api } = client();
    expect(await api.cancel(CUSTOMER, "1043", "K2")).toMatchObject({ kind: "TECHNICAL_ERROR", cause: "INVALID_RESPONSE" });
  });

  it("timeout then 200 retries ONCE with the SAME Idempotency-Key", async () => {
    // reqheaders makes the mock match only when the retry carries the same key.
    nock(BASE, { reqheaders: { "idempotency-key": "KEY-ABC" } })
      .post("/orders/1042/cancellation")
      .reply(200, ok({ ...cancelled, replayed: true }, "CANCELLED"));
    const h = hangingFetch(1);
    const { api, log } = client({ timeoutMs: 30, fetchImpl: h.fetchImpl });
    const r = await api.cancel(CUSTOMER, "1042", "KEY-ABC");
    expect(r).toMatchObject({ kind: "OK", code: "CANCELLED" });
    if (r.kind === "OK") expect(r.data.replayed).toBe(true);
    expect(h.calls.map((c) => c["Idempotency-Key"])).toEqual(["KEY-ABC", "KEY-ABC"]);
    expect(log.lines().filter((l) => l.event === "external.order_api.failed")).toHaveLength(1);
  });

  it("5xx on both attempts -> TECHNICAL_ERROR with attempts=2 (no third call)", async () => {
    nock(BASE, { reqheaders: { "idempotency-key": "K9" } })
      .post("/orders/1042/cancellation")
      .times(2)
      .reply(503, err("TECHNICAL_ERROR", "down"));
    const { api } = client();
    expect(await api.cancel(CUSTOMER, "1042", "K9")).toEqual({ kind: "TECHNICAL_ERROR", cause: "HTTP_5XX", attempts: 2 });
  });

  it("timeout on both attempts -> TECHNICAL_ERROR TIMEOUT attempts=2", async () => {
    const h = hangingFetch(5);
    const { api } = client({ timeoutMs: 30, fetchImpl: h.fetchImpl });
    expect(await api.cancel(CUSTOMER, "1042", "K9")).toEqual({ kind: "TECHNICAL_ERROR", cause: "TIMEOUT", attempts: 2 });
    expect(h.calls.map((c) => c["Idempotency-Key"])).toEqual(["K9", "K9"]);
  });

  it("400 -> VALIDATION_ERROR without retry", async () => {
    nock(BASE).post("/orders/1042/cancellation").reply(400, err("VALIDATION_ERROR", "missing key"));
    const { api } = client();
    expect(await api.cancel(CUSTOMER, "1042", "K1")).toMatchObject({ kind: "VALIDATION_ERROR" });
  });

  it("logs never contain the bearer token or the customer ref", async () => {
    nock(BASE).post("/orders/1042/cancellation").times(2).reply(503, err("TECHNICAL_ERROR", "down"));
    const { api, log } = client();
    await api.cancel(CUSTOMER, "1042", "K1");
    expect(log.raw()).not.toContain(TOKEN);
    expect(log.raw()).not.toContain(CUSTOMER);
  });
});
