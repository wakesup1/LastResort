CREATE TABLE lastresort.events (
  id text PRIMARY KEY,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  venue text NOT NULL,
  ticket_type text NOT NULL,
  price_minor integer NOT NULL CHECK (price_minor = 0),
  sale_opens_at timestamptz NOT NULL,
  sale_closes_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0),
  remaining integer NOT NULL CHECK (remaining BETWEEN 0 AND capacity),
  CHECK (sale_opens_at < sale_closes_at),
  CHECK (sale_closes_at <= starts_at)
);
