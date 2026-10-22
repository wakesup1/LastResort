CREATE TABLE lastresort.booking_operations (
  guest_session_id uuid NOT NULL REFERENCES lastresort.guest_sessions (id),
  operation_key uuid NOT NULL,
  event_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity = 1),
  response jsonb CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (guest_session_id, operation_key)
);

-- Pending rows exist only inside the booking transaction. No TTL or automatic key reuse.
