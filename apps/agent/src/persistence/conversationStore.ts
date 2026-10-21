import { redactPii } from "../adapters/handoff/redact.js";

export interface RecordedMessage {
  threadId: string;
  /** Internal customer id when known. Stored only if it is a UUID (agent.conversations.customer_id). */
  customerRef?: string | undefined;
  direction: "IN" | "OUT";
  /** Raw body: the store redacts it before persisting. */
  body: string;
  intent?: string | undefined;
}

export interface ConversationStore {
  recordMessage(m: RecordedMessage): Promise<void>;
  markHandoff(threadId: string): Promise<void>;
}

/** Minimal subset of pg.Pool, so tests can pass a stub. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body that is safe to persist: PII scrubbed. */
export function redactBody(body: string): string {
  return redactPii(body);
}

export const UPSERT_CONVERSATION_SQL = `INSERT INTO agent.conversations (thread_id, customer_id, status, last_message_at)
VALUES ($1, $2, 'ACTIVE', now())
ON CONFLICT (thread_id) DO UPDATE SET
  last_message_at = now(),
  customer_id = COALESCE(agent.conversations.customer_id, EXCLUDED.customer_id)`;

export const INSERT_MESSAGE_SQL =
  "INSERT INTO agent.messages (thread_id, direction, body_redacted, intent) VALUES ($1, $2, $3, $4)";

export const MARK_HANDOFF_SQL = "UPDATE agent.conversations SET status = 'HANDOFF' WHERE thread_id = $1";

/** Persists conversations and messages in schema agent. Bodies are stored redacted. */
export class PgConversationStore implements ConversationStore {
  constructor(private readonly db: Queryable) {}

  async recordMessage(m: RecordedMessage): Promise<void> {
    const customerId = m.customerRef && UUID_RE.test(m.customerRef) ? m.customerRef : null;
    await this.db.query(UPSERT_CONVERSATION_SQL, [m.threadId, customerId]);
    await this.db.query(INSERT_MESSAGE_SQL, [m.threadId, m.direction, redactBody(m.body), m.intent ?? null]);
  }

  async markHandoff(threadId: string): Promise<void> {
    await this.db.query(MARK_HANDOFF_SQL, [threadId]);
  }
}

export interface StoredMessage {
  threadId: string;
  direction: "IN" | "OUT";
  bodyRedacted: string;
  intent: string | null;
  createdAt: string;
}

export class InMemoryConversationStore implements ConversationStore {
  readonly messages: StoredMessage[] = [];
  readonly conversations = new Map<string, { status: "ACTIVE" | "HANDOFF" | "CLOSED"; customerRef: string | null }>();

  async recordMessage(m: RecordedMessage): Promise<void> {
    const existing = this.conversations.get(m.threadId);
    this.conversations.set(m.threadId, { status: existing?.status ?? "ACTIVE", customerRef: existing?.customerRef ?? m.customerRef ?? null });
    this.messages.push({
      threadId: m.threadId,
      direction: m.direction,
      bodyRedacted: redactBody(m.body),
      intent: m.intent ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  async markHandoff(threadId: string): Promise<void> {
    const c = this.conversations.get(threadId);
    if (c) c.status = "HANDOFF";
  }
}
