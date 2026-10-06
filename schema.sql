CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,                 -- también es la "reference" en Wompi
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_name         TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  city                  TEXT NOT NULL,
  address               TEXT NOT NULL,
  notes                 TEXT,
  items                 JSONB NOT NULL,
  total_cop             INTEGER NOT NULL CHECK (total_cop > 0),
  payment_status        TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (payment_status IN ('PENDING','APPROVED','DECLINED','VOIDED','ERROR')),
  payment_method        TEXT,
  wompi_transaction_id  TEXT,
  paid_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_status_idx  ON orders (payment_status);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (        -- bitácora de cada aviso de Wompi
  id                    BIGSERIAL PRIMARY KEY,
  order_id              TEXT REFERENCES orders(id),
  wompi_transaction_id  TEXT,
  status                TEXT,
  payload               JSONB,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
