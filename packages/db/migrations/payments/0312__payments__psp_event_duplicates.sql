-- M03 S12d: duplicate-event indicator for the admin payments screen (docs/11, UI-M03-14). A PSP event id is stored once (UNIQUE (psp, event_id));
-- a redelivery used to vanish without a trace. It is now counted on the stored event, so finance can see that a provider resent an event and
-- that the platform ignored the resend (one business effect per event). Only these two columns are new; no payload is stored for a duplicate.
ALTER TABLE payments.psp_events
  ADD COLUMN duplicate_count int NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  ADD COLUMN last_duplicate_at timestamptz;
