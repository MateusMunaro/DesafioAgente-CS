/**
 * API side of the documented cases (docs/casos-de-teste.md). TC-07, TC-08, TC-12 and TC-21 live in
 * orders.api.test.ts and the Testcontainers suite; this file adds the remaining ones that the Order API owns.
 */
import { CancellationView, ErrorEnvelope, OrderView, successEnvelope } from "@desafio/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { TechnicalError } from "../../src/domain/errors.js";
import { ANA, auth, buildTestApp } from "../helpers/fixtures.js";

const get = (app: Parameters<typeof request>[0], id: string) => request(app).get(`/orders/${id}`).set(auth).set("X-Customer-Ref", ANA.id);
const cancel = (app: Parameters<typeof request>[0], id: string, key = "tc-case-key-0001") =>
  request(app).post(`/orders/${id}/cancellation`).set(auth).set("X-Customer-Ref", ANA.id).set("Idempotency-Key", key);

describe("documented cases on the Order API", () => {
  it("TC-03 order not found: 404 ORDER_NOT_FOUND with the standard envelope, for GET and for cancellation", async () => {
    const { app, repo } = buildTestApp();
    const g = await get(app, "9999");
    expect(g.status).toBe(404);
    expect(ErrorEnvelope.parse(g.body)).toMatchObject({ ok: false, code: "ORDER_NOT_FOUND", details: null });
    const c = await cancel(app, "9999");
    expect(c.status).toBe(404);
    expect(c.body.code).toBe("ORDER_NOT_FOUND");
    expect(repo.history).toHaveLength(0);
  });

  it("TC-10 technical failure: while the repository is down both calls answer 503 TECHNICAL_ERROR and nothing changes; the retry with the same key then cancels exactly once", async () => {
    const { app, repo } = buildTestApp();
    repo.failWith = new TechnicalError({ unavailable: true });
    const g = await get(app, "1042");
    const c1 = await cancel(app, "1042");
    const c2 = await cancel(app, "1042");
    for (const res of [g, c1, c2]) {
      expect(res.status).toBe(503);
      expect(ErrorEnvelope.parse(res.body).code).toBe("TECHNICAL_ERROR");
    }
    expect(repo.snapshot("1042")?.status).toBe("PROCESSING");
    expect(repo.history).toHaveLength(0);

    repo.failWith = null; // the API is back: the agent's third attempt with the same key
    const ok = await cancel(app, "1042");
    const replay = await cancel(app, "1042");
    expect(ok.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.data.cancelledAt).toBe(ok.body.data.cancelledAt);
    expect(repo.history).toHaveLength(1);
  });

  it("TC-13 already cancelled order: 409 ORDER_NOT_CANCELLABLE with reason ALREADY_CANCELLED, no second cancellation", async () => {
    const { app, repo } = buildTestApp();
    const before = repo.snapshot("1045");
    const res = await cancel(app, "1045");
    expect(res.status).toBe(409);
    expect(ErrorEnvelope.parse(res.body)).toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      details: { orderId: "1045", currentStatus: "CANCELLED", reason: "ALREADY_CANCELLED" },
    });
    expect(repo.snapshot("1045")).toBe(before);
    expect(repo.history).toHaveLength(0);
    expect(OrderView.parse((await get(app, "1045")).body.data).status).toBe("CANCELLED");
  });

  it("TC-22 cancellation: a PROCESSING order becomes CANCELLED in one call, and the next GET shows it", async () => {
    const { app, repo } = buildTestApp();
    const res = await cancel(app, "1042");
    expect(res.status).toBe(200);
    expect(successEnvelope(CancellationView).parse(res.body)).toMatchObject({ code: "CANCELLED", data: { orderId: "1042", status: "CANCELLED", replayed: false } });
    expect(OrderView.parse((await get(app, "1042")).body.data).status).toBe("CANCELLED");
    expect(repo.history).toEqual([expect.objectContaining({ orderId: "1042", fromStatus: "PROCESSING", toStatus: "CANCELLED" })]);
  });
});
