import { randomUUID } from "node:crypto";
import type { HandoffPort, HandoffReason, Ticket } from "../../ports/index.js";
import { createLogger, type Logger } from "../logging.js";
import { redactPii } from "./redact.js";

/** Minimal subset of pg.Pool used here, so tests can pass a stub. */
export interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const INSERT_HANDOFF_SQL =
  "INSERT INTO agent.handoff_tickets (id, thread_id, reason, summary_redacted, status) VALUES ($1, $2, $3, $4, 'OPEN') RETURNING created_at";

/**
 * Stores tickets in agent.handoff_tickets (schema created by the graph migration).
 * If the database is down the customer must still be handed over, so open() never throws:
 * it returns a ticket with status UNPERSISTED and logs the failure.
 */
export class PgHandoffService implements HandoffPort {
  private readonly log: Logger;

  constructor(
    private readonly db: Queryable,
    opts: { logger?: Logger } = {},
  ) {
    this.log = opts.logger ?? createLogger();
  }

  async open(conversationId: string, reason: HandoffReason, summary: string): Promise<Ticket> {
    const id = randomUUID();
    const summaryRedacted = redactPii(summary);
    const base = { id, conversationId, reason, summary: summaryRedacted };
    try {
      const res = await this.db.query(INSERT_HANDOFF_SQL, [id, conversationId, reason, summaryRedacted]);
      const created = res.rows[0]?.created_at;
      const createdAt = created instanceof Date ? created.toISOString() : typeof created === "string" ? created : new Date().toISOString();
      this.log.info({ event: "handoff.opened", ticketId: id, thread: conversationId, reason });
      return { ...base, status: "OPEN", createdAt };
    } catch (err) {
      this.log.error({ event: "handoff.persist_failed", ticketId: id, thread: conversationId, reason, error: err instanceof Error ? err.name : "UNKNOWN" });
      return { ...base, status: "UNPERSISTED", createdAt: new Date().toISOString() };
    }
  }
}
