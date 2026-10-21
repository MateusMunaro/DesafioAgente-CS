-- Demo data: orders in every status for the three fixture customers (see @desafio/contracts fixtures).
-- Idempotent: safe to run more than once. product_external_id follows the Fake Store ids 1..20.
BEGIN;

INSERT INTO orders.customers (id, phone_e164, display_name) VALUES
  ('11111111-1111-4111-8111-111111111111', '+5511999990001', 'Ana Souza'),
  ('22222222-2222-4222-8222-222222222222', '+5521988880002', 'Bruno Lima'),
  ('33333333-3333-4333-8333-333333333333', '+5531977770003', 'Carla Mendes')
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders.orders (id, customer_id, status, total_amount, currency, created_at, shipped_at, cancelled_at) VALUES
  -- Ana: one order per status. 1042 is cancellable, 1043 is not.
  ('1042', '11111111-1111-4111-8111-111111111111', 'PROCESSING', 109.95, 'BRL', '2026-10-19T14:00:00Z', NULL, NULL),
  ('1043', '11111111-1111-4111-8111-111111111111', 'SHIPPED',    119.99, 'BRL', '2026-10-17T09:30:00Z', '2026-10-18T10:00:00Z', NULL),
  ('1044', '11111111-1111-4111-8111-111111111111', 'DELIVERED',   54.45, 'BRL', '2026-10-05T11:00:00Z', '2026-10-06T08:00:00Z', NULL),
  ('1045', '11111111-1111-4111-8111-111111111111', 'CANCELLED',  599.00, 'BRL', '2026-10-14T16:20:00Z', NULL, '2026-10-15T09:00:00Z'),
  -- Bruno: used to prove isolation between customers.
  ('1050', '22222222-2222-4222-8222-222222222222', 'PROCESSING', 124.90, 'BRL', '2026-10-19T10:15:00Z', NULL, NULL),
  ('1051', '22222222-2222-4222-8222-222222222222', 'SHIPPED',    999.99, 'BRL', '2026-10-16T13:40:00Z', '2026-10-17T15:00:00Z', NULL),
  ('1052', '22222222-2222-4222-8222-222222222222', 'DELIVERED',  168.00, 'BRL', '2026-10-02T08:10:00Z', '2026-10-03T12:00:00Z', NULL),
  ('1053', '22222222-2222-4222-8222-222222222222', 'CANCELLED',   55.98, 'BRL', '2026-10-12T19:00:00Z', NULL, '2026-10-12T20:30:00Z'),
  -- Carla
  ('1060', '33333333-3333-4333-8333-333333333333', 'PROCESSING', 695.00, 'BRL', '2026-10-20T08:00:00Z', NULL, NULL),
  ('1061', '33333333-3333-4333-8333-333333333333', 'SHIPPED',     38.97, 'BRL', '2026-10-18T17:45:00Z', '2026-10-19T09:00:00Z', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders.order_items (order_id, product_external_id, product_title_snapshot, quantity, unit_price)
SELECT v.order_id, v.product_external_id, v.title, v.quantity, v.unit_price
FROM (VALUES
  ('1042',  1, 'Fjallraven Backpack',          1, 109.95::numeric),
  ('1043',  3, 'Mens Cotton Jacket',           1,  55.99),
  ('1043',  9, 'WD 2TB Portable Hard Drive',   1,  64.00),
  ('1044',  2, 'Mens Slim Fit T-Shirt',        2,  22.30),
  ('1044', 18, 'Women Boat Neck Shirt',        1,   9.85),
  ('1045', 13, 'Acer 21.5 inch Monitor',       1, 599.00),
  ('1050', 10, 'SanDisk SSD PLUS 1TB',         1, 109.00),
  ('1050', 19, 'Women Short Sleeve Shirt',     2,   7.95),
  ('1051', 14, 'Samsung 49 inch Gaming Monitor', 1, 999.99),
  ('1052',  6, 'Solid Gold Petite Micropave',  1, 168.00),
  ('1053', 17, 'Rain Jacket Windbreaker',      1,  39.99),
  ('1053',  4, 'Mens Casual Slim Fit',         1,  15.99),
  ('1060',  5, 'John Hardy Dragon Bracelet',   1, 695.00),
  ('1061', 20, 'Women Casual Cotton T-Shirt',  3,  12.99)
) AS v(order_id, product_external_id, title, quantity, unit_price)
WHERE NOT EXISTS (SELECT 1 FROM orders.order_items i WHERE i.order_id = v.order_id);

INSERT INTO orders.order_status_history (order_id, from_status, to_status, actor, reason_code, created_at)
SELECT v.order_id, v.from_status, v.to_status, v.actor, v.reason_code, v.at::timestamptz
FROM (VALUES
  ('1042', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-19T14:00:00Z'),
  ('1043', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-17T09:30:00Z'),
  ('1043', 'PROCESSING', 'SHIPPED',    'SYSTEM', NULL,        '2026-10-18T10:00:00Z'),
  ('1044', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-05T11:00:00Z'),
  ('1044', 'PROCESSING', 'SHIPPED',    'SYSTEM', NULL,        '2026-10-06T08:00:00Z'),
  ('1044', 'SHIPPED',    'DELIVERED',  'SYSTEM', NULL,        '2026-10-08T14:00:00Z'),
  ('1045', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-14T16:20:00Z'),
  ('1045', 'PROCESSING', 'CANCELLED',  'AGENT',  'CUSTOMER_REQUEST', '2026-10-15T09:00:00Z'),
  ('1050', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-19T10:15:00Z'),
  ('1051', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-16T13:40:00Z'),
  ('1051', 'PROCESSING', 'SHIPPED',    'SYSTEM', NULL,        '2026-10-17T15:00:00Z'),
  ('1052', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-02T08:10:00Z'),
  ('1052', 'PROCESSING', 'SHIPPED',    'SYSTEM', NULL,        '2026-10-03T12:00:00Z'),
  ('1052', 'SHIPPED',    'DELIVERED',  'SYSTEM', NULL,        '2026-10-05T16:00:00Z'),
  ('1053', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-12T19:00:00Z'),
  ('1053', 'PROCESSING', 'CANCELLED',  'AGENT',  'CUSTOMER_REQUEST', '2026-10-12T20:30:00Z'),
  ('1060', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-20T08:00:00Z'),
  ('1061', NULL,         'PROCESSING', 'SYSTEM', NULL,        '2026-10-18T17:45:00Z'),
  ('1061', 'PROCESSING', 'SHIPPED',    'SYSTEM', NULL,        '2026-10-19T09:00:00Z')
) AS v(order_id, from_status, to_status, actor, reason_code, at)
WHERE NOT EXISTS (SELECT 1 FROM orders.order_status_history h WHERE h.order_id = v.order_id);

INSERT INTO orders.cancellation_requests (order_id, idempotency_key, outcome, reason_code, channel, created_at) VALUES
  ('1045', 'seed-cancel-1045', 'CANCELLED', 'CUSTOMER_REQUEST', 'agent', '2026-10-15T09:00:00Z'),
  ('1053', 'seed-cancel-1053', 'CANCELLED', 'CUSTOMER_REQUEST', 'agent', '2026-10-12T20:30:00Z')
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;
