-- Dev/staging reversal.
DROP POLICY IF EXISTS flags_platform ON platform.feature_flags;
DROP POLICY IF EXISTS recipient_only ON platform.notifications;
DROP TABLE IF EXISTS platform.notification_preferences;
