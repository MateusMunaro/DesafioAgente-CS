-- Agent schema. Owned by the agent; LangGraph checkpoint tables are created in this same schema by PostgresSaver.setup().
CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE agent.conversations (
  thread_id        text PRIMARY KEY,           -- channel:hash(phone), e.g. wa:3f9a...
  -- Logical reference to orders.customers (different service, no physical FK).
  customer_id      uuid,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'HANDOFF', 'CLOSED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent.messages (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id      text NOT NULL REFERENCES agent.conversations (thread_id) ON DELETE CASCADE,
  direction      text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  -- PII (phone, e-mail, CPF) is redacted before insert. Never the raw message.
  body_redacted  text NOT NULL,
  intent         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_created_idx ON agent.messages (thread_id, created_at);

CREATE TABLE agent.handoff_tickets (
  id                uuid PRIMARY KEY,
  thread_id         text NOT NULL REFERENCES agent.conversations (thread_id) ON DELETE CASCADE,
  reason            text NOT NULL CHECK (reason IN ('OUT_OF_SCOPE', 'API_FAILURE', 'USER_REQUEST', 'AMBIGUITY')),
  summary_redacted  text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handoff_tickets_thread_idx ON agent.handoff_tickets (thread_id);
