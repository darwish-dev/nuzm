-- M08 S35-S36: email. Sending/mailbox domains with their DNS state, mailboxes and aliases, sender identities, templates, messages, events, suppressions.
--  * email_domains: Nuzm's OWN ownership proof (a TXT token generated here, bound to the organization) plus the records the provider adapter says are required.
--    Only one organization can hold a VERIFIED claim on a domain (partial unique index): an unverified claim proves nothing and never lets anyone send.
--  * messages: recipients are `personal`: stored sealed (recipients_enc, field-level) with salted-free SHA-256 hashes for lookup; the body is stored as a HASH by default,
--    sealed (body_enc) only when the organization enabled retention, and removed when expires_at passes. A message is unique per (org, Idempotency-Key).
--  * email_events is APPEND-ONLY (trigger); provider events are unique per (provider, provider event id): a duplicate webhook can never add a second row.
--  * suppressions: unique (org, address hash, reason); the address is sealed for display; removal is a flag with who/when (nothing is deleted).
CREATE SCHEMA IF NOT EXISTS email;
GRANT USAGE ON SCHEMA email TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('email:read','org','Read email domains, mailboxes, senders, templates, messages, events and suppressions'),
  ('email:domain:manage','org','Add and verify email domains, manage sender identities and suppressions'),
  ('email:mailbox:manage','org','Create, change and delete mailboxes and aliases'),
  ('email:send','org','Send transactional email'),
  ('email:template:write','org','Create and version email templates');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','email:read'),('admin','email:read'),('billing_admin','email:read'),('developer','email:read'),('viewer','email:read'),
  ('owner','email:domain:manage'),('admin','email:domain:manage'),
  ('owner','email:mailbox:manage'),('admin','email:mailbox:manage'),
  ('owner','email:send'),('admin','email:send'),('developer','email:send'),
  ('owner','email:template:write'),('admin','email:template:write'),('developer','email:template:write');

CREATE TABLE email.email_domains (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  domain text NOT NULL CHECK (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' AND length(domain) <= 253),
  purposes text[] NOT NULL CHECK (purposes <> '{}' AND purposes <@ ARRAY['mailbox','transactional']::text[]),
  verification_state text NOT NULL DEFAULT 'pending' CHECK (verification_state IN ('pending','partial','verified','failed')),
  ownership_token text NOT NULL CHECK (ownership_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  required_records jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{type,name,value,priority?,purpose,required,status,detail?}]
  dmarc jsonb,                                           -- {state, suggestion?}
  tx_provider_id uuid,                                   -- logical references to data.data_providers
  tx_provider_ref text,
  mailbox_provider_id uuid,
  dns_zone_id uuid,                                      -- logical reference to domains.dns_zones (M07), when the domain's DNS is a Nuzm zone
  data_region text NOT NULL,
  verified_at timestamptz,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  check_attempts int NOT NULL DEFAULT 0,
  throttle_override jsonb,
  version_lock int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((verification_state = 'verified') = (verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX email_domains_org_domain_idx ON email.email_domains (org_id, domain) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX email_domains_one_verified_idx ON email.email_domains (domain) WHERE verification_state = 'verified' AND deleted_at IS NULL;
CREATE INDEX email_domains_org_idx ON email.email_domains (org_id, created_at DESC, id);
CREATE FUNCTION email.domain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'email domains are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.domain <> OLD.domain OR NEW.ownership_token <> OLD.ownership_token OR NEW.data_region <> OLD.data_region OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of an email domain is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER email_domain_guard BEFORE UPDATE OR DELETE ON email.email_domains FOR EACH ROW EXECUTE FUNCTION email.domain_guard();
CREATE TRIGGER email_domain_no_truncate BEFORE TRUNCATE ON email.email_domains FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

CREATE TABLE email.mailboxes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  domain_id uuid NOT NULL REFERENCES email.email_domains(id),
  local_part text NOT NULL CHECK (local_part ~ '^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$'),
  state text NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','active','suspended','failed','deleting','deleted','unknown')),
  provider_id uuid,
  provider_ref text,
  plan_ref text,
  quota_mb int NOT NULL CHECK (quota_mb BETWEEN 1 AND 1048576),
  password_setup jsonb,                                  -- {kind: reset_link|one_time_secret, state: pending|issued, ref: vault ref}: never plaintext
  create_token text NOT NULL,
  quote_id uuid,
  order_id uuid,
  usage jsonb,
  operation_id uuid,
  data_region text NOT NULL,
  version_lock int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX mailboxes_address_idx ON email.mailboxes (domain_id, local_part) WHERE state <> 'deleted';
CREATE UNIQUE INDEX mailboxes_token_idx ON email.mailboxes (create_token);
CREATE INDEX mailboxes_org_idx ON email.mailboxes (org_id, created_at DESC, id);
CREATE FUNCTION email.mailbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mailboxes are never deleted (state=deleted)' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.domain_id <> OLD.domain_id OR NEW.local_part <> OLD.local_part OR NEW.create_token <> OLD.create_token OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a mailbox is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state = 'deleted' THEN RAISE EXCEPTION 'a deleted mailbox cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER mailbox_guard BEFORE UPDATE OR DELETE ON email.mailboxes FOR EACH ROW EXECUTE FUNCTION email.mailbox_guard();
CREATE TRIGGER mailbox_no_truncate BEFORE TRUNCATE ON email.mailboxes FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

CREATE TABLE email.aliases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  domain_id uuid NOT NULL REFERENCES email.email_domains(id),
  mailbox_id uuid NOT NULL REFERENCES email.mailboxes(id),
  local_part text NOT NULL CHECK (local_part ~ '^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$'),
  state text NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','active','failed','unknown')),
  create_token text NOT NULL,
  operation_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX aliases_address_idx ON email.aliases (domain_id, local_part);
CREATE INDEX aliases_org_idx ON email.aliases (org_id, created_at DESC, id);

CREATE TABLE email.sender_identities (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  domain_id uuid NOT NULL REFERENCES email.email_domains(id),
  from_address text NOT NULL CHECK (from_address ~ '^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?@[a-z0-9.-]+$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','disabled')),
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, from_address),
  CHECK ((state = 'verified') = (verified_at IS NOT NULL))
);
CREATE INDEX sender_identities_org_idx ON email.sender_identities (org_id, created_at DESC, id);

CREATE TABLE email.templates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{1,62}$'),
  version int NOT NULL CHECK (version >= 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  locale text NOT NULL CHECK (locale IN ('ar','en')),
  direction text NOT NULL CHECK (direction IN ('rtl','ltr')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300 AND subject !~ '[\r\n]'),
  html text NOT NULL CHECK (length(html) <= 200000),     -- already sanitized
  body_text text CHECK (body_text IS NULL OR length(body_text) <= 100000),
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key, version),
  CHECK ((locale = 'ar') = (direction = 'rtl'))
);
CREATE INDEX templates_org_idx ON email.templates (org_id, key, version DESC);
CREATE FUNCTION email.template_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'a template version is immutable: create a new version' USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER template_immutable BEFORE UPDATE OR DELETE ON email.templates FOR EACH ROW EXECUTE FUNCTION email.template_immutable();

CREATE TABLE email.messages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  sender_id uuid NOT NULL REFERENCES email.sender_identities(id),
  template_id uuid REFERENCES email.templates(id),
  category text NOT NULL CHECK (category = 'transactional'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','delivered','bounced','complained','failed','unknown')),
  to_hashes text[] NOT NULL CHECK (cardinality(to_hashes) BETWEEN 1 AND 50),
  recipients_enc text NOT NULL CHECK (recipients_enc ~ '^enc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}$'),
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  body_enc text CHECK (body_enc IS NULL OR body_enc ~ '^enc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}$'),
  subject_hash text CHECK (subject_hash IS NULL OR subject_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  send_token text NOT NULL,
  provider_id uuid,
  provider_message_ref text,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{2,60}$'),
  operation_id uuid,
  data_region text NOT NULL,
  accepted_at timestamptz,
  version_lock int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  CHECK (body_enc IS NULL OR expires_at IS NOT NULL)
);
CREATE INDEX messages_org_idx ON email.messages (org_id, created_at DESC, id);
CREATE INDEX messages_provider_ref_idx ON email.messages (provider_message_ref) WHERE provider_message_ref IS NOT NULL;
CREATE INDEX messages_recent_idx ON email.messages (org_id, accepted_at) WHERE accepted_at IS NOT NULL;
CREATE FUNCTION email.message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'messages are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.sender_id <> OLD.sender_id OR NEW.to_hashes <> OLD.to_hashes OR NEW.body_hash <> OLD.body_hash OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.send_token <> OLD.send_token OR NEW.created_at <> OLD.created_at OR NEW.category <> OLD.category THEN
    RAISE EXCEPTION 'the identity and content hash of a message are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.provider_message_ref IS NOT NULL AND NEW.provider_message_ref IS DISTINCT FROM OLD.provider_message_ref THEN RAISE EXCEPTION 'the provider reference is set once' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER message_guard BEFORE UPDATE OR DELETE ON email.messages FOR EACH ROW EXECUTE FUNCTION email.message_guard();
CREATE TRIGGER message_no_truncate BEFORE TRUNCATE ON email.messages FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

CREATE TABLE email.email_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  message_id uuid REFERENCES email.messages(id),
  provider_code text NOT NULL CHECK (provider_code ~ '^[a-z][a-z0-9-]{1,40}$'),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 255),
  type text NOT NULL CHECK (type IN ('queued','sent','delivered','bounce_hard','bounce_soft','complaint','rejected','deferred','failed','suppressed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,            -- redacted: no addresses, no content
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_code, provider_event_id)
);
CREATE INDEX email_events_org_idx ON email.email_events (org_id, occurred_at DESC, id);
CREATE INDEX email_events_message_idx ON email.email_events (message_id, occurred_at);
CREATE TRIGGER email_events_append_only BEFORE UPDATE OR DELETE ON email.email_events FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();
CREATE TRIGGER email_events_no_truncate BEFORE TRUNCATE ON email.email_events FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

CREATE TABLE email.suppressions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  address_hash text NOT NULL CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  address_enc text NOT NULL CHECK (address_enc ~ '^enc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}$'),
  reason text NOT NULL CHECK (reason IN ('bounce_hard','bounce_soft','complaint','manual')),
  source text NOT NULL CHECK (source IN ('webhook','manual','provider_sync')),
  active boolean NOT NULL DEFAULT true,
  event_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid,
  UNIQUE (org_id, address_hash, reason),
  CHECK (active = (removed_at IS NULL))
);
CREATE INDEX suppressions_lookup_idx ON email.suppressions (org_id, address_hash) WHERE active;

-- RLS: every tenant table is isolated by org_id; the admin console scope may read (fleet / deliverability views); the webhook handler resolves a provider message
-- reference to its organization through the platform scope AFTER the signature is verified, then writes under that organization's own scope.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_domains','mailboxes','aliases','sender_identities','templates','messages','email_events','suppressions'] LOOP
    EXECUTE format('ALTER TABLE email.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE email.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON email.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON email.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON email.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON email.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT UPDATE (verification_state, required_records, dmarc, tx_provider_id, tx_provider_ref, mailbox_provider_id, dns_zone_id, verified_at, last_checked_at, next_check_at, check_attempts, throttle_override, deleted_at) ON email.email_domains TO nuzm_app, nuzm_worker;
GRANT UPDATE (state, provider_id, provider_ref, plan_ref, quota_mb, password_setup, quote_id, order_id, usage, operation_id, deleted_at) ON email.mailboxes TO nuzm_app, nuzm_worker;
GRANT UPDATE (state, operation_id) ON email.aliases TO nuzm_app, nuzm_worker;
GRANT UPDATE (state, verified_at) ON email.sender_identities TO nuzm_app, nuzm_worker;
GRANT UPDATE (state, body_enc, expires_at, provider_id, provider_message_ref, error_code, operation_id, accepted_at) ON email.messages TO nuzm_app, nuzm_worker;
GRANT UPDATE (active, removed_at, removed_by) ON email.suppressions TO nuzm_app, nuzm_worker;
