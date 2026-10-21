-- Order API schema. Owned by order-api; the agent only talks to it over HTTP.
CREATE SCHEMA IF NOT EXISTS orders;

CREATE TABLE orders.customers (
  id            uuid PRIMARY KEY,
  phone_e164    text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders.orders (
  id            text PRIMARY KEY CHECK (id ~ '^[0-9]{4,10}$'),
  customer_id   uuid NOT NULL REFERENCES orders.customers (id),
  status        text NOT NULL CHECK (status IN ('PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
  total_amount  numeric(12, 2) NOT NULL CHECK (total_amount >= 0),
  currency      char(3) NOT NULL DEFAULT 'BRL',
  created_at    timestamptz NOT NULL DEFAULT now(),
  shipped_at    timestamptz,
  cancelled_at  timestamptz,
  version       integer NOT NULL DEFAULT 1,
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);
CREATE INDEX orders_customer_id_idx ON orders.orders (customer_id);

CREATE TABLE orders.order_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                text NOT NULL REFERENCES orders.orders (id) ON DELETE CASCADE,
  -- Product id in the Fake Store API. No foreign key: it is an external system.
  product_external_id     integer NOT NULL CHECK (product_external_id > 0),
  product_title_snapshot  text NOT NULL,
  quantity                integer NOT NULL CHECK (quantity > 0),
  unit_price              numeric(12, 2) NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX order_items_order_id_idx ON orders.order_items (order_id);

CREATE TABLE orders.order_status_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     text NOT NULL REFERENCES orders.orders (id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  actor        text NOT NULL CHECK (actor IN ('AGENT', 'SYSTEM', 'HUMAN')),
  reason_code  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_id_idx ON orders.order_status_history (order_id);

CREATE TABLE orders.cancellation_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         text NOT NULL REFERENCES orders.orders (id) ON DELETE CASCADE,
  -- A key can be used only once: repeating it replays the stored result instead of cancelling again.
  idempotency_key  text NOT NULL UNIQUE,
  outcome          text NOT NULL CHECK (outcome IN ('CANCELLED', 'REJECTED')),
  reason_code      text,
  channel          text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cancellation_requests_order_id_idx ON orders.cancellation_requests (order_id);
