-- Dev/staging reversal only. Production audit data is never dropped (forward fix; see docs/05 §6).
DROP SCHEMA IF EXISTS audit CASCADE;
