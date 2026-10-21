import { randomUUID } from "node:crypto";
import type { HandoffPort, HandoffReason, Ticket } from "../../ports/index.js";
import { createLogger, type Logger } from "../logging.js";
import { redactPii } from "./redact.js";

export class InMemoryHandoffService implements HandoffPort {
  private readonly store: Ticket[] = [];
  private readonly log: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = opts.logger ?? createLogger();
  }

  async open(conversationId: string, reason: HandoffReason, summary: string): Promise<Ticket> {
    const ticket: Ticket = {
      id: randomUUID(),
      conversationId,
      reason,
      summary: redactPii(summary),
      status: "OPEN",
      createdAt: new Date().toISOString(),
    };
    this.store.push(ticket);
    this.log.info({ event: "handoff.opened", ticketId: ticket.id, thread: conversationId, reason });
    return ticket;
  }

  get tickets(): readonly Ticket[] {
    return [...this.store];
  }
}
