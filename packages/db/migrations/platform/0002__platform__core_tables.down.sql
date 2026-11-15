-- Dev/staging reversal.
DROP TABLE IF EXISTS platform.webhook_events_inbound, platform.notifications, platform.feature_flags,
  platform.idempotency_keys, platform.outbox, platform.operation_steps, platform.operations CASCADE;
