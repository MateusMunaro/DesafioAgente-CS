import { ORDER_STATUSES, type OrderStatus } from "@desafio/contracts";
import pg from "pg";
import { cancelReasonFor } from "../domain/cancellation-policy.js";
import { TechnicalError } from "../domain/errors.js";
import { Order, type OrderItem } from "../domain/order.js";
import type { CancelCommand, CancelOutcome, OrderRepository } from "../domain/order-repository.js";

/**
 * The cancellation is conditional on the current status: if the order was shipped between the
 * read and this statement, zero rows are updated and the caller gets 409.
 */
export const CANCEL_ORDER_SQL = `UPDATE orders.orders
   SET status = 'CANCELLED', cancelled_at = now(), version = version + 1
 WHERE id = $1 AND customer_id = $2 AND status = 'PROCESSING'
RETURNING cancelled_at`;

const FIND_ORDER_SQL = `SELECT id, customer_id, status, total_amount, currency, created_at, shipped_at, cancelled_at
  FROM orders.orders WHERE id = $1 AND customer_id = $2`;

const FIND_ITEMS_SQL = `SELECT product_external_id, product_title_snapshot, quantity, unit_price
  FROM orders.order_items WHERE order_id = $1 ORDER BY product_external_id, id`;

const LOCK_KEY_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;

const FIND_REQUEST_SQL = `SELECT order_id, outcome FROM orders.cancellation_requests WHERE idempotency_key = $1`;

const READ_STATUS_SQL = `SELECT status FROM orders.orders WHERE id = $1`;

const INSERT_REQUEST_SQL = `INSERT INTO orders.cancellation_requests (order_id, idempotency_key, outcome, reason_code, channel)
VALUES ($1, $2, $3, $4, $5)`;

const INSERT_HISTORY_SQL = `INSERT INTO orders.order_status_history (order_id, from_status, to_status, actor, reason_code)
VALUES ($1, $2, $3, $4, $5)`;

interface OrderRow {
  id: string;
  customer_id: string;
  status: string;
  total_amount: string;
  currency: string;
  created_at: Date;
  shipped_at: Date | null;
  cancelled_at: Date | null;
}

interface ItemRow {
  product_external_id: number;
  product_title_snapshot: string;
  quantity: number;
  unit_price: string;
}

function asStatus(value: string): OrderStatus {
  if ((ORDER_STATUSES as readonly string[]).includes(value)) return value as OrderStatus;
  throw new Error(`unexpected order status in database: ${value}`);
}

/** SQLSTATE classes and socket errors that mean "database unreachable / overloaded". */
function isUnavailable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  return (
    code.startsWith("08") || // connection exception
    code.startsWith("57P") || // admin shutdown, crash shutdown
    code === "53300" || // too many connections
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(code)
  );
}

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findForCustomer(orderId: string, customerId: string): Promise<Order | null> {
    return this.guard(async () => {
      const orderRes = await this.pool.query<OrderRow>(FIND_ORDER_SQL, [orderId, customerId]);
      const row = orderRes.rows[0];
      if (!row) return null;
      const itemsRes = await this.pool.query<ItemRow>(FIND_ITEMS_SQL, [orderId]);
      const items: OrderItem[] = itemsRes.rows.map((r) => ({
        productExternalId: r.product_external_id,
        productTitle: r.product_title_snapshot,
        quantity: r.quantity,
        unitPrice: Number(r.unit_price),
      }));
      return new Order({
        id: row.id,
        customerId: row.customer_id,
        status: asStatus(row.status),
        totalAmount: Number(row.total_amount),
        currency: row.currency.trim(),
        items,
        createdAt: row.created_at,
        shippedAt: row.shipped_at,
        cancelledAt: row.cancelled_at,
      });
    });
  }

  async cancelIfProcessing(cmd: CancelCommand): Promise<CancelOutcome> {
    return this.guard(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const outcome = await this.cancelInTransaction(client, cmd);
          await client.query("COMMIT");
          return outcome;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
      } finally {
        client.release();
      }
    });
  }

  private async cancelInTransaction(client: pg.PoolClient, cmd: CancelCommand): Promise<CancelOutcome> {
    // Serialises concurrent requests carrying the same Idempotency-Key (the UNIQUE index is the backstop).
    await client.query(LOCK_KEY_SQL, [cmd.idempotencyKey]);

    const orderRes = await client.query<{ status: string; cancelled_at: Date | null }>(
      `SELECT status, cancelled_at FROM orders.orders WHERE id = $1 AND customer_id = $2`,
      [cmd.orderId, cmd.customerId],
    );
    const current = orderRes.rows[0];
    if (!current) return { kind: "NOT_FOUND" };

    const existing = await client.query<{ order_id: string; outcome: string }>(FIND_REQUEST_SQL, [cmd.idempotencyKey]);
    const previous = existing.rows[0];
    if (previous) {
      if (previous.order_id !== cmd.orderId) return { kind: "KEY_CONFLICT" };
      if (previous.outcome === "CANCELLED" && current.cancelled_at) {
        return { kind: "CANCELLED", cancelledAt: current.cancelled_at, replayed: true };
      }
      return { kind: "NOT_CANCELLABLE", currentStatus: asStatus(current.status) };
    }

    const updated = await client.query<{ cancelled_at: Date }>(CANCEL_ORDER_SQL, [cmd.orderId, cmd.customerId]);
    const cancelled = updated.rows[0];
    if (cancelled) {
      await client.query(INSERT_REQUEST_SQL, [cmd.orderId, cmd.idempotencyKey, "CANCELLED", cmd.reasonCode ?? null, cmd.channel ?? null]);
      await client.query(INSERT_HISTORY_SQL, [cmd.orderId, "PROCESSING", "CANCELLED", "AGENT", cmd.reasonCode ?? null]);
      return { kind: "CANCELLED", cancelledAt: cancelled.cancelled_at, replayed: false };
    }

    // Lost the race (or it was never PROCESSING): read the status that won and record the rejection.
    const statusRes = await client.query<{ status: string }>(READ_STATUS_SQL, [cmd.orderId]);
    const statusRow = statusRes.rows[0];
    if (!statusRow) return { kind: "NOT_FOUND" };
    const currentStatus = asStatus(statusRow.status);
    if (currentStatus === "PROCESSING") throw new Error("order is PROCESSING but conditional update affected no rows");
    await client.query(INSERT_REQUEST_SQL, [
      cmd.orderId,
      cmd.idempotencyKey,
      "REJECTED",
      cancelReasonFor(currentStatus),
      cmd.channel ?? null,
    ]);
    return { kind: "NOT_CANCELLABLE", currentStatus };
  }

  async ping(): Promise<void> {
    await this.guard(() => this.pool.query("SELECT 1"));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isUnavailable(err)) throw new TechnicalError({ unavailable: true, cause: err });
      throw err;
    }
  }
}
