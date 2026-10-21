CREATE TABLE lastresort.reservations (
  reference uuid PRIMARY KEY,
  guest_session_id uuid NOT NULL REFERENCES lastresort.guest_sessions (id),
  event_id text NOT NULL REFERENCES lastresort.events (id),
  quantity integer NOT NULL CHECK (quantity = 1),
  status text NOT NULL CHECK (status = 'confirmed'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX reservations_owner_created_at_idx
  ON lastresort.reservations (guest_session_id, created_at DESC, reference);
CREATE INDEX reservations_event_id_idx ON lastresort.reservations (event_id);
