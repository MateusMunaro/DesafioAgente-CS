import type pg from "pg";
import { describe, expect, it } from "vitest";
import { CANCEL_ORDER_SQL, PgOrderRepository } from "../../src/infra/pg-order-repository.js";

interface Call {
  sql: string;
  params: unknown[] | undefined;
}

type Responder = (sql: string, params: unknown[] | undefined) => { rows: unknown[] };

/** Scripted pool: records every statement so the transaction shape and the conditional SQL can be asserted. */
function fakePool(respond: Responder) {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return respond(sql, params);
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client, query: client.query } as unknown as pg.Pool;
  return { pool, calls };
}

const cmd = { orderId: "1042", customerId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "key-12345678", channel: "agent" };

describe("PgOrderRepository SQL (no database needed)", () => {
  it("cancel statement is conditional on status = PROCESSING and scoped to the customer", () => {
    expect(CANCEL_ORDER_SQL).toMatch(/UPDATE orders\.orders/);
    expect(CANCEL_ORDER_SQL).toMatch(/WHERE id = \$1 AND customer_id = \$2 AND status = 'PROCESSING'/);
  });

  it("success path: one transaction with lock, conditional UPDATE, request and history rows", async () => {
    const cancelledAt = new Date("2026-10-19T15:00:00.000Z");
    const { pool, calls } = fakePool((sql) => {
      if (sql.startsWith("SELECT status, cancelled_at")) return { rows: [{ status: "PROCESSING", cancelled_at: null }] };
      if (sql.includes("FROM orders.cancellation_requests")) return { rows: [] };
      if (sql.startsWith("UPDATE orders.orders")) return { rows: [{ cancelled_at: cancelledAt }] };
      return { rows: [] };
    });
    const outcome = await new PgOrderRepository(pool).cancelIfProcessing(cmd);
    expect(outcome).toEqual({ kind: "CANCELLED", cancelledAt, replayed: false });
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.at(-1)).toBe("COMMIT");
    expect(sqls.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(sqls.some((s) => s.includes("status = 'PROCESSING'"))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO orders.cancellation_requests"))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO orders.order_status_history"))).toBe(true);
  });

  it("lost race: zero rows updated -> reads the winning status, records REJECTED, never writes history", async () => {
    const { pool, calls } = fakePool((sql) => {
      if (sql.startsWith("SELECT status, cancelled_at")) return { rows: [{ status: "PROCESSING", cancelled_at: null }] };
      if (sql.includes("FROM orders.cancellation_requests")) return { rows: [] };
      if (sql.startsWith("UPDATE orders.orders")) return { rows: [] }; // shipped in between
      if (sql.startsWith("SELECT status FROM orders.orders")) return { rows: [{ status: "SHIPPED" }] };
      return { rows: [] };
    });
    const outcome = await new PgOrderRepository(pool).cancelIfProcessing(cmd);
    expect(outcome).toEqual({ kind: "NOT_CANCELLABLE", currentStatus: "SHIPPED" });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO orders.cancellation_requests"));
    expect(insert?.params).toEqual(["1042", "key-12345678", "REJECTED", "ALREADY_SHIPPED", "agent"]);
    expect(calls.some((c) => c.sql.includes("order_status_history"))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("replay of a used key returns the stored result without issuing the UPDATE", async () => {
    const cancelledAt = new Date("2026-10-19T15:00:00.000Z");
    const { pool, calls } = fakePool((sql) => {
      if (sql.startsWith("SELECT status, cancelled_at")) return { rows: [{ status: "CANCELLED", cancelled_at: cancelledAt }] };
      if (sql.includes("FROM orders.cancellation_requests")) return { rows: [{ order_id: "1042", outcome: "CANCELLED" }] };
      return { rows: [] };
    });
    const outcome = await new PgOrderRepository(pool).cancelIfProcessing(cmd);
    expect(outcome).toEqual({ kind: "CANCELLED", cancelledAt, replayed: true });
    expect(calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
  });

  it("order of another customer yields NOT_FOUND and rolls nothing forward", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    const outcome = await new PgOrderRepository(pool).cancelIfProcessing(cmd);
    expect(outcome).toEqual({ kind: "NOT_FOUND" });
    expect(calls.some((c) => c.sql.startsWith("UPDATE") || c.sql.startsWith("INSERT"))).toBe(false);
  });

  it("key already used for another order is a KEY_CONFLICT", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.startsWith("SELECT status, cancelled_at")) return { rows: [{ status: "PROCESSING", cancelled_at: null }] };
      if (sql.includes("FROM orders.cancellation_requests")) return { rows: [{ order_id: "9999", outcome: "CANCELLED" }] };
      return { rows: [] };
    });
    expect(await new PgOrderRepository(pool).cancelIfProcessing(cmd)).toEqual({ kind: "KEY_CONFLICT" });
  });

  it("rolls back and maps connection errors to a 503 TechnicalError", async () => {
    const { pool, calls } = fakePool((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) throw Object.assign(new Error("boom"), { code: "57P01" });
      return { rows: [] };
    });
    await expect(new PgOrderRepository(pool).cancelIfProcessing(cmd)).rejects.toMatchObject({ code: "TECHNICAL_ERROR", httpStatus: 503 });
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
