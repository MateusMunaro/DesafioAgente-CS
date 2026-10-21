import { execFileSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.js";
import { runMigrations, runSeed } from "../../src/infra/db/migrate.js";
import { createLogger } from "../../src/infra/logger.js";
import { PgOrderRepository } from "../../src/infra/pg-order-repository.js";
import { ANA, BRUNO, TOKEN, auth } from "../helpers/fixtures.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker) {
  console.warn("[order-api] Docker is not available: skipping Testcontainers integration tests (PgOrderRepository).");
}

describe.skipIf(!hasDocker)("PgOrderRepository + HTTP (Postgres via Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  const scalar = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await pool.query(sql, params)).rows[0] as T;
  const cancel = (id: string, customer: string, key: string) =>
    request(app).post(`/orders/${id}/cancellation`).set(auth).set("X-Customer-Ref", customer).set("Idempotency-Key", key);
  const get = (id: string, customer: string) => request(app).get(`/orders/${id}`).set(auth).set("X-Customer-Ref", customer);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });
    await runMigrations(pool);
    await runSeed(pool);
    await runSeed(pool); // seed must be idempotent
    app = createApp({ repository: new PgOrderRepository(pool), logger: createLogger({ level: "silent" }), apiToken: TOKEN });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("migrations are idempotent and the seed covers every status", async () => {
    expect(await runMigrations(pool)).toEqual([]);
    const rows = (await pool.query("SELECT DISTINCT status FROM orders.orders ORDER BY status")).rows.map((r) => r.status);
    expect(rows).toEqual(["CANCELLED", "DELIVERED", "PROCESSING", "SHIPPED"]);
    const items = await scalar<{ n: string }>("SELECT count(*) AS n FROM orders.order_items WHERE order_id = '1042'");
    expect(items.n).toBe("1");
  });

  it("GET returns the seeded order with items and numeric amounts", async () => {
    const res = await get("1043", ANA.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: "1043", status: "SHIPPED", currency: "BRL", totalAmount: 119.99 });
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.shippedAt).not.toBeNull();
  });

  it("TC-12: another customer's order and a missing order give the same 404", async () => {
    const other = await get("1050", ANA.id);
    const missing = await get("9998", ANA.id);
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect({ ...other.body, requestId: "x" }).toEqual({ ...missing.body, requestId: "x" });
    const cancelOther = await cancel("1050", ANA.id, "int-other-cust-01");
    expect(cancelOther.status).toBe(404);
    expect((await scalar<{ status: string }>("SELECT status FROM orders.orders WHERE id = '1050'")).status).toBe("PROCESSING");
  });

  it("TC-07: cancelling a SHIPPED order is a 409 and nothing changes in the database", async () => {
    const res = await cancel("1043", ANA.id, "int-shipped-0001");
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ orderId: "1043", currentStatus: "SHIPPED", reason: "ALREADY_SHIPPED" });
    expect((await scalar<{ status: string; version: number }>("SELECT status, version FROM orders.orders WHERE id = '1043'"))).toEqual({
      status: "SHIPPED",
      version: 1,
    });
    const hist = await scalar<{ n: string }>("SELECT count(*) AS n FROM orders.order_status_history WHERE order_id = '1043' AND to_status = 'CANCELLED'");
    expect(hist.n).toBe("0");
  });

  it("cancels atomically: order, request row and history row in one go; replay returns the same 200", async () => {
    const first = await cancel("1042", ANA.id, "int-idem-0001").send({ channel: "agent", reasonCode: "CHANGED_MIND" });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ orderId: "1042", status: "CANCELLED", replayed: false });

    const replay = await cancel("1042", ANA.id, "int-idem-0001");
    expect(replay.status).toBe(200);
    expect(replay.body.data.cancelledAt).toBe(first.body.data.cancelledAt);
    expect(replay.body.data.replayed).toBe(true);

    const order = await scalar<{ status: string; version: number }>("SELECT status, version FROM orders.orders WHERE id = '1042'");
    expect(order).toEqual({ status: "CANCELLED", version: 2 });
    const requests = await scalar<{ n: string; channel: string; reason_code: string }>(
      "SELECT count(*) AS n, max(channel) AS channel, max(reason_code) AS reason_code FROM orders.cancellation_requests WHERE idempotency_key = 'int-idem-0001'",
    );
    expect(requests).toEqual({ n: "1", channel: "agent", reason_code: "CHANGED_MIND" });
    const hist = await scalar<{ n: string }>("SELECT count(*) AS n FROM orders.order_status_history WHERE order_id = '1042' AND to_status = 'CANCELLED'");
    expect(hist.n).toBe("1");

    // A different key on the now cancelled order is a 409, never a second cancellation.
    const other = await cancel("1042", ANA.id, "int-idem-0002");
    expect(other.status).toBe(409);
    expect(other.body.details.reason).toBe("ALREADY_CANCELLED");
  });

  it("TC-08: order becomes SHIPPED between the read and the POST -> 409 and it stays SHIPPED", async () => {
    const carla = (await scalar<{ customer_id: string }>("SELECT customer_id FROM orders.orders WHERE id = '1060'")).customer_id;
    const read = await get("1060", carla);
    expect(read.body.data.status).toBe("PROCESSING");

    await pool.query("UPDATE orders.orders SET status = 'SHIPPED', shipped_at = now() WHERE id = '1060'");

    const res = await cancel("1060", carla, "int-race-0001");
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ orderId: "1060", currentStatus: "SHIPPED", reason: "ALREADY_SHIPPED" });
    expect((await scalar<{ status: string; cancelled_at: Date | null }>("SELECT status, cancelled_at FROM orders.orders WHERE id = '1060'"))).toEqual({
      status: "SHIPPED",
      cancelled_at: null,
    });
    // The rejection is recorded and replaying that key gives the same 409.
    const stored = await scalar<{ outcome: string; reason_code: string }>(
      "SELECT outcome, reason_code FROM orders.cancellation_requests WHERE idempotency_key = 'int-race-0001'",
    );
    expect(stored).toEqual({ outcome: "REJECTED", reason_code: "ALREADY_SHIPPED" });
    expect((await cancel("1060", carla, "int-race-0001")).status).toBe(409);
  });

  it("concurrent requests with the same key cancel exactly once and all answer 200", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => cancel("1050", BRUNO.id, "int-concurrent-01")));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(responses.filter((r) => r.body.data.replayed === false)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.data.cancelledAt)).size).toBe(1);
    const hist = await scalar<{ n: string }>("SELECT count(*) AS n FROM orders.order_status_history WHERE order_id = '1050' AND to_status = 'CANCELLED'");
    expect(hist.n).toBe("1");
  });

  it("concurrent requests with different keys: one 200, the rest 409 (conditional UPDATE)", async () => {
    const carlaId = (await scalar<{ id: string }>("SELECT id FROM orders.customers WHERE phone_e164 = '+5531977770003'")).id;
    await pool.query(
      `INSERT INTO orders.orders (id, customer_id, status, total_amount) VALUES ('7001', $1, 'PROCESSING', 10.00)`,
      [carlaId],
    );
    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => cancel("7001", carlaId, `int-multi-key-${i}`)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    const hist = await scalar<{ n: string }>("SELECT count(*) AS n FROM orders.order_status_history WHERE order_id = '7001'");
    expect(hist.n).toBe("1");
  });

  it("the idempotency key is UNIQUE at the database level", async () => {
    await expect(
      pool.query(
        "INSERT INTO orders.cancellation_requests (order_id, idempotency_key, outcome) VALUES ('1042', 'int-idem-0001', 'CANCELLED')",
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("/health reports ok against a real database", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
  });
});
