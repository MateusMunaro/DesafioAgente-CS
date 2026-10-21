import { ErrorEnvelope, OrderView, successEnvelope, CancellationView } from "@desafio/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { TechnicalError } from "../../src/domain/errors.js";
import { ANA, BRUNO, TOKEN, auth, buildTestApp } from "../helpers/fixtures.js";

const KEY = "idem-key-0001";
const cancel = (app: Parameters<typeof request>[0], id: string, customer: string, key: string | null = KEY) => {
  const r = request(app).post(`/orders/${id}/cancellation`).set(auth).set("X-Customer-Ref", customer);
  return key === null ? r : r.set("Idempotency-Key", key);
};
const get = (app: Parameters<typeof request>[0], id: string, customer: string) =>
  request(app).get(`/orders/${id}`).set(auth).set("X-Customer-Ref", customer);

describe("GET /orders/:id", () => {
  it("200 with the order view, envelope and request id", async () => {
    const { app } = buildTestApp();
    const res = await get(app, "1042", ANA.id);
    expect(res.status).toBe(200);
    expect(successEnvelope(OrderView).parse(res.body)).toMatchObject({ ok: true, code: "OK", data: { id: "1042", status: "PROCESSING" } });
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });

  it("400 for malformed id and missing/invalid X-Customer-Ref", async () => {
    const { app } = buildTestApp();
    const badId = await get(app, "12", ANA.id);
    expect(badId.status).toBe(400);
    expect(ErrorEnvelope.parse(badId.body).code).toBe("VALIDATION_ERROR");
    expect(badId.body.details.fields).toEqual([{ path: "id", issue: "must be 4 to 10 digits" }]);

    const missing = await request(app).get("/orders/1042").set(auth);
    expect(missing.status).toBe(400);
    expect(missing.body.details.fields).toEqual([{ path: "X-Customer-Ref", issue: "is required" }]);

    const invalid = await get(app, "1042", "not-a-uuid");
    expect(invalid.status).toBe(400);
    expect(invalid.body.details.fields[0].path).toBe("X-Customer-Ref");
  });

  it("404 for an order that does not exist", async () => {
    const { app } = buildTestApp();
    const res = await get(app, "9999", ANA.id);
    expect(res.status).toBe(404);
    expect(ErrorEnvelope.parse(res.body)).toMatchObject({ code: "ORDER_NOT_FOUND", details: null });
  });

  it("TC-12: an order of another customer is indistinguishable from a missing one", async () => {
    const { app } = buildTestApp();
    const other = await get(app, "1050", ANA.id); // exists, belongs to Bruno
    const missing = await get(app, "9999", ANA.id);
    expect(other.status).toBe(404);
    expect(other.status).toBe(missing.status);
    const strip = ({ requestId: _r, ...rest }: Record<string, unknown>) => rest;
    expect(strip(other.body)).toEqual(strip(missing.body));
    expect(Object.keys(other.headers).filter((h) => h.startsWith("x-")).sort()).toEqual(
      Object.keys(missing.headers).filter((h) => h.startsWith("x-")).sort(),
    );
  });

  it("TC-12 (cancel): cancelling another customer's order is the same 404 and changes nothing", async () => {
    const { app, repo } = buildTestApp();
    const res = await cancel(app, "1050", ANA.id);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "ORDER_NOT_FOUND", details: null });
    expect(repo.snapshot("1050")?.status).toBe("PROCESSING");
    expect(repo.requestCount).toBe(0);
  });
});

describe("POST /orders/:id/cancellation", () => {
  it("200 CANCELLED when the order is PROCESSING and records history", async () => {
    const { app, repo } = buildTestApp();
    const res = await cancel(app, "1042", ANA.id).send({ channel: "agent", reasonCode: "CHANGED_MIND" });
    expect(res.status).toBe(200);
    const parsed = successEnvelope(CancellationView).parse(res.body);
    expect(parsed).toMatchObject({ ok: true, code: "CANCELLED", data: { orderId: "1042", status: "CANCELLED", replayed: false } });
    expect(repo.snapshot("1042")?.status).toBe("CANCELLED");
    expect(repo.history).toHaveLength(1);

    const after = await get(app, "1042", ANA.id);
    expect(after.body.data.status).toBe("CANCELLED");
    expect(after.body.data.cancelledAt).toBe(parsed.data.cancelledAt);
  });

  it("works without a body", async () => {
    const { app } = buildTestApp();
    expect((await cancel(app, "1042", ANA.id)).status).toBe(200);
  });

  it.each([
    ["1043", "SHIPPED", "ALREADY_SHIPPED"],
    ["1044", "DELIVERED", "ALREADY_DELIVERED"],
    ["1045", "CANCELLED", "ALREADY_CANCELLED"],
  ])("TC-07: order %s (%s) -> 409 %s and the database is untouched", async (id, status, reason) => {
    const { app, repo } = buildTestApp();
    const before = repo.snapshot(id);
    const res = await cancel(app, id, ANA.id);
    expect(res.status).toBe(409);
    expect(ErrorEnvelope.parse(res.body)).toMatchObject({
      ok: false,
      code: "ORDER_NOT_CANCELLABLE",
      details: { orderId: id, currentStatus: status, reason },
    });
    expect(repo.snapshot(id)).toBe(before);
    expect(repo.history).toHaveLength(0);
  });

  it("idempotency: same key replays the same 200 and cancels once", async () => {
    const { app, repo } = buildTestApp();
    const first = await cancel(app, "1042", ANA.id);
    const second = await cancel(app, "1042", ANA.id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.code).toBe("CANCELLED");
    expect(second.body.data.cancelledAt).toBe(first.body.data.cancelledAt);
    expect(first.body.data.replayed).toBe(false);
    expect(second.body.data.replayed).toBe(true);
    expect(repo.history).toHaveLength(1);
  });

  it("a new key on an already cancelled order is 409, not a second cancellation", async () => {
    const { app, repo } = buildTestApp();
    await cancel(app, "1042", ANA.id, "idem-key-0001");
    const again = await cancel(app, "1042", ANA.id, "idem-key-0002");
    expect(again.status).toBe(409);
    expect(again.body.details.reason).toBe("ALREADY_CANCELLED");
    expect(repo.history).toHaveLength(1);
  });

  it("a key already used for another order is a 400 and does not cancel", async () => {
    const { app, repo } = buildTestApp();
    // Bruno uses the key for his own order; Ana's replay of the same key on her order must not cancel it.
    await cancel(app, "1050", BRUNO.id, "shared-key-1");
    const res = await cancel(app, "1042", ANA.id, "shared-key-1");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(repo.snapshot("1042")?.status).toBe("PROCESSING");
  });

  it("TC-08 (race): order ships between the read and the POST -> 409 and not cancelled", async () => {
    const { app, repo } = buildTestApp();
    const read = await get(app, "1042", ANA.id);
    expect(read.body.data.status).toBe("PROCESSING");
    repo.setStatus("1042", "SHIPPED"); // warehouse ships it after the customer was told it is cancellable
    const res = await cancel(app, "1042", ANA.id);
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ orderId: "1042", currentStatus: "SHIPPED", reason: "ALREADY_SHIPPED" });
    expect(repo.snapshot("1042")?.status).toBe("SHIPPED");
  });

  it("400 for missing, short or oversized Idempotency-Key", async () => {
    const { app } = buildTestApp();
    const missing = await cancel(app, "1042", ANA.id, null);
    expect(missing.status).toBe(400);
    expect(missing.body.details.fields).toEqual([{ path: "Idempotency-Key", issue: "is required" }]);
    expect((await cancel(app, "1042", ANA.id, "short")).status).toBe(400);
    expect((await cancel(app, "1042", ANA.id, "x".repeat(129))).status).toBe(400);
  });

  it("400 for unknown body fields and malformed JSON", async () => {
    const { app, repo } = buildTestApp();
    const unknown = await cancel(app, "1042", ANA.id).send({ admin: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body.details.fields[0].path).toBe("body");
    const malformed = await cancel(app, "1042", ANA.id).set("Content-Type", "application/json").send("{ nope");
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("VALIDATION_ERROR");
    expect(repo.snapshot("1042")?.status).toBe("PROCESSING");
  });

  it("reports every invalid field at once", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/orders/1/cancellation").set(auth);
    expect(res.status).toBe(400);
    expect(res.body.details.fields.map((f: { path: string }) => f.path).sort()).toEqual(["Idempotency-Key", "X-Customer-Ref", "id"]);
  });
});

describe("authentication", () => {
  it("401 without token, with wrong token and with a wrong scheme", async () => {
    const { app } = buildTestApp();
    for (const header of [undefined, "Bearer wrong", `Basic ${TOKEN}`, "Bearer"]) {
      const r = request(app).get("/orders/1042").set("X-Customer-Ref", ANA.id);
      const res = await (header ? r.set("Authorization", header) : r);
      expect(res.status).toBe(401);
      expect(ErrorEnvelope.parse(res.body)).toMatchObject({ code: "UNAUTHORIZED", details: null });
    }
    const post = await request(app).post("/orders/1042/cancellation").set("X-Customer-Ref", ANA.id).set("Idempotency-Key", KEY);
    expect(post.status).toBe(401);
  });

  it("does not require a token on /health and /docs", async () => {
    const { app } = buildTestApp();
    expect((await request(app).get("/health")).status).toBe(200);
    expect((await request(app).get("/docs/")).status).toBe(200);
  });
});

describe("ops endpoints", () => {
  it("/health returns the envelope and 503 TECHNICAL_ERROR when the database is down", async () => {
    const { app, repo } = buildTestApp();
    const ok = await request(app).get("/health");
    expect(ok.body).toMatchObject({ ok: true, code: "OK", data: { status: "ok" } });
    repo.pingError = new Error("db down");
    const down = await request(app).get("/health");
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ ok: false, code: "TECHNICAL_ERROR", message: "Service temporarily unavailable" });
  });

  it("serves Swagger UI at /docs backed by openapi.yaml", async () => {
    const { app } = buildTestApp();
    const page = await request(app).get("/docs/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.text).toContain("swagger-ui");
    const init = await request(app).get("/docs/swagger-ui-init.js");
    expect(init.text).toContain("Order API");
    expect(init.text).toContain("/orders/{id}/cancellation");
  });

  it("unknown routes use the standard envelope", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/nope").set(auth);
    expect(res.status).toBe(404);
    expect(ErrorEnvelope.parse(res.body).code).toBe("ORDER_NOT_FOUND");
  });
});

describe("technical errors", () => {
  it("500 TECHNICAL_ERROR with a generic message when the repository throws", async () => {
    const { app, repo, logs } = buildTestApp();
    repo.failWith = new Error("SECRET row value Ana Souza +5511999990001");
    const res = await get(app, "1042", ANA.id);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, code: "TECHNICAL_ERROR", message: "Unexpected error", details: null });
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
    expect(logs.raw()).not.toContain("SECRET");
  });

  it("503 TECHNICAL_ERROR when the repository reports unavailability", async () => {
    const { app, repo } = buildTestApp();
    repo.failWith = new TechnicalError({ unavailable: true });
    const res = await cancel(app, "1042", ANA.id);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("TECHNICAL_ERROR");
  });
});

describe("logging", () => {
  it("uses X-Trace-Id when valid, generates one otherwise, and emits named events", async () => {
    const { app, logs } = buildTestApp();
    const res = await cancel(app, "1043", ANA.id).set("X-Trace-Id", "tr_9a02");
    expect(res.headers["x-trace-id"]).toBe("tr_9a02");
    const rejected = logs.entries().find((e) => e.event === "order.cancellation.rejected");
    expect(rejected).toMatchObject({
      level: "info",
      service: "order-api",
      traceId: "tr_9a02",
      orderId: "1043",
      reason: "ALREADY_SHIPPED",
      httpStatus: 409,
      requestId: res.body.requestId,
    });
    expect(typeof rejected?.durationMs).toBe("number");
    expect(String(rejected?.customerRef)).toMatch(/^cus_…[0-9a-f]{4}$/);

    const generated = await get(app, "1042", ANA.id).set("X-Trace-Id", "bad id with spaces!");
    expect(generated.headers["x-trace-id"]).toMatch(/^tr_[0-9a-f]{12}$/);
  });

  it("TC-21: no phone, name, token, full customer id or request body in logs", async () => {
    const { app, logs } = buildTestApp();
    await get(app, "1042", ANA.id);
    await get(app, "1050", ANA.id);
    await cancel(app, "1042", ANA.id).send({ channel: "agent", reasonCode: "SENSITIVE_FREE_TEXT_Ana_Souza" });
    await cancel(app, "1043", ANA.id, "idem-key-0009");
    await request(app).get("/orders/1042").set("Authorization", "Bearer super-secret-wrong-token").set("X-Customer-Ref", ANA.id);
    const raw = logs.raw();
    expect(raw.length).toBeGreaterThan(0);
    for (const forbidden of [ANA.phoneE164, ANA.displayName, "Souza", TOKEN, "super-secret-wrong-token", ANA.id, "SENSITIVE_FREE_TEXT", "Bearer"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
