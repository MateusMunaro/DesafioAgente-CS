import { CUSTOMER_FIXTURES } from "@desafio/contracts";
import { Writable } from "node:stream";
import { Order, type OrderStatus } from "../../src/domain/order.js";
import { InMemoryOrderRepository } from "../../src/infra/in-memory-order-repository.js";
import { createApp } from "../../src/http/app.js";
import { createLogger } from "../../src/infra/logger.js";

export const TOKEN = "test-token-123";
export const ANA = CUSTOMER_FIXTURES[0]!;
export const BRUNO = CUSTOMER_FIXTURES[1]!;

export function makeOrder(id: string, customerId: string, status: OrderStatus): Order {
  const shipped = status === "SHIPPED" || status === "DELIVERED";
  return new Order({
    id,
    customerId,
    status,
    totalAmount: 109.95,
    currency: "BRL",
    items: [{ productExternalId: 1, productTitle: "Fjallraven Backpack", quantity: 1, unitPrice: 109.95 }],
    createdAt: new Date("2026-10-19T14:00:00.000Z"),
    shippedAt: shipped ? new Date("2026-10-19T18:00:00.000Z") : null,
    cancelledAt: status === "CANCELLED" ? new Date("2026-10-19T15:00:00.000Z") : null,
  });
}

/** Mirrors seed.sql for the cases the tests care about. */
export function seededOrders(): Order[] {
  return [
    makeOrder("1042", ANA.id, "PROCESSING"),
    makeOrder("1043", ANA.id, "SHIPPED"),
    makeOrder("1044", ANA.id, "DELIVERED"),
    makeOrder("1045", ANA.id, "CANCELLED"),
    makeOrder("1050", BRUNO.id, "PROCESSING"),
  ];
}

/** Collects pino output lines so tests can assert on what was logged. */
export function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      cb();
    },
  });
  return {
    stream,
    lines,
    entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    raw: () => lines.join("\n"),
  };
}

export function buildTestApp(repo = new InMemoryOrderRepository(seededOrders())) {
  const logs = captureLogs();
  const logger = createLogger({ level: "debug", destination: logs.stream });
  const app = createApp({ repository: repo, logger, apiToken: TOKEN });
  return { app, repo, logs };
}

export const auth = { Authorization: `Bearer ${TOKEN}` };
