import { randomUUID } from "node:crypto";
import type { MessagingPort, SendResult } from "../../ports/index.js";
import { createLogger, type Logger } from "../logging.js";

export interface OutboxMessage {
  id: string;
  to: string;
  text: string;
  sentAt: string;
}

/** In-memory outbox standing in for WhatsApp/SMS. Logs only the size of the text, never the content. */
export class MockMessagingGateway implements MessagingPort {
  private readonly messages: OutboxMessage[] = [];
  private readonly log: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = opts.logger ?? createLogger();
  }

  async send(to: string, text: string): Promise<SendResult> {
    if (!to || !text.trim()) {
      this.log.warn({ event: "messaging.send.rejected", textChars: text.length });
      return { kind: "FAILED", reason: "EMPTY_RECIPIENT_OR_TEXT" };
    }
    const msg: OutboxMessage = { id: randomUUID(), to, text, sentAt: new Date().toISOString() };
    this.messages.push(msg);
    this.log.info({ event: "messaging.sent", messageId: msg.id, textChars: text.length });
    return { kind: "SENT", messageId: msg.id };
  }

  /** Snapshot of everything sent so far (for tests and the CLI simulator). */
  get outbox(): readonly OutboxMessage[] {
    return [...this.messages];
  }

  sentTo(to: string): OutboxMessage[] {
    return this.messages.filter((m) => m.to === to);
  }

  clear(): void {
    this.messages.length = 0;
  }
}
