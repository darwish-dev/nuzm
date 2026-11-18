import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptySiteModel } from '@nuzm/domain';
import { OperationsService } from '@nuzm/platform';
import { NotificationService } from '../notifications';
import { AdapterRegistry } from '../cloud';
import { ProjectsPort } from '../appbuilder';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';

/**
 * Cross-tenant suite GENERATED FROM spec/openapi/openapi.yaml (M01 S03 task 13).
 * For every org-scoped operation that takes an id, org B's owner (session AND API key) calls it with
 * org A's real ids and must get 404 (existence hiding), never 403/200. A new route without a fixture
 * fails the coverage test, so isolation cannot silently go untested.
 */
type Op = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  permission: string;
  params: string[];
  /** Global reference data (e.g. the plan catalogue): the same for every organization, so no 404 isolation applies. */
  global: boolean;
};
const spec = parse(
  readFileSync(join(__dirname, '../../../../../spec/openapi/openapi.yaml'), 'utf8'),
) as { paths: Record<string, Record<string, Record<string, unknown>>> };
const allOps: Op[] = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!['get', 'post', 'patch', 'delete'].includes(m)) continue;
    allOps.push({
      method: m.toUpperCase() as Op['method'],
      path,
      permission: (op['x-nuzm-permission'] as string) ?? '',
      global: op['x-nuzm-global-reference'] === true,
      params: [...path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!),
    });
  }
}
const orgScoped = allOps.filter((o) => o.permission);
const withIds = orgScoped.filter((o) => o.params.length > 0 && !o.global);

const h = new Harness();
let app: App;
const A: Record<string, string> = {};
let bobJar: Record<string, string>;
let bobKey = '';
let orgA = '';
let orgB = '';
let aliceId = '';

/** Which of org A's ids fills a path parameter. */
const fixtureFor = (o: Op, p: string): string | undefined => {
  if (p === 'orgId') return orgA;
  if (p === 'userId') return aliceId;
  if (p === 'envId') return A.env;
  // hosting (M06): site id, backup id, abuse-case id
  if (p === 'backupId') return A.hostingBackup;
  if (p === 'caseId') return A.hostingCase;
  if (o.path.startsWith('/v1/hosting/sites/') && p === 'id') return A.hostingSite;
  // automation, marketplace and programs (M11)
  if (o.path.startsWith('/v1/workflow-executions/')) return A.execution;
  if (o.path.startsWith('/v1/workflows/')) return A.workflow;
  if (o.path.startsWith('/v1/connectors/')) return A.connector;
  if (o.path.startsWith('/v1/agencies/')) return A.agency;
  if (o.path.startsWith('/v1/resellers/')) return A.reseller;
  if (o.path.startsWith('/v1/marketplace/listings/')) return A.listing;
  if (o.path.startsWith('/v1/marketplace/purchases/')) return A.purchase;
  // billing routes carry three kinds of ids: choose by the path segment that precedes `{id}`
  if (o.path.includes('/payment-methods/')) return A.paymentMethod;
  if (o.path.includes('/payments/')) return A.payment;
  if (o.path.includes('/subscriptions/')) return A.subscription;
  if (o.path.includes('/invoices/')) return A.invoice;
  if (o.path.includes('/credit-notes/')) return A.creditNote;
  if (o.path.includes('/compliance/consents/')) return A.consent;
  if (o.path.includes('/compliance/data-subject-requests/')) return A.dsr;
  if (o.path.includes('/spend-approvals/')) return A.approval;
  if (o.path.includes('/dns/zones/')) return A.zone;
  // managed data and email (M08)
  if (o.path.startsWith('/v1/databases/')) return A.dbInstance;
  if (o.path.startsWith('/v1/storage/buckets/')) return A.bucket;
  if (o.path.startsWith('/v1/email/domains/')) return A.emailDomain;
  if (o.path.startsWith('/v1/email/mailboxes/')) return A.mailbox;
  if (o.path.startsWith('/v1/email/messages/')) return A.emailMessage;
  // >>> M09: AI sessions/runs/artifacts, builder projects/versions, deployments
  if (p === 'artifactId') return A.aiArtifact;
  if (p === 'approvalId') return A.aiApproval; // M10A (agent approvals)
  if (p === 'projectId') return A.m10Project; // M10A routes name the project {projectId}; they resolve it through the M09 port
  if (p === 'sid') return A.m10Sandbox;
  if (p === 'testRunId') return A.m10TestRun;
  if (p === 'exportId') return A.m10Export;
  if (p === 'vid') return A.bVersion;
  if (o.path.startsWith('/v1/ai/sessions/')) return A.aiSession;
  if (o.path.startsWith('/v1/ai/runs/')) return A.aiRun;
  if (o.path.startsWith('/v1/builder/projects/')) return A.bProject;
  if (o.path.startsWith('/v1/deployments/')) return A.deployment;
  // <<< M09
  const root = o.path.split('/')[2]!; // /v1/<root>/...
  return (
    {
      workspaces: A.workspace,
      projects: A.project,
      invitations: A.invitation,
      'api-keys': A.apiKey,
      operations: A.operation,
      notifications: A.notification,
      quotes: A.quote,
      compute: A.instance,
      domains: A.domain,
    } as Record<string, string>
  )[root];
};
const urlFor = (o: Op) => o.path.replace(/\{(\w+)\}/g, (_m, p) => fixtureFor(o, p)!);
const bodyFor = (o: Op): unknown => {
  if (o.method === 'PATCH') {
    if (o.path.startsWith('/v1/notifications/')) return { read: true };
    if (o.path.startsWith('/v1/billing/subscriptions/')) return { quantity: 2 }; // a VALID change: only the id may differ
    return o.path.includes('/members/') ? { role: 'viewer' } : { name: 'hijack' };
  }
  if (o.method === 'POST' && o.path.endsWith('/executions')) return { dedupeKey: 'ct-run' }; // a VALID body (M11): only the workflow id may differ
  if (o.method === 'POST' && o.path.endsWith('/decision')) return { decision: 'approve' }; // a VALID body: only the id may differ
  if (o.method === 'POST' && o.path.endsWith('/decisions'))
    return { decision: 'reject', scopeHash: 'a'.repeat(64) }; // a VALID body (M10A): only the approval id may differ (hash = the fixture's action_hash)
  if (o.method === 'POST' && o.path.endsWith('/restores')) return { backupId: crypto.randomUUID() }; // a VALID body (M08): only the database id may differ
  if (o.method === 'POST')
    return o.path.endsWith('/environments') ? { name: 'x', kind: 'dev' } : undefined;
  return undefined;
};
const extraHeaders = (o: Op): Record<string, string> => ({
  ...(o.method === 'PATCH' ? { 'if-match': '"1"' } : {}),
  ...(o.method === 'POST' ? { 'idempotency-key': `ct-${Math.random()}` } : {}),
});

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp());
  aliceId = await h.createUser('alice');
  const bobId = await h.createUser('bob');
  const aliceJar = await h.sessionFor(app, aliceId);
  bobJar = await h.sessionFor(app, bobId);
  await h.elevate(aliceJar);
  await h.elevate(bobJar);
  const mk = async (jar: Record<string, string>, name: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': jar.nuzm_csrf! },
      payload: { name },
    });
    expect(r.statusCode, `create org ${name}: ${r.body}`).toBe(201);
    return r.json().id as string;
  };
  orgA = await mk(aliceJar, 'Tenant Alpha');
  orgB = await mk(bobJar, 'Tenant Beta');
  const a = (method: 'POST' | 'GET', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(aliceJar),
        'x-csrf-token': aliceJar.nuzm_csrf!,
        'x-nuzm-org': orgA,
        'idempotency-key': `fx-${url}-${Math.random()}`,
      },
      ...(payload ? { payload } : {}),
    });
  A.workspace = (await a('POST', '/v1/workspaces', { name: 'A-ws' })).json().id;
  A.project = (
    await a('POST', '/v1/projects', { workspaceId: A.workspace, name: 'A-proj' })
  ).json().id;
  A.env = (
    await a('POST', `/v1/projects/${A.project}/environments`, { name: 'prod', kind: 'prod' })
  ).json().id;
  A.invitation = (
    await a('POST', '/v1/invitations', { email: 'someone@example.test', role: 'viewer' })
  ).json().id;
  A.apiKey = (
    await a('POST', '/v1/api-keys', { name: 'A-key', scopes: ['project:read'] })
  ).json().id;
  A.operation = (await app.get(OperationsService).create(orgA, { kind: 'ct.op' })).id;
  A.quote = (
    await a('POST', '/v1/quotes', { kind: 'ai-credit', items: [{ credits: '10' }] })
  ).json().id;
  // M07: a domain and its DNS zone of org A (rows written directly: ordering one needs a registrar; the isolation check does not). The feature flag is on so the
  // positive control resolves them; every hostile call must still be a 404.
  process.env.DOMAINS_ENABLED = 'true';
  process.env.ENTERPRISE_ENABLED = 'true'; // M12: SSO/SCIM are flagged off by default; the positive control needs them on
  const acct = crypto.randomUUID();
  A.domain = crypto.randomUUID();
  A.zone = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO domains.registrar_accounts (id, registrar_id, label, environment, vault_ref, data_region, enabled)
     SELECT $1, id, 'ct-account', 'sandbox', 'vault://ct/account', 'NL', false FROM domains.registrars WHERE provider_code = 'openprovider'`,
    [acct],
  );
  await h.env.sql(
    `INSERT INTO domains.domains (id, org_id, name, tld, state, registrar_account_id, provider_ref, data_region) VALUES ($1, $2, 'ct-tenant-alpha.com', 'com', 'active', $3, 'ct-ref', 'sa-pending')`,
    [A.domain, orgA, acct],
  );
  await h.env.sql(
    `INSERT INTO domains.dns_zones (id, org_id, domain_id, name) VALUES ($1, $2, $3, 'ct-tenant-alpha.com')`,
    [A.zone, orgA, A.domain],
  );
  // M08: a database (+ backup), a bucket, an email domain, a mailbox and a message of org A (rows written directly: provisioning needs an enabled provider; the isolation
  // check does not)
  A.dbInstance = crypto.randomUUID();
  A.bucket = crypto.randomUUID();
  A.emailDomain = crypto.randomUUID();
  A.mailbox = crypto.randomUUID();
  A.emailMessage = crypto.randomUUID();
  const sender = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO data.database_instances (id, org_id, name, engine, version, plan_ref, state, data_region, provider_region_id, create_token)
     VALUES ($1, $2, 'ct-db-alpha', 'postgresql', '16', 'ct-plan', 'failed', 'sa-pending', 'ct-region', 'ct-token-db')`,
    [A.dbInstance, orgA],
  );
  await h.env.sql(
    `INSERT INTO data.storage_buckets (id, org_id, name, name_global, state, data_region, provider_region_id, create_token)
     VALUES ($1, $2, 'ct-bucket-alpha', 'ct-bucket-alpha-global', 'failed', 'sa-pending', 'ct-region', 'ct-token-bucket')`,
    [A.bucket, orgA],
  );
  await h.env.sql(
    `INSERT INTO email.email_domains (id, org_id, domain, purposes, ownership_token, data_region)
     VALUES ($1, $2, 'ct-tenant-alpha.com', ARRAY['transactional'], $3, 'sa-pending')`,
    [A.emailDomain, orgA, 'o'.repeat(32)],
  );
  await h.env.sql(
    `INSERT INTO email.mailboxes (id, org_id, domain_id, local_part, state, quota_mb, create_token, data_region)
     VALUES ($1, $2, $3, 'ct-box', 'failed', 10, 'ct-token-box', 'sa-pending')`,
    [A.mailbox, orgA, A.emailDomain],
  );
  await h.env.sql(
    `INSERT INTO email.sender_identities (id, org_id, domain_id, from_address) VALUES ($1, $2, $3, 'ct@ct-tenant-alpha.com')`,
    [sender, orgA, A.emailDomain],
  );
  await h.env.sql(
    `INSERT INTO email.messages (id, org_id, sender_id, category, state, to_hashes, recipients_enc, body_hash, idempotency_key, send_token, data_region)
     VALUES ($1, $2, $3, 'transactional', 'failed', ARRAY['x'], $4, $5, 'ct-message', 'ct-token-msg', 'sa-pending')`,
    [A.emailMessage, orgA, sender, `enc:v1:k:${'A'.repeat(40)}`, '0'.repeat(64)],
  );
  A.approval = (
    await a('POST', '/v1/billing/spend-approvals', {
      quoteId: crypto.randomUUID(),
      amount: '100',
      currency: 'SAR',
      reason: 'fixture',
    })
  ).json().id;
  await app
    .get(NotificationService)
    .notify({ orgId: orgA, userId: aliceId, kind: 'test.fixture', params: {} });
  A.notification = (
    await h.env.sql(`SELECT id FROM platform.notifications WHERE user_id=$1`, [aliceId])
  )[0]!.id as string;
  // an issued invoice and a credit note of org A (rows written directly: the services need rated usage, the isolation check does not)
  A.invoice = crypto.randomUUID();
  A.creditNote = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, buyer, seller)
     SELECT $1, $2, id, 'CT', 1, 'CT-00000001', 'sandbox', 'SAR', '2026-01-01', '2026-01-31', now(), now(), 'ct-fixture', 100, 15, 115, '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"buyerType":"b2c"}', '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"placeholder":true}' FROM invoicing.billing_entities LIMIT 1`,
    [A.invoice, orgA],
  );
  await h.env.sql(
    `INSERT INTO invoicing.credit_notes (id, org_id, invoice_id, entity_id, series, number, number_text, environment, currency, reason_code, reason, lines, net_minor, tax_minor, total_minor, issued_at, source_key)
     SELECT $1, $2, $3, entity_id, 'CTC', 1, 'CTC-00000001', 'sandbox', 'SAR', 'fixture', 'fixture', '[]', 10, 0, 10, now(), 'ct-cn-fixture' FROM invoicing.invoices WHERE id = $3`,
    [A.creditNote, orgA, A.invoice],
  );
  // a saved payment method and a (finished) payment of org A: rows written directly, tokens only
  A.consent = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO compliance.consents (id, org_id, subject_ref, purpose_id, state, seq, text_version, locale, source, created_by)
     VALUES ($1, $2, 'org', 'marketing_email', 'granted', 1, 'placeholder-1', 'en', 'api', $3)`,
    [A.consent, orgA, aliceId],
  );
  A.dsr = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO compliance.dsr_requests (id, org_id, subject_ref, type, requested_by, identity_method, due_at)
     VALUES ($1, $2, $3, 'access', $4, 'session', now() + interval '30 days')`,
    [A.dsr, orgA, `member:${aliceId}`, aliceId],
  );
  A.paymentMethod = crypto.randomUUID();
  A.payment = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO payments.payment_methods (id, org_id, psp_account_id, token_ref, brand, last4, exp_month, exp_year, fingerprint)
     SELECT $1, $2, id, 'pm_ct_000001', 'visa', '4242', 12, 2035, 'fp_ct_00000001' FROM payments.psp_accounts LIMIT 1`,
    [A.paymentMethod, orgA],
  );
  await h.env.sql(
    `INSERT INTO payments.payment_intents (id, org_id, psp_account_id, invoice_id, payment_method_id, amount_minor, currency, status, merchant_reference, failure_code)
     SELECT $1::uuid, $2, id, $3, $4, 115, 'SAR', 'failed', 'nuzm_pi_' || ($1::uuid)::text, 'card_declined' FROM payments.psp_accounts LIMIT 1`,
    [A.payment, orgA, A.invoice, A.paymentMethod],
  );
  // M11: a workflow (+ version + execution), a connector, an agency profile and a reseller profile of org A (rows written directly, flags on so the 404s are isolation); a listing and a
  // purchase id that exist nowhere for org B (the purchase chain needs a ledger-backed invoice: its isolation is proven in marketplace.int.spec)
  A.workflow = crypto.randomUUID();
  A.workflowVersion = crypto.randomUUID();
  A.execution = crypto.randomUUID();
  A.connector = crypto.randomUUID();
  A.agency = crypto.randomUUID();
  A.reseller = crypto.randomUUID();
  A.listing = crypto.randomUUID();
  A.purchase = crypto.randomUUID();
  for (const k of [
    'automation.enabled',
    'marketplace.enabled',
    'agency.enabled',
    'reseller.enabled',
  ])
    await h.env.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, NULL, 'true')`,
      [k],
    );
  await h.env.sql(
    `INSERT INTO automation.workflows (id, org_id, name, status, triggers, data_region) VALUES ($1, $2, 'ct-workflow', 'draft', '[{"type":"manual"}]', 'sa-pending')`,
    [A.workflow, orgA],
  );
  await h.env.sql(
    `INSERT INTO automation.workflow_versions (id, org_id, workflow_id, version, definition, definition_hash) VALUES ($1, $2, $3, 1, '{}', $4)`,
    [A.workflowVersion, orgA, A.workflow, 'c'.repeat(64)],
  );
  await h.env.sql(`UPDATE automation.workflows SET active_version_id = $2 WHERE id = $1`, [
    A.workflow,
    A.workflowVersion,
  ]);
  await h.env.sql(
    `INSERT INTO automation.executions (id, org_id, workflow_id, version_id, trigger, dedupe_key, status, finished_at, data_region) VALUES ($1, $2, $3, $4, 'manual', 'ct-dedupe', 'succeeded', now(), 'sa-pending')`,
    [A.execution, orgA, A.workflow, A.workflowVersion],
  );
  await h.env.sql(
    `INSERT INTO automation.connectors (id, org_id, type, name, data_region) VALUES ($1, $2, 'http', 'ct-connector', 'sa-pending')`,
    [A.connector, orgA],
  );
  await h.env.sql(`INSERT INTO programs.agencies (id, org_id, name) VALUES ($1, $2, 'ct-agency')`, [
    A.agency,
    orgA,
  ]);
  await h.env.sql(
    `INSERT INTO programs.resellers (id, org_id, name) VALUES ($1, $2, 'ct-reseller')`,
    [A.reseller, orgA],
  );
  // a hosting site, a backup and an abuse case of org A (rows written directly; the feature flag is on so the 404s below are isolation, not a closed flag)
  A.hostingSite = crypto.randomUUID();
  A.hostingBackup = crypto.randomUUID();
  A.hostingCase = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'hosting.enabled', NULL, 'true')`,
  );
  await h.env.sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 'ct-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
    [crypto.randomUUID()],
  );
  await h.env.sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref)
     SELECT $1, $2, 'ct-site', $4, 's-ct0000000001', id, 'php:8.3', 'active', 'sa-central', $3, 'vault://ct/c', 'vault://ct/b' FROM hosting.plan_definitions LIMIT 1`,
    [A.hostingSite, orgA, aliceId, 'c'.repeat(64)],
  );
  await h.env.sql(
    `INSERT INTO hosting.site_backups (id, site_id, org_id, enc_key_ref, data_region) VALUES ($1, $2, $3, 'vault://ct/b', 'sa-central')`,
    [A.hostingBackup, A.hostingSite, orgA],
  );
  await h.env.sql(
    `INSERT INTO hosting.abuse_cases (id, site_id, org_id, source, severity, reason_code) VALUES ($1, $2, $3, 'staff', 'low', 'test_case')`,
    [A.hostingCase, A.hostingSite, orgA],
  );
  // >>> M09: an AI session + run + artifact, a builder project with its first version and a deployment of org A (rows written directly; the flag is on so the 404s are isolation)
  await h.env.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'ai.enabled', NULL, 'true')`,
  );
  A.aiSession = crypto.randomUUID();
  A.aiRun = crypto.randomUUID();
  A.aiArtifact = crypto.randomUUID();
  A.aiApproval = crypto.randomUUID();
  A.bProject = crypto.randomUUID();
  A.bVersion = crypto.randomUUID();
  A.deployment = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO ai.sessions (id, org_id, title, data_region, created_by) VALUES ($1, $2, 'ct', 'sa-central', $3)`,
    [A.aiSession, orgA, aliceId],
  );
  await h.env.sql(
    `INSERT INTO ai.runs (id, org_id, session_id, kind, state, data_region, created_by, finished_at) VALUES ($1, $2, $3, 'chat', 'cancelled', 'sa-central', $4, now())`,
    [A.aiRun, orgA, A.aiSession, aliceId],
  );
  await h.env.sql(
    `INSERT INTO ai.artifacts (id, org_id, run_id, type, payload, data_region) VALUES ($1, $2, $3, 'requirements', '{}', 'sa-central')`,
    [A.aiArtifact, orgA, A.aiRun],
  );
  // >>> M10A: the app builder is flagged off by default (the positive control needs it on) and org A holds one pending agent approval
  await h.env.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'app_builder.enabled', NULL, 'true')`,
  );
  await h.env.sql(
    `INSERT INTO ai.approval_requests (id, org_id, subject_type, subject_id, run_id, approval_type, action, action_hash, status, requested_by_kind, required_roles, expires_at, data_region)
     VALUES ($1, $2, 'run', $3, $3, 'budget_increase', '{}'::jsonb, repeat('a', 64), 'pending', 'ai', '{owner}', now() + interval '1 day', 'sa-central')`,
    [A.aiApproval, orgA, A.aiRun],
  );
  // M10A resolves the project through the M09 port, still bound to an in-memory stand-in (NOT VERIFIED): org A's project must exist THERE for the positive control
  A.m10Project = (
    await app.get(ProjectsPort, { strict: false }).create(orgA, {
      type: 'webapp',
      name: 'ct-m10-project',
      dataRegion: 'sa-central',
      createdBy: aliceId,
    })
  ).id;
  // M10A rows of org A in its own tables (written directly): a sandbox, a test run and an export of that project
  A.m10Sandbox = crypto.randomUUID();
  A.m10TestRun = crypto.randomUUID();
  A.m10Export = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO builder.sandboxes (id, org_id, project_id, runtime_kind, isolation, state, quota, ttl_at, data_region, created_by)
     VALUES ($1, $2, $3, 'mock', 'simulated', 'ready', '{}'::jsonb, now() + interval '1 hour', 'sa-central', $4)`,
    [A.m10Sandbox, orgA, A.m10Project, aliceId],
  );
  await h.env.sql(
    `INSERT INTO builder.test_runs (id, org_id, project_id, version_id, suite, status, data_region, requested_by)
     VALUES ($1, $2, $3, $4, 'unit', 'queued', 'sa-central', $5)`,
    [A.m10TestRun, orgA, A.m10Project, A.bVersion, aliceId],
  );
  await h.env.sql(
    `INSERT INTO builder.exports (id, org_id, project_id, version_id, status, expires_at, data_region, requested_by)
     VALUES ($1, $2, $3, $4, 'building', now() + interval '1 day', 'sa-central', $5)`,
    [A.m10Export, orgA, A.m10Project, A.bVersion, aliceId],
  );
  // <<< M10A
  await h.env.sql(
    `INSERT INTO builder.projects (id, org_id, name, locales, data_region, created_by) VALUES ($1, $2, 'ct-project', '{ar,en}', 'sa-central', $3)`,
    [A.bProject, orgA, aliceId],
  );
  await h.env.sql(
    `INSERT INTO builder.project_versions (id, org_id, project_id, seq, site_model, model_hash, source, created_by) VALUES ($1, $2, $3, 1, $5::jsonb, repeat('a', 64), 'system', $4)`,
    [A.bVersion, orgA, A.bProject, aliceId, JSON.stringify(emptySiteModel({ ar: 'م', en: 'P' }))],
  );
  await h.env.sql(`UPDATE builder.projects SET head_version_id = $2 WHERE id = $1`, [
    A.bProject,
    A.bVersion,
  ]);
  await h.env.sql(
    `INSERT INTO deploy.deployments (id, org_id, project_id, version_id, target_ref, environment, state, data_region, created_by, finished_at) VALUES ($1, $2, $3, $4, $5, 'production', 'failed', 'sa-central', $6, now())`,
    [A.deployment, orgA, A.bProject, A.bVersion, crypto.randomUUID(), aliceId],
  );
  // <<< M09
  // a live subscription of org A (written directly; the service has its own tests)
  A.subscription = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO billing.subscriptions (id, org_id, plan_version_id, currency, status, items, quantity, payment_method_id, anchor_day, period_start, period_end)
     SELECT $1, $2, v.id, 'SAR', 'active', '[{"kind":"plan_fee","planKey":"starter","meterId":"plan.starter_months","unitPriceMinor":"100","rounding":"half_up","priceBookVersionId":"x"}]', 1, $3, 1, '2026-01-01', '2026-02-01'
       FROM billing.plan_versions v JOIN billing.plans p ON p.id = v.plan_id WHERE p.key = 'starter' AND v.status = 'published' LIMIT 1`,
    [A.subscription, orgA, A.paymentMethod],
  );
  // M05 compute fixture of org A: an instance written directly (the compute module has its own tests) on a mock-provider resource that really exists in the simulator
  await h.env.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'cloud.provisioning', NULL, 'true'::jsonb)`,
  );
  const mockAccount = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO cloud.provider_accounts (id, provider_id, name, vault_ref, created_by) SELECT $1, id, 'ct-mock', 'vault://dev/test/ct-mock', $2 FROM cloud.providers WHERE key = 'mock'`,
    [mockAccount, aliceId],
  );
  const mockRegistry = app.get(AdapterRegistry);
  const mockRef = (
    await mockRegistry
      .entry('mock-compute')!
      .create()
      .provision(
        {
          providerAccountId: mockAccount,
          credentialRef: 'vault://dev/test/ct-mock',
          traceId: 't',
          deadlineMs: 1000,
        },
        {
          providerRegionId: 'mock-sa-1',
          planRef: 'mock.small',
          imageRef: 'mock-ubuntu',
          name: 'ct',
          sshPublicKeys: [],
          tags: {},
          idempotencyToken: 'c'.repeat(64),
        },
      )
  ).providerRef!;
  const ctResource = crypto.randomUUID();
  A.instance = crypto.randomUUID();
  await h.env.sql(
    `INSERT INTO cloud.resources (id, org_id, kind, provider_account_id, provider_ref, state, data_region, country, provider_region_id, last_seen_at) VALUES ($1,$2,'compute_instance',$3,$4,'ACTIVE','in_kingdom','SA','mock-sa-1', now())`,
    [ctResource, orgA, mockAccount, mockRef],
  );
  await h.env.sql(
    `INSERT INTO compute.instances (id, org_id, resource_id, name, plan, status, capabilities, quote_id, data_region, country)
     VALUES ($1,$2,$3,'ct-instance','{"vcpu":1,"memoryMb":2048,"diskGb":40,"planRef":"mock.small"}','running','["compute.metrics","compute.action.stop"]', gen_random_uuid(), 'in_kingdom','SA')`,
    [A.instance, orgA, ctResource],
  );
  // org B's API key carries EVERY org permission an owner has: the strongest key org B can hold
  const ownerPerms = (
    await h.env.sql(`SELECT permission FROM tenancy.role_permissions WHERE role='owner'`)
  ).map((r) => r.permission as string);
  const k = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: {
      cookie: cookieHeader(bobJar),
      'x-csrf-token': bobJar.nuzm_csrf!,
      'x-nuzm-org': orgB,
      'idempotency-key': 'bob-key',
    },
    payload: { name: 'B-key', scopes: ownerPerms },
  });
  bobKey = k.json().key;
});
afterAll(() => h.close());

describe('generated cross-tenant coverage', () => {
  it('discovers the org-scoped operations from the OpenAPI spec', () => {
    expect(orgScoped.length).toBeGreaterThan(20);
    expect(withIds.length).toBeGreaterThan(15);
  });

  it('has a fixture for every path parameter of every org-scoped operation (new routes must add one)', () => {
    const missing = withIds.flatMap((o) =>
      o.params.filter((p) => !fixtureFor(o, p)).map((p) => `${o.method} ${o.path} {${p}}`),
    );
    expect(missing).toEqual([]);
  });

  it('every operation declares an access rule: a permission, any-authenticated, service-key, or no security (public)', () => {
    const bad = allOps.filter((o) => {
      const op = spec.paths[o.path]![o.method.toLowerCase()]!;
      const sec = op.security as unknown[] | undefined;
      return (
        !op['x-nuzm-permission'] &&
        !op['x-nuzm-platform-permission'] &&
        op['x-nuzm-access'] !== 'any-authenticated' &&
        op['x-nuzm-access'] !== 'service-key' &&
        !(Array.isArray(sec) && sec.length === 0)
      );
    });
    // session-only identity routes (logout, sessions, MFA, /me) are declared with security but no permission: they are @AnyAuthenticated
    expect(bad.map((o) => `${o.method} ${o.path}`).every((s) => /\/v1\/(auth|me)/.test(s))).toBe(
      true,
    );
  });
});

describe('org B owner (session) vs org A ids → 404 on every id-bearing route', () => {
  it.each(withIds.map((o) => [`${o.method} ${o.path}`, o] as const))('%s', async (_n, o) => {
    const isOrgPath = o.params.includes('orgId');
    const r = await app.inject({
      method: o.method,
      url: urlFor(o),
      headers: {
        cookie: cookieHeader(bobJar),
        'x-csrf-token': bobJar.nuzm_csrf!,
        ...(isOrgPath ? {} : { 'x-nuzm-org': orgB }),
        ...extraHeaders(o),
      },
      ...(bodyFor(o) ? { payload: bodyFor(o) as object } : {}),
    });
    expect(r.statusCode, `${o.method} ${o.path} → ${r.body.slice(0, 120)}`).toBe(404);
  });
});

describe('org B API key (every owner permission) vs org A ids → 404', () => {
  it.each(
    withIds
      // session-only routes (an API key is refused up front, which confirms nothing about the id)
      .filter((o) => !o.path.startsWith('/v1/api-keys') || o.method !== 'POST')
      .filter((o) => !o.path.startsWith('/v1/billing/spend-approvals/'))
      .map((o) => [`${o.method} ${o.path}`, o] as const),
  )('%s', async (_n, o) => {
    const r = await app.inject({
      method: o.method,
      url: urlFor(o),
      headers: { authorization: `Bearer ${bobKey}`, ...extraHeaders(o) },
      ...(bodyFor(o) ? { payload: bodyFor(o) as object } : {}),
    });
    // a route that needs step-up is session-only in practice; for keys the id lookup still must not confirm existence
    expect([404, 401], `${o.method} ${o.path} → ${r.statusCode} ${r.body.slice(0, 100)}`).toContain(
      r.statusCode,
    );
    expect(r.statusCode).not.toBe(200);
    expect(r.statusCode).not.toBe(403);
  });
});

describe('admin-console routes are unreachable with tenant credentials', () => {
  const adminOps = allOps.filter((o) =>
    Boolean(spec.paths[o.path]![o.method.toLowerCase()]!['x-nuzm-platform-permission']),
  );
  it('discovers the admin operations from the spec', () =>
    expect(adminOps.length).toBeGreaterThan(5));
  it.each(adminOps.map((o) => [`${o.method} ${o.path}`, o] as const))(
    '%s refuses an org owner session and an API key',
    async (_n, o) => {
      const url = o.path.replace(/\{(\w+)\}/g, aliceId);
      const viaSession = await app.inject({
        method: o.method,
        url,
        headers: {
          cookie: cookieHeader(bobJar),
          'x-csrf-token': bobJar.nuzm_csrf!,
          'x-nuzm-org': orgB,
        },
        ...(o.method === 'GET' ? {} : { payload: {} }),
      });
      const viaKey = await app.inject({
        method: o.method,
        url,
        headers: { authorization: `Bearer ${bobKey}` },
        ...(o.method === 'GET' ? {} : { payload: {} }),
      });
      expect(viaSession.statusCode, viaSession.body).toBe(401); // no admin-realm session cookie
      expect(viaKey.statusCode, viaKey.body).toBe(401);
    },
  );
});

describe("list routes never leak the other org's rows", () => {
  const lists = orgScoped.filter((o) => o.method === 'GET' && o.params.length === 0);
  it.each(lists.map((o) => [o.path, o] as const))('GET %s', async (_p, o) => {
    const viaSession = await app.inject({
      method: 'GET',
      url: o.path,
      headers: { cookie: cookieHeader(bobJar), 'x-nuzm-org': orgB },
    });
    const viaKey = await app.inject({
      method: 'GET',
      url: o.path,
      headers: { authorization: `Bearer ${bobKey}` },
    });
    for (const r of [viaSession, viaKey]) {
      for (const [name, id] of Object.entries(A))
        expect(r.body, `${o.path} leaked org A ${name}`).not.toContain(id);
      expect(r.body).not.toContain('A-ws');
      expect(r.body).not.toContain('A-proj');
    }
  });
});

describe("after all the hostile calls, org A's data is untouched", () => {
  it(
    'fixtures still exist at their original versions (nothing was changed, deleted or revoked)',
    { timeout: 120_000 },
    async () => {
      const rows = await h.env.sql(
        `SELECT 'workspace' k, version::int v, deleted_at FROM tenancy.workspaces WHERE id=$1
      UNION ALL SELECT 'project', version::int, deleted_at FROM tenancy.projects WHERE id=$2
      UNION ALL SELECT 'env', version::int, deleted_at FROM tenancy.environments WHERE id=$3`,
        [A.workspace, A.project, A.env],
      );
      for (const r of rows) {
        expect(r.v, String(r.k)).toBe(1);
        expect(r.deleted_at, String(r.k)).toBeNull();
      }
      expect(
        (await h.env.sql(`SELECT revoked_at FROM identity.api_keys WHERE id=$1`, [A.apiKey]))[0]!
          .revoked_at,
      ).toBeNull();
      expect(
        (
          await h.env.sql(`SELECT revoked_at, accepted_at FROM tenancy.invitations WHERE id=$1`, [
            A.invitation,
          ])
        )[0],
      ).toEqual({ revoked_at: null, accepted_at: null });
      expect(
        (
          await h.env.sql(`SELECT state, cancel_requested FROM platform.operations WHERE id=$1`, [
            A.operation,
          ])
        )[0],
      ).toEqual({ state: 'pending', cancel_requested: false });
      expect(
        (
          await h.env.sql(`SELECT count(*)::int n FROM tenancy.memberships WHERE org_id=$1`, [orgA])
        )[0]!.n,
      ).toBe(1);
    },
  );

  it(
    "positive control: the same ids resolve for org A's own owner, so the 404s above were isolation, not bad fixtures",
    { timeout: 120_000 },
    async () => {
      const alice = await h.sessionFor(app, aliceId);
      for (const o of withIds.filter(
        (x) =>
          x.method === 'GET' &&
          !x.path.includes('{userId}') &&
          !x.path.startsWith('/v1/marketplace/purchases/'), // needs the ledger-backed invoice chain: see marketplace.int.spec
      )) {
        const r = await app.inject({
          method: 'GET',
          url: urlFor(o),
          headers: { cookie: cookieHeader(alice), 'x-nuzm-org': orgA },
        });
        // the e-invoice XML is 409 by design until the ZATCA module exists; that still proves the id resolved (not a 404)
        // M09: a file read without ?path= is 422 once the project id resolved (a 404 would mean the fixture is wrong)
        const expected = o.path.endsWith('/invoices/{id}/xml')
          ? 409
          : o.path.endsWith('/files/content')
            ? 422
            : 200;
        expect(r.statusCode, `${o.path} → ${r.body.slice(0, 100)}`).toBe(expected);
      }
    },
  );
});
