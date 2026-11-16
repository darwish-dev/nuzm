-- M02 S06: central usage metering (docs/12). One pipeline: events -> dedupe -> aggregates -> rating -> (ledger).
--  * usage_events is append-only and written ONLY by metering.ingest() (runtime roles have no INSERT).
--  * Exactly-once EFFECT: unique (org_id, event_id[, window_start]); a repeat with the same payload is a duplicate,
--    with a different payload is rejected (event_id_conflict).
--  * Aggregates and rated usage are projections written only by SECURITY DEFINER functions; rated usage is versioned
--    by rating_run_id (re-rating adds a run and records the delta, never edits).
--  * Provider cost is platform-only: customers can never read it.
--  * Every scope check uses coalesce(): with no scope set the comparisons are NULL and NOT NULL is NULL (the S05 lesson).
CREATE SCHEMA IF NOT EXISTS metering;
GRANT USAGE ON SCHEMA metering TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

-- Meter catalogue (docs/12 §3). Units: GB = 10^9 bytes, GiB = 2^30 bytes (distinct; each meter fixes one).
CREATE TABLE metering.meters (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  unit text NOT NULL CHECK (length(unit) BETWEEN 1 AND 40),
  aggregation_window text NOT NULL CHECK (aggregation_window IN ('hour','day','event')),
  basis text NOT NULL CHECK (basis IN ('usage','included','pass','subscription')),
  dimensions_allowed text[] NOT NULL DEFAULT '{}',
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
INSERT INTO metering.meters (id, unit, aggregation_window, basis, dimensions_allowed) VALUES
  ('compute.vcpu_hours','vcpu_hour','hour','usage','{provider,region,plan}'),
  ('compute.memory_gb_hours','gib_hour','hour','usage','{region,plan}'),
  ('compute.disk_gb_months','gib_month','hour','usage','{region,disk_type}'),
  ('compute.snapshot_gb_months','gib_month','day','usage','{region}'),
  ('network.egress_gb','gb','day','usage','{region,resource_kind}'),
  ('hosting.site_months','site_month','day','usage','{plan}'),
  ('hosting.disk_gb_months','gib_month','day','included','{plan}'),
  ('hosting.bandwidth_gb','gb','day','included','{plan}'),
  ('hosting.backup_gb_months','gib_month','day','included','{plan}'),
  ('storage.object_gb_months','gib_month','hour','usage','{region,class}'),
  ('storage.requests_k','thousand_requests','day','usage','{op_class}'),
  ('storage.egress_gb','gb','day','usage','{region}'),
  ('database.instance_hours','instance_hour','hour','usage','{engine,size,region}'),
  ('database.storage_gb_months','gib_month','hour','usage','{engine,region}'),
  ('database.backup_gb_months','gib_month','day','usage','{engine}'),
  ('cache.instance_hours','instance_hour','hour','usage','{size,region}'),
  ('email.transactional_messages','message','day','usage','{provider,stream}'),
  ('email.mailbox_months','mailbox_month','day','subscription','{plan}'),
  ('email.mailbox_storage_gb_months','gib_month','day','included','{plan}'),
  ('domain.registration_years','year','event','pass','{tld,registrar}'),
  ('domain.renewal_years','year','event','pass','{tld}'),
  ('domain.transfers','transfer','event','pass','{tld}'),
  ('dns.zone_months','zone_month','day','included','{}'),
  ('ai.tokens_input','token','event','usage','{model_id,region}'),
  ('ai.tokens_output','token','event','usage','{model_id,region}'),
  ('ai.credits_consumed','credit','event','usage','{run_kind}'),
  ('ai.sandbox_cpu_seconds','cpu_second','hour','usage','{sandbox_class}'),
  ('builder.build_minutes','minute','day','included','{project_type}'),
  ('mobile.build_minutes','minute','day','usage','{platform}'),
  ('automation.executions','execution','day','included','{}'),
  ('automation.steps','step','day','included','{connector}');

-- Usage events (append-only, monthly partitions by window_start). PK includes the partition key.
CREATE TABLE metering.usage_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  event_id uuid NOT NULL,
  meter_id text NOT NULL,
  quantity numeric(24,8) NOT NULL,
  unit text NOT NULL,
  resource_id uuid,
  project_id uuid,
  environment_id uuid,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_region text NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  acting_org_id uuid,
  provider_event_id text,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  adjusts_event_id uuid,
  billing_period_start date NOT NULL,            -- UTC month the event is BILLED in (late events: the next open month)
  late boolean NOT NULL DEFAULT false,
  skew_flag boolean NOT NULL DEFAULT false,
  payload_hash text NOT NULL,
  PRIMARY KEY (org_id, event_id, window_start),
  CHECK (window_end >= window_start),
  CHECK (quantity >= 0 OR adjusts_event_id IS NOT NULL)
) PARTITION BY RANGE (window_start);
CREATE INDEX usage_events_event_idx ON metering.usage_events (org_id, event_id);
CREATE INDEX usage_events_bucket_idx ON metering.usage_events (org_id, meter_id, window_start);
CREATE INDEX usage_events_period_idx ON metering.usage_events (org_id, billing_period_start, meter_id);
CREATE TABLE metering.usage_events_default PARTITION OF metering.usage_events DEFAULT;

-- Monthly partitions: created ahead by this function (the worker calls it daily); also run once here.
CREATE FUNCTION metering.ensure_usage_partitions(p_from date, p_months int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE m date := date_trunc('month', p_from)::date; n int := 0; part text;
BEGIN
  FOR i IN 0 .. greatest(p_months, 1) - 1 LOOP
    part := 'usage_events_' || to_char(m, 'YYYYMM');
    IF to_regclass('metering.' || part) IS NULL THEN
      EXECUTE format('CREATE TABLE metering.%I PARTITION OF metering.usage_events FOR VALUES FROM (%L) TO (%L)',
                     part, m::timestamptz, (m + interval '1 month')::timestamptz);
      n := n + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION metering.ensure_usage_partitions(date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metering.ensure_usage_partitions(date, int) TO nuzm_app, nuzm_worker;
SELECT metering.ensure_usage_partitions((now() - interval '2 months')::date, 30);

CREATE FUNCTION metering.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'metering tables are append-only (% on %.%)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER usage_events_no_mutation BEFORE UPDATE OR DELETE ON metering.usage_events
  FOR EACH ROW EXECUTE FUNCTION metering.deny_mutation();
CREATE TRIGGER usage_events_no_truncate BEFORE TRUNCATE ON metering.usage_events
  FOR EACH STATEMENT EXECUTE FUNCTION metering.deny_mutation();

-- A meter's unit may not change once events exist.
CREATE FUNCTION metering.meter_unit_frozen() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.unit <> OLD.unit AND EXISTS (SELECT 1 FROM metering.usage_events WHERE meter_id = OLD.id) THEN
    RAISE EXCEPTION 'meter % unit is immutable once events exist', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meters_unit_frozen BEFORE UPDATE ON metering.meters FOR EACH ROW EXECUTE FUNCTION metering.meter_unit_frozen();

-- Aggregates (projection, rebuildable): recomputed from distinct events, so replays cannot double count.
CREATE TABLE metering.usage_aggregates (
  org_id uuid NOT NULL,
  meter_id text NOT NULL,
  resource_key text NOT NULL,                    -- resource id or '' when the event has none
  granularity text NOT NULL CHECK (granularity IN ('hour','day')),
  bucket_start timestamptz NOT NULL,
  billing_period_start date NOT NULL,
  quantity numeric(24,8) NOT NULL,
  event_count int NOT NULL,
  content_hash text NOT NULL,
  data_region text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start)
);
CREATE INDEX usage_aggregates_period_idx ON metering.usage_aggregates (org_id, billing_period_start, meter_id);

-- Rated usage (append-only, versioned by rating_run_id; re-rating records the delta).
CREATE TABLE metering.rated_usage (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  rating_run_id uuid NOT NULL,
  meter_id text NOT NULL,
  resource_key text NOT NULL,
  period_start date NOT NULL,                    -- billing period (UTC month)
  segment_start timestamptz NOT NULL,            -- first bucket of the price-book-version segment
  price_book_version_id uuid NOT NULL,
  price_item_id uuid NOT NULL,
  tier_model text NOT NULL,
  quantity numeric(24,8) NOT NULL,
  allowance_applied numeric(24,8) NOT NULL DEFAULT 0,
  billable_quantity numeric(24,8) NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  previous_amount_minor bigint,                  -- same key in the previous run, if any
  delta_minor bigint,                            -- amount_minor - previous (NULL for the first run)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rated_usage_org_period_idx ON metering.rated_usage (org_id, period_start, created_at DESC);
CREATE INDEX rated_usage_run_idx ON metering.rated_usage (rating_run_id);
CREATE TRIGGER rated_usage_no_mutation BEFORE UPDATE OR DELETE ON metering.rated_usage
  FOR EACH ROW EXECUTE FUNCTION metering.deny_mutation();
CREATE TRIGGER rated_usage_no_truncate BEFORE TRUNCATE ON metering.rated_usage
  FOR EACH STATEMENT EXECUTE FUNCTION metering.deny_mutation();

-- Provider cost (platform-only; never shown to customers). Dedupe on the provider's own line reference.
CREATE TABLE metering.provider_cost_records (
  id uuid PRIMARY KEY,
  provider_account_id text NOT NULL,
  resource_id text,
  org_id uuid,                                   -- NULL = unattributed (surfaced by RC-04)
  period_start date NOT NULL,
  period_end date NOT NULL,
  meter_or_sku text NOT NULL,
  quantity numeric(24,8) NOT NULL CHECK (quantity >= 0),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  currency char(3) NOT NULL,
  source text NOT NULL CHECK (source IN ('api','bill_import')),
  provider_line_ref text NOT NULL,
  evidence_ref text,                             -- uploaded bill/evidence file reference (imports)
  captured_at timestamptz NOT NULL DEFAULT now(),
  captured_by uuid,
  UNIQUE (provider_account_id, provider_line_ref)
);
CREATE INDEX provider_cost_org_period_idx ON metering.provider_cost_records (org_id, period_start);
CREATE TRIGGER provider_cost_no_mutation BEFORE UPDATE OR DELETE ON metering.provider_cost_records
  FOR EACH ROW EXECUTE FUNCTION metering.deny_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- ingest(): validation, dedupe, late/skew policy. One result row per input event, in order. A bad event never
-- aborts the batch: it is reported as rejected(reason). p_events: [{eventId, orgId, meterId, quantity, unit, resourceId?,
-- projectId?, environmentId?, windowStart, windowEnd, occurredAt, dimensions?, dataRegion, schemaVersion?, actingOrgId?,
-- providerEventId?, tags?, adjustsEventId?}]
CREATE FUNCTION metering.ingest(p_events jsonb, p_source text, p_now timestamptz DEFAULT now())
RETURNS TABLE (idx int, event_id text, result text, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx_org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
  platform boolean := coalesce(current_setting('app.platform_scope', true) = 'admin', false);
  e jsonb;
  i int := 0;
  m metering.meters;
  eid uuid; org uuid; qty numeric; ws timestamptz; we timestamptz; occ timestamptz;
  res uuid; proj uuid; env uuid; act uuid; adj uuid;
  dims jsonb; k text; reg text;
  h text; existing record; orig record;
  period date; grace interval := interval '72 hours'; late boolean; skew boolean; bperiod date;
BEGIN
  IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 500 THEN
    RAISE EXCEPTION 'metering.ingest: batch must be an array of at most 500 events' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_source !~ '^[a-z][a-z0-9_-]*@M[0-9]{2}$' THEN
    RAISE EXCEPTION 'metering.ingest: source must look like module@Mnn' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    i := i + 1;
    idx := i - 1; event_id := e ->> 'eventId'; result := 'rejected'; reason := NULL;
    BEGIN
      -- identity and scope
      BEGIN eid := (e ->> 'eventId')::uuid; org := (e ->> 'orgId')::uuid;
      EXCEPTION WHEN others THEN reason := 'invalid_id'; RETURN NEXT; CONTINUE; END;
      IF eid IS NULL OR org IS NULL THEN reason := 'invalid_id'; RETURN NEXT; CONTINUE; END IF;
      IF NOT coalesce(platform OR org = ctx_org, false) THEN reason := 'org_mismatch'; RETURN NEXT; CONTINUE; END IF;
      IF NOT EXISTS (SELECT 1 FROM tenancy.organizations o WHERE o.id = org AND o.deleted_at IS NULL) THEN
        reason := 'unknown_org'; RETURN NEXT; CONTINUE;
      END IF;
      -- meter, unit, quantity
      SELECT * INTO m FROM metering.meters WHERE id = e ->> 'meterId';
      IF NOT FOUND THEN reason := 'unknown_meter'; RETURN NEXT; CONTINUE; END IF;
      IF coalesce(e ->> 'unit', '') <> m.unit THEN reason := 'unit_mismatch'; RETURN NEXT; CONTINUE; END IF;
      BEGIN qty := (e ->> 'quantity')::numeric;
      EXCEPTION WHEN others THEN reason := 'invalid_quantity'; RETURN NEXT; CONTINUE; END;
      IF qty IS NULL OR qty = 'NaN'::numeric OR abs(qty) >= 1e16 THEN reason := 'invalid_quantity'; RETURN NEXT; CONTINUE; END IF;
      qty := round(qty, 8);
      -- times
      BEGIN ws := (e ->> 'windowStart')::timestamptz; we := (e ->> 'windowEnd')::timestamptz; occ := (e ->> 'occurredAt')::timestamptz;
      EXCEPTION WHEN others THEN reason := 'invalid_time'; RETURN NEXT; CONTINUE; END;
      IF ws IS NULL OR we IS NULL OR occ IS NULL OR we < ws THEN reason := 'invalid_time'; RETURN NEXT; CONTINUE; END IF;
      IF occ > p_now + interval '5 minutes' THEN reason := 'occurred_in_future'; RETURN NEXT; CONTINUE; END IF;
      skew := occ > p_now + interval '1 minute';
      -- residency tag, optional ids
      reg := nullif(btrim(coalesce(e ->> 'dataRegion', '')), '');
      IF reg IS NULL OR length(reg) > 40 THEN reason := 'missing_data_region'; RETURN NEXT; CONTINUE; END IF;
      BEGIN res := (e ->> 'resourceId')::uuid; proj := (e ->> 'projectId')::uuid; env := (e ->> 'environmentId')::uuid;
            act := (e ->> 'actingOrgId')::uuid; adj := (e ->> 'adjustsEventId')::uuid;
      EXCEPTION WHEN others THEN reason := 'invalid_id'; RETURN NEXT; CONTINUE; END;
      -- dimensions allow-list
      dims := coalesce(e -> 'dimensions', '{}'::jsonb);
      IF jsonb_typeof(dims) <> 'object' THEN reason := 'invalid_dimensions'; RETURN NEXT; CONTINUE; END IF;
      FOR k IN SELECT jsonb_object_keys(dims) LOOP
        IF NOT (k = ANY (m.dimensions_allowed)) THEN reason := 'forbidden_dimension:' || k; EXIT; END IF;
      END LOOP;
      IF reason IS NOT NULL THEN RETURN NEXT; CONTINUE; END IF;
      -- corrections: negative quantities are adjustments and land in the ADJUSTED event's window
      IF adj IS NOT NULL THEN
        SELECT u.meter_id, u.window_start, u.window_end INTO orig FROM metering.usage_events u WHERE u.org_id = org AND u.event_id = adj LIMIT 1;
        IF NOT FOUND THEN reason := 'adjusts_unknown_event'; RETURN NEXT; CONTINUE; END IF;
        IF orig.meter_id <> m.id THEN reason := 'adjusts_other_meter'; RETURN NEXT; CONTINUE; END IF;
        ws := orig.window_start; we := orig.window_end;
      ELSIF qty < 0 THEN
        reason := 'negative_without_adjustment'; RETURN NEXT; CONTINUE;
      END IF;
      -- late policy: a period is closed at month end + 72 h grace; later events are billed in the current month
      period := (date_trunc('month', ws AT TIME ZONE 'UTC'))::date;
      late := p_now > ((period + interval '1 month')::timestamp AT TIME ZONE 'UTC') + grace;
      bperiod := CASE WHEN late THEN (date_trunc('month', p_now AT TIME ZONE 'UTC'))::date ELSE period END;
      -- dedupe
      h := encode(sha256(convert_to(jsonb_build_array(m.id, qty::text, m.unit, ws, we, res, proj, env, dims, reg, adj)::text, 'UTF8')), 'hex');
      PERFORM pg_advisory_xact_lock(hashtextextended(org::text || ':' || eid::text, 0));
      SELECT u.payload_hash INTO existing FROM metering.usage_events u WHERE u.org_id = org AND u.event_id = eid LIMIT 1;
      IF FOUND THEN
        IF existing.payload_hash = h THEN result := 'duplicate'; ELSE reason := 'event_id_conflict'; END IF;
        RETURN NEXT; CONTINUE;
      END IF;
      INSERT INTO metering.usage_events (org_id, event_id, meter_id, quantity, unit, resource_id, project_id, environment_id, window_start, window_end,
          occurred_at, received_at, source, dimensions, data_region, schema_version, acting_org_id, provider_event_id, tags, adjusts_event_id,
          billing_period_start, late, skew_flag, payload_hash)
        VALUES (org, eid, m.id, qty, m.unit, res, proj, env, ws, we, occ, p_now, p_source, dims, reg, coalesce((e ->> 'schemaVersion')::int, 1), act,
          e ->> 'providerEventId', coalesce(e -> 'tags', '{}'::jsonb), adj, bperiod, late, skew, h);
      result := 'accepted';
      RETURN NEXT;
    EXCEPTION WHEN others THEN
      result := 'rejected'; reason := 'internal:' || sqlstate; RETURN NEXT;
    END;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION metering.ingest(jsonb, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metering.ingest(jsonb, text, timestamptz) TO nuzm_app, nuzm_worker;

-- aggregate(): recompute every bucket of one org overlapping [p_from, p_to] from distinct events (idempotent).
CREATE FUNCTION metering.aggregate(p_org uuid, p_from timestamptz, p_to timestamptz) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT coalesce(current_setting('app.platform_scope', true) = 'admin' OR p_org = nullif(current_setting('app.org_id', true), '')::uuid, false) THEN
    RAISE EXCEPTION 'metering.aggregate: organization context does not match' USING ERRCODE = 'insufficient_privilege';
  END IF;
  WITH src AS (
    SELECT u.org_id, u.meter_id, coalesce(u.resource_id::text, '') AS resource_key,
           CASE WHEN m.aggregation_window = 'day' THEN 'day' ELSE 'hour' END AS granularity,
           date_trunc(CASE WHEN m.aggregation_window = 'day' THEN 'day' ELSE 'hour' END, u.window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
           u.billing_period_start, u.quantity, u.event_id, u.data_region
      FROM metering.usage_events u JOIN metering.meters m ON m.id = u.meter_id
     WHERE u.org_id = p_org
       -- whole UTC days on both sides, so a bucket is never recomputed from a partial set of its events
       AND u.window_start >= (date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
       AND u.window_start < (date_trunc('day', p_to AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 day'
  ), grouped AS (
    SELECT org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start,
           sum(quantity) AS quantity, count(*)::int AS event_count,
           encode(sha256(convert_to(string_agg(event_id::text || ':' || quantity::text, ',' ORDER BY event_id), 'UTF8')), 'hex') AS content_hash,
           min(data_region) AS data_region
      FROM src GROUP BY org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start
  ), up AS (
    INSERT INTO metering.usage_aggregates (org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start, quantity, event_count, content_hash, data_region)
      SELECT * FROM grouped
    ON CONFLICT (org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start) DO UPDATE
      SET quantity = EXCLUDED.quantity, event_count = EXCLUDED.event_count, content_hash = EXCLUDED.content_hash,
          data_region = EXCLUDED.data_region, updated_at = now()
      WHERE (metering.usage_aggregates.content_hash, metering.usage_aggregates.quantity, metering.usage_aggregates.event_count)
            IS DISTINCT FROM (EXCLUDED.content_hash, EXCLUDED.quantity, EXCLUDED.event_count)  -- also heals a tampered stored value
    RETURNING 1
  ) SELECT count(*)::int INTO n FROM up;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION metering.aggregate(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metering.aggregate(uuid, timestamptz, timestamptz) TO nuzm_app, nuzm_worker;

-- aggregate_events(): recompute exactly the buckets that the given events belong to (their STORED windows: an adjustment
-- lives in the window of the event it corrects, which may differ from what the producer sent). Idempotent.
CREATE FUNCTION metering.aggregate_events(p_org uuid, p_event_ids uuid[]) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT coalesce(current_setting('app.platform_scope', true) = 'admin' OR p_org = nullif(current_setting('app.org_id', true), '')::uuid, false) THEN
    RAISE EXCEPTION 'metering.aggregate_events: organization context does not match' USING ERRCODE = 'insufficient_privilege';
  END IF;
  WITH keys AS (
    SELECT DISTINCT u.meter_id, coalesce(u.resource_id::text, '') AS resource_key,
           CASE WHEN m.aggregation_window = 'day' THEN 'day' ELSE 'hour' END AS granularity,
           date_trunc(CASE WHEN m.aggregation_window = 'day' THEN 'day' ELSE 'hour' END, u.window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
           u.billing_period_start
      FROM metering.usage_events u JOIN metering.meters m ON m.id = u.meter_id
     WHERE u.org_id = p_org AND u.event_id = ANY (p_event_ids)
  ), src AS (
    SELECT u.org_id, u.meter_id, k.resource_key, k.granularity, k.bucket_start, u.billing_period_start, u.quantity, u.event_id, u.data_region
      FROM keys k JOIN metering.usage_events u
        ON u.org_id = p_org AND u.meter_id = k.meter_id AND coalesce(u.resource_id::text, '') = k.resource_key
       AND u.billing_period_start = k.billing_period_start
       AND date_trunc(k.granularity, u.window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' = k.bucket_start
  ), grouped AS (
    SELECT org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start,
           sum(quantity) AS quantity, count(*)::int AS event_count,
           encode(sha256(convert_to(string_agg(event_id::text || ':' || quantity::text, ',' ORDER BY event_id), 'UTF8')), 'hex') AS content_hash,
           min(data_region) AS data_region
      FROM src GROUP BY org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start
  ), up AS (
    INSERT INTO metering.usage_aggregates (org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start, quantity, event_count, content_hash, data_region)
      SELECT * FROM grouped
    ON CONFLICT (org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start) DO UPDATE
      SET quantity = EXCLUDED.quantity, event_count = EXCLUDED.event_count, content_hash = EXCLUDED.content_hash,
          data_region = EXCLUDED.data_region, updated_at = now()
      WHERE (metering.usage_aggregates.content_hash, metering.usage_aggregates.quantity, metering.usage_aggregates.event_count)
            IS DISTINCT FROM (EXCLUDED.content_hash, EXCLUDED.quantity, EXCLUDED.event_count)  -- also heals a tampered stored value
    RETURNING 1
  ) SELECT count(*)::int INTO n FROM up;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION metering.aggregate_events(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metering.aggregate_events(uuid, uuid[]) TO nuzm_app, nuzm_worker;

-- verify_aggregates(): consistency check library for finrec: aggregates whose stored hash/quantity no longer match events.
CREATE FUNCTION metering.verify_aggregates(p_org uuid)
RETURNS TABLE (meter_id text, resource_key text, bucket_start timestamptz, stored numeric, recomputed numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT coalesce(current_setting('app.platform_scope', true) = 'admin' OR p_org = nullif(current_setting('app.org_id', true), '')::uuid, false) THEN
    RAISE EXCEPTION 'metering.verify_aggregates: organization context does not match' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT a.meter_id, a.resource_key, a.bucket_start, a.quantity,
         coalesce((SELECT sum(u.quantity) FROM metering.usage_events u JOIN metering.meters m ON m.id = u.meter_id
                    WHERE u.org_id = a.org_id AND u.meter_id = a.meter_id AND coalesce(u.resource_id::text, '') = a.resource_key
                      AND u.billing_period_start = a.billing_period_start
                      AND date_trunc(CASE WHEN m.aggregation_window = 'day' THEN 'day' ELSE 'hour' END, u.window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' = a.bucket_start), 0)
    FROM metering.usage_aggregates a WHERE a.org_id = p_org;
END $$;
REVOKE ALL ON FUNCTION metering.verify_aggregates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metering.verify_aggregates(uuid) TO nuzm_app, nuzm_worker;

-- record_rated(): the only writer of rated_usage. p_rows: [{meterId, resourceKey, periodStart, segmentStart, priceBookVersionId,
-- priceItemId, tierModel, quantity, allowanceApplied, billableQuantity, amountMinor, currency}]. Fills previous/delta from the
-- latest earlier run for the same key.
CREATE FUNCTION metering.record_rated(p_org uuid, p_run uuid, p_rows jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r jsonb; n int := 0; prev bigint;
BEGIN
  IF NOT coalesce(current_setting('app.platform_scope', true) = 'admin' OR p_org = nullif(current_setting('app.org_id', true), '')::uuid, false) THEN
    RAISE EXCEPTION 'metering.record_rated: organization context does not match' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    SELECT x.amount_minor INTO prev FROM metering.rated_usage x
     WHERE x.org_id = p_org AND x.meter_id = r ->> 'meterId' AND x.resource_key = r ->> 'resourceKey'
       AND x.period_start = (r ->> 'periodStart')::date AND x.segment_start = (r ->> 'segmentStart')::timestamptz
       AND x.rating_run_id <> p_run
     ORDER BY x.created_at DESC, x.id DESC LIMIT 1;
    INSERT INTO metering.rated_usage (id, org_id, rating_run_id, meter_id, resource_key, period_start, segment_start, price_book_version_id,
        price_item_id, tier_model, quantity, allowance_applied, billable_quantity, amount_minor, currency, previous_amount_minor, delta_minor)
      VALUES (gen_random_uuid(), p_org, p_run, r ->> 'meterId', r ->> 'resourceKey', (r ->> 'periodStart')::date, (r ->> 'segmentStart')::timestamptz,
        (r ->> 'priceBookVersionId')::uuid, (r ->> 'priceItemId')::uuid, r ->> 'tierModel', (r ->> 'quantity')::numeric,
        (r ->> 'allowanceApplied')::numeric, (r ->> 'billableQuantity')::numeric, (r ->> 'amountMinor')::bigint, r ->> 'currency',
        prev, CASE WHEN prev IS NULL THEN NULL ELSE (r ->> 'amountMinor')::bigint - prev END);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION metering.record_rated(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metering.record_rated(uuid, uuid, jsonb) TO nuzm_app, nuzm_worker;

-- record_provider_cost(): platform scope only. Duplicate provider line refs are ignored (idempotent).
CREATE FUNCTION metering.record_provider_cost(p_rows jsonb) RETURNS TABLE (id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r jsonb; got uuid; new_id uuid;
BEGIN
  IF NOT coalesce(current_setting('app.platform_scope', true) = 'admin', false) THEN
    RAISE EXCEPTION 'metering.record_provider_cost: platform scope required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    new_id := gen_random_uuid();
    INSERT INTO metering.provider_cost_records (id, provider_account_id, resource_id, org_id, period_start, period_end, meter_or_sku, quantity,
        cost_minor, currency, source, provider_line_ref, evidence_ref, captured_by)
      VALUES (new_id, r ->> 'providerAccountId', r ->> 'resourceId', (r ->> 'orgId')::uuid, (r ->> 'periodStart')::date, (r ->> 'periodEnd')::date,
        r ->> 'meterOrSku', (r ->> 'quantity')::numeric, (r ->> 'costMinor')::bigint, r ->> 'currency', r ->> 'source', r ->> 'providerLineRef',
        r ->> 'evidenceRef', (r ->> 'capturedBy')::uuid)
    ON CONFLICT (provider_account_id, provider_line_ref) DO NOTHING RETURNING provider_cost_records.id INTO got;
    IF got IS NULL THEN
      SELECT c.id INTO got FROM metering.provider_cost_records c WHERE c.provider_account_id = r ->> 'providerAccountId' AND c.provider_line_ref = r ->> 'providerLineRef';
      id := got; inserted := false;
    ELSE id := got; inserted := true; END IF;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION metering.record_provider_cost(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metering.record_provider_cost(jsonb) TO nuzm_app, nuzm_worker;

-- RLS ------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text; own text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['usage_events','usage_aggregates','rated_usage','provider_cost_records'] LOOP
    EXECUTE format('ALTER TABLE metering.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE metering.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY definer_all ON metering.%I TO %I USING (true) WITH CHECK (true)', t, own);
  END LOOP;
END $$;
CREATE POLICY org_read ON metering.usage_events FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR coalesce(current_setting('app.platform_scope', true) = 'admin', false));
CREATE POLICY org_read ON metering.usage_aggregates FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR coalesce(current_setting('app.platform_scope', true) = 'admin', false));
CREATE POLICY org_read ON metering.rated_usage FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR coalesce(current_setting('app.platform_scope', true) = 'admin', false));
-- provider cost: platform scope ONLY (no organization policy at all)
CREATE POLICY platform_read ON metering.provider_cost_records FOR SELECT
  USING (coalesce(current_setting('app.platform_scope', true) = 'admin', false));

ALTER TABLE metering.meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering.meters FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON metering.meters FOR SELECT USING (true);
CREATE POLICY platform_write ON metering.meters FOR ALL
  USING (coalesce(current_setting('app.platform_scope', true) = 'admin', false))
  WITH CHECK (coalesce(current_setting('app.platform_scope', true) = 'admin', false));

GRANT SELECT ON metering.meters, metering.usage_events, metering.usage_aggregates, metering.rated_usage, metering.provider_cost_records TO nuzm_app, nuzm_worker;
GRANT INSERT, UPDATE ON metering.meters TO nuzm_app; -- gated by platform_write RLS (the catalogue is extended via the admin API only)
GRANT SELECT ON metering.meters, metering.usage_events, metering.usage_aggregates, metering.rated_usage, metering.provider_cost_records TO nuzm_admin_breakglass;

-- Margin (finance): latest rating run per org/period vs provider cost attributed to the org. security_invoker: RLS applies,
-- so only the admin-console scope sees provider cost (customers see nothing from it).
CREATE VIEW metering.v_margin WITH (security_invoker = true) AS
WITH latest AS (
  SELECT DISTINCT ON (org_id, period_start) org_id, period_start, rating_run_id
    FROM metering.rated_usage ORDER BY org_id, period_start, created_at DESC, id DESC
), revenue AS (
  SELECT r.org_id, r.period_start, r.currency, sum(r.amount_minor)::bigint AS revenue_minor
    FROM metering.rated_usage r JOIN latest l ON l.org_id = r.org_id AND l.period_start = r.period_start AND l.rating_run_id = r.rating_run_id
   GROUP BY r.org_id, r.period_start, r.currency
), cost AS (
  SELECT c.org_id, date_trunc('month', c.period_start)::date AS period_start, c.currency, sum(c.cost_minor)::bigint AS cost_minor
    FROM metering.provider_cost_records c GROUP BY c.org_id, date_trunc('month', c.period_start)::date, c.currency
)
SELECT coalesce(revenue.org_id, cost.org_id) AS org_id, coalesce(revenue.period_start, cost.period_start) AS period_start,
       coalesce(revenue.currency, cost.currency) AS currency,
       coalesce(revenue.revenue_minor, 0) AS revenue_minor, coalesce(cost.cost_minor, 0) AS cost_minor,
       coalesce(revenue.revenue_minor, 0) - coalesce(cost.cost_minor, 0) AS margin_minor
  FROM revenue FULL JOIN cost ON coalesce(cost.org_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(revenue.org_id, '00000000-0000-0000-0000-000000000000'::uuid) AND cost.period_start = revenue.period_start AND cost.currency = revenue.currency;
GRANT SELECT ON metering.v_margin TO nuzm_app, nuzm_worker;
