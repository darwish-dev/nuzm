import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';
import { DB_URL as DB } from './env';

/**
 * M12 console screens in the Arabic (RTL) and English projects: customer SSO (UI-M12-01) and the admin operations and governance screens
 * (UI-M12-04..12, -14, -16, -17).
 *
 * STATUS: NOT RUN. Written without running Playwright: the ports (3000, 3001, 4000, 4010) were held by the owner's dev servers, so no screenshot
 * was produced either. Run it in a session that owns those ports: `pnpm test:e2e`. It runs after 01-customer and 02-admin (it uses this locale's
 * owner organization, the staff user whose MFA was enrolled there, and the screenshots land in docs/reports/screenshots/<locale>/).
 *
 * Not covered here, on purpose: UI-M12-02 (SCIM tokens, SCR-M12-01), UI-M12-03 (org security policy, SCR-M12-02), UI-M12-13 (the audit explorer is the
 * existing admin audit-logs screen) and UI-M12-15 (the M03 reconciliations screen is not extended). The test login stays disabled (SCR-M12-05) and the
 * launch board stays read-only (SCR-M12-03); this spec asserts exactly that.
 */

const ADMIN = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:3000';
const sql = async <R extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as R[];
  } finally {
    await c.end();
  }
};

/** Test tooling: mark the user's sessions as recently MFA-verified so a step-up prompt does not interrupt the flow (as 03-billing and 09 do). */
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}
const setSsoFlag = (on: boolean) =>
  on
    ? sql(
        `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'enterprise.sso', NULL, 'true') ON CONFLICT DO NOTHING`,
      )
    : sql(`DELETE FROM platform.feature_flags WHERE key = 'enterprise.sso' AND org_id IS NULL`);
/** A `datetime-local` value `days` from now (negative = past), on a whole hour. */
const localIn = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.toISOString().slice(0, 11)}${String(hour).padStart(2, '0')}:00`;
};

test('customer SSO: flag off, then connection, DNS proof, disabled test login, enforcement unavailable (UI-M12-01)', async ({
  page,
}, info) => {
  const L = loc(info);
  const owner = `owner-${L}@example.test`;
  const domain = `sso-${L}-${Date.now()}.example.test`;
  await setSsoFlag(false);
  await signIn(page, info, owner, WEB);
  await elevate(owner);

  // --- flag off: no navigation entry, and the page says the capability is not enabled (the API answers 404)
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'm12.nav.sso') }),
  ).toHaveCount(0);
  await page.goto(`${WEB}/${L}/settings/security/sso`);
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.sso.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm12.sso.flagOff.title'))).toBeVisible();
  await audit(page, info, 'm12-sso-flag-off');

  // --- flag on: the entry appears, the screen says the test login is not available
  await setSsoFlag(true);
  await page.goto(`${WEB}/${L}/settings/security/sso`);
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'm12.nav.sso') }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm12.sso.testBanner'))).toBeVisible();
  await expect(page.getByText(T(info, 'm12.sso.none'))).toBeVisible();
  await audit(page, info, 'm12-sso-empty');

  // --- a secret VALUE is never sent: OIDC takes a vault reference only
  const form = page.getByRole('form', { name: T(info, 'm12.sso.create.title') });
  await form.getByLabel(T(info, 'm12.sso.create.name')).fill('Corporate OIDC');
  await form.getByLabel(T(info, 'm12.sso.protocol')).selectOption('oidc');
  await form.getByLabel(T(info, 'm12.sso.create.domains')).fill(domain);
  await form.getByLabel(T(info, 'm12.sso.create.issuer')).fill('https://login.example.test');
  await form.getByLabel(T(info, 'm12.sso.create.clientId')).fill('nuzm-e2e');
  await form.getByLabel(T(info, 'm12.sso.create.secretRef')).fill('not-a-vault-reference');
  await form.getByRole('button', { name: T(info, 'm12.sso.create.submit') }).click();
  await expect(form.getByText(T(info, 'm12.sso.err.invalid'))).toBeVisible();

  // --- create with a vault reference: the connection is waiting for the DNS proof, with the record to copy
  await form.getByLabel(T(info, 'm12.sso.create.secretRef')).fill('vault://e2e/sso-oidc');
  await form.getByRole('button', { name: T(info, 'm12.sso.create.submit') }).click();
  await expect(
    page.locator('section.nz-card', { hasText: 'Corporate OIDC' }).first(),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm12.sso.status.pending_domain_proof'))).toBeVisible();
  await expect(page.getByLabel(T(info, 'm12.sso.txtName'))).toHaveValue(`_nuzm-sso.${domain}`);
  await expect(page.getByLabel(T(info, 'm12.sso.txtValue'))).toHaveValue(/^nuzm-sso-verification=/);
  await expect(page.getByLabel(T(info, 'm12.sso.txtName'))).toHaveAttribute('dir', 'ltr');

  // --- test login disabled with its reason; enforcement unavailable until a test login has succeeded
  await expect(page.getByRole('button', { name: T(info, 'm12.sso.test.button') })).toBeDisabled();
  await expect(page.getByText(T(info, 'm12.sso.test.unavailable'))).toBeVisible();
  await expect(
    page.getByRole('button', { name: T(info, 'm12.sso.enforce.enable') }),
  ).toBeDisabled();
  await expect(page.getByText(T(info, 'm12.sso.enforce.unavailable'))).toBeVisible();
  // no certificate or secret anywhere on the page
  await expect(page.locator('body')).not.toContainText(/BEGIN CERTIFICATE|not-a-vault-reference/);
  await audit(page, info, 'm12-sso-connection', [page.getByLabel(T(info, 'm12.sso.txtValue'))]);

  // --- just-in-time provisioning: only non-administrative roles
  const roles = await page
    .getByLabel(T(info, 'm12.sso.jit.role'))
    .first()
    .locator('option')
    .allTextContents();
  expect(roles).toHaveLength(3);
  await page
    .getByRole('button', { name: T(info, 'm12.sso.jit.save') })
    .first()
    .click();
  await expect(page.getByText(T(info, 'm12.sso.saved')).first()).toBeVisible();

  await setSsoFlag(false); // leave the platform as the other specs expect it: the capability is off
});

test('admin operations: health, incidents (open, timeline, update, draft), alerts, provider incidents, recovery exercises (UI-M12-04..09)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  const adm = (p: string) => `${ADMIN}/${L}${p}`;
  const tag = `e2e-${L}-${Date.now()}`;
  await signIn(page, info, staff, ADMIN);
  await elevate(staff);

  // --- navigation entry and health: what is not measured is not shown as healthy
  await page.goto(adm('/operations/health'));
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.health.title'), level: 1 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'm12.nav.admin.ops') }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm12.health.help'))).toBeVisible();
  await expect(page.getByRole('table', { name: T(info, 'm12.health.components') })).toBeVisible();
  await expect(page.getByText(T(info, 'm12.health.noProbes'))).toBeVisible(); // a fresh database has run no probe
  await audit(page, info, 'm12-admin-health');

  // --- incidents: open one; the detail shows the timeline; update the status; add a communications draft
  await page.goto(adm('/incidents'));
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.inc.title'), level: 1 }),
  ).toBeVisible();
  const open = page.getByRole('form', { name: T(info, 'm12.inc.open.title') });
  await open.getByLabel(T(info, 'm12.inc.col.severity')).selectOption('SEV3');
  await open.getByLabel(T(info, 'm12.inc.open.titleField')).fill(`Queue lag ${tag}`);
  await open.getByLabel(T(info, 'm12.inc.open.components')).fill('worker, outbox');
  await open.getByRole('button', { name: T(info, 'm12.inc.open.submit') }).click();
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.inc.detail.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(`Queue lag ${tag}`).first()).toBeVisible();
  await expect(page.getByRole('table', { name: T(info, 'm12.inc.timeline') })).toContainText(
    T(info, 'm12.inc.kind.opened'),
  );
  await audit(page, info, 'm12-admin-incident-detail');
  const upd = page.getByRole('form', { name: T(info, 'm12.inc.update.title') });
  await upd.getByLabel(T(info, 'm12.inc.col.status')).selectOption('investigating');
  await upd
    .getByLabel(T(info, 'm12.inc.update.comms'))
    .fill('Draft: we are investigating a delay.');
  await upd.getByRole('button', { name: T(info, 'm12.inc.update.submit') }).click();
  await expect(page.getByText(T(info, 'm12.inc.updated'))).toBeVisible();
  await expect(page.getByText('Draft: we are investigating a delay.')).toBeVisible();
  await expect(page.getByRole('table', { name: T(info, 'm12.inc.timeline') })).toContainText(
    T(info, 'm12.inc.status.investigating'),
  );
  // personal data in a record is refused
  await upd.getByLabel(T(info, 'm12.inc.update.note')).fill('contact omar@example.test about it');
  await upd.getByRole('button', { name: T(info, 'm12.inc.update.submit') }).click();
  await expect(page.getByText(T(info, 'm12.inc.invalid'))).toBeVisible();

  // --- the list shows it, and the filter narrows it
  await page.goto(adm('/incidents?status=investigating'));
  await expect(page.getByRole('link', { name: `Queue lag ${tag}` })).toBeVisible();
  await audit(page, info, 'm12-admin-incidents');

  // --- alerts: define a rule (runbook required), silence it with an expiry, remove the silence
  const key = `e2e.${L}.${Date.now()}`;
  await page.goto(adm('/alerts'));
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.al.title'), level: 1 }),
  ).toBeVisible();
  const def = page.getByRole('form', { name: T(info, 'm12.al.define.title') });
  await def.getByLabel(T(info, 'm12.al.define.key')).fill(key);
  await def.getByLabel(T(info, 'm12.al.col.title')).fill(`Rule ${tag}`);
  await def.getByLabel(T(info, 'm12.al.col.owner')).fill('platform_admin');
  await def.getByLabel(T(info, 'm12.al.col.runbook')).fill('docs/runbooks/queue-recovery.md');
  await def.getByLabel(T(info, 'm12.al.define.metric')).fill('queue.max_lag_seconds');
  await def.getByLabel(T(info, 'm12.al.define.threshold')).fill('300');
  await def.getByRole('button', { name: T(info, 'm12.al.define.submit') }).click();
  await expect(page.getByText(T(info, 'm12.al.defined'))).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: key });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: T(info, 'm12.al.silence') }).click();
  await row.getByLabel(T(info, 'm12.al.until')).fill(localIn(3));
  await row.getByRole('button', { name: T(info, 'm12.al.silenceSubmit') }).click();
  await expect(
    page.getByRole('row').filter({ hasText: key }).getByText(T(info, 'm12.al.state.silenced')),
  ).toBeVisible();
  await audit(page, info, 'm12-admin-alerts');
  await page
    .getByRole('row')
    .filter({ hasText: key })
    .getByRole('button', { name: T(info, 'm12.al.unsilence') })
    .click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: key })
      .getByText(T(info, 'm12.al.state.ok'), { exact: true }),
  ).toBeVisible();

  // --- provider incidents: read-only feed (a table, or the empty state on a fresh database)
  await page.goto(adm('/provider-incidents'));
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.pi.title'), level: 1 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: T(info, 'm12.pi.title') })
      .or(page.getByText(T(info, 'm12.pi.none'))),
  ).toBeVisible();
  await audit(page, info, 'm12-admin-provider-incidents');

  // --- recovery exercises: the RTO is computed from the two timestamps, never typed
  await page.goto(adm('/recovery-exercises'));
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.dr.title'), level: 1 }),
  ).toBeVisible();
  const dr = page.getByRole('form', { name: T(info, 'm12.dr.form.title') });
  await dr.getByLabel(T(info, 'm12.dr.col.scope')).selectOption('control_plane_db');
  await dr.getByLabel(T(info, 'm12.dr.col.env')).selectOption('staging');
  await dr.getByLabel(T(info, 'm12.dr.col.started')).fill(localIn(-2, 10));
  await dr.getByLabel(T(info, 'm12.dr.col.restored')).fill(localIn(-2, 11));
  await expect(dr.getByText('01:00:00')).toBeVisible();
  await expect(dr.getByLabel(T(info, 'm12.dr.col.rto'))).toHaveCount(0);
  await dr.getByLabel(T(info, 'm12.dr.col.rpo')).fill('120');
  await dr.getByLabel(T(info, 'm12.dr.col.evidence')).fill(`evidence/${tag}.log`);
  await dr.getByRole('button', { name: T(info, 'm12.dr.submit') }).click();
  await expect(page.getByText(T(info, 'm12.dr.recorded'))).toBeVisible();
  const rec = page.getByRole('row').filter({ hasText: `evidence/${tag}.log` });
  await expect(rec).toBeVisible();
  await expect(rec.getByText(T(info, 'm12.dr.result.pass'))).toBeVisible();
  await expect(rec.getByText('01:00:00').first()).toBeVisible();
  await audit(page, info, 'm12-admin-recovery-exercises');
});

test('admin governance: access review, policy versions, audit retention (UI-M12-10..12, -14)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  const adm = (p: string) => `${ADMIN}/${L}${p}`;
  await signIn(page, info, staff, ADMIN);
  await elevate(staff);
  const org = (
    await sql<{ id: string; email: string }>(
      `SELECT m.org_id AS id, u.email FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [`owner-${L}@example.test`],
    )
  )[0];
  const me = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [staff])
  )[0];
  if (!org || !me)
    throw new Error('run 01-customer and 02-admin first: no owner organization or staff user');

  // --- access reviews: create a campaign for the organization with this staff member as the reviewer, then keep one member with a reason
  await page.goto(adm('/access-reviews'));
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.ar.title'), level: 1 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'm12.nav.admin.gov') }),
  ).toBeVisible();
  const create = page.getByRole('form', { name: T(info, 'm12.ar.create.title') });
  await create.getByLabel(T(info, 'm12.ar.create.org')).fill(org.id);
  await create.getByLabel(T(info, 'm12.ar.create.reviewers')).fill(me.id);
  await create.getByLabel(T(info, 'm12.ar.col.due')).fill(localIn(14));
  await create.getByRole('button', { name: T(info, 'm12.ar.create.submit') }).click();
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.ar.detail.title'), level: 1 }),
  ).toBeVisible();
  const items = page.getByRole('table', { name: T(info, 'm12.ar.items') });
  await expect(items).toContainText(org.email);
  await audit(page, info, 'm12-admin-access-review');
  const first = items.getByRole('row').filter({ hasText: org.email });
  await first.getByLabel(T(info, 'm12.ar.reason')).fill('still a current owner');
  await first.getByRole('button', { name: T(info, 'm12.ar.keep') }).click();
  await expect(
    page.getByRole('row').filter({ hasText: org.email }).getByText(T(info, 'm12.ar.decision.keep')),
  ).toBeVisible();

  // --- policy versions: a version without an approver is a draft; this screen never approves
  const key = `e2e-security-${L}`;
  await page.goto(adm('/policies'));
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.pol.title'), level: 1 }),
  ).toBeVisible();
  const pol = page.getByRole('form', { name: T(info, 'm12.pol.form.title') });
  await pol.getByLabel(T(info, 'm12.pol.col.key')).fill(key);
  await pol.getByLabel(T(info, 'm12.pol.col.title')).fill('Security policy (e2e)');
  await pol.getByLabel(T(info, 'm12.pol.col.ref')).fill('dataroom://policies/e2e-security.pdf');
  await pol.getByLabel(T(info, 'm12.pol.col.effective')).fill('2026-12-01');
  await pol.getByRole('button', { name: T(info, 'm12.pol.form.submit') }).click();
  await expect(page.getByText(T(info, 'm12.pol.published'))).toBeVisible();
  const prow = page.getByRole('row').filter({ hasText: key });
  await expect(prow).toBeVisible();
  await expect(prow.getByText(T(info, 'm12.pol.status.draft'))).toBeVisible();
  await audit(page, info, 'm12-admin-policies');

  // --- audit retention: the minimum, the dry run, the legal holds; archival is not available
  await page.goto(adm('/audit/retention'));
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.ret.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm12.ret.noArchival'))).toBeVisible();
  await expect(page.getByRole('heading', { name: T(info, 'm12.ret.minimum') })).toBeVisible();
  await expect(page.getByRole('heading', { name: T(info, 'm12.ret.dryRun') })).toBeVisible();
  await expect(page.getByRole('heading', { name: T(info, 'm12.ret.holds') })).toBeVisible();
  await audit(page, info, 'm12-admin-audit-retention');
  // a period below the minimum is refused before anything is sent
  const ret = page.getByRole('form', { name: T(info, 'm12.ret.form.title') });
  await ret.getByLabel(T(info, 'm12.ret.col.class')).fill('security');
  await ret.getByLabel(T(info, 'm12.ret.col.retain')).fill('30');
  await ret.getByLabel(T(info, 'm12.ret.col.archive')).fill('10');
  await ret.getByLabel(T(info, 'm12.ret.col.basis')).fill('e2e check of the minimum');
  await ret.getByRole('button', { name: T(info, 'm12.ret.form.submit') }).click();
  await expect(ret.getByText(T(info, 'm12.ret.belowMinimum'))).toBeVisible();
});

test('admin static pages: launch readiness is read-only (SCR-M12-03); the support handbook is a static runbook index (UI-M12-16, -17)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  await signIn(page, info, staff, ADMIN);
  await elevate(staff);

  await page.goto(`${ADMIN}/${L}/launch`);
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.launch.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm12.launch.notApproved'))).toBeVisible();
  await expect(page.getByText('docs/reports/ga-readiness-checklist.md')).toBeVisible();
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0); // nothing to click: no decision can be recorded here
  await audit(page, info, 'm12-admin-launch');

  await page.goto(`${ADMIN}/${L}/support/handbook`);
  await expect(
    page.getByRole('heading', { name: T(info, 'm12.hb.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm12.hb.status'))).toBeVisible();
  await expect(page.getByText('docs/runbooks/incident-response.md')).toBeVisible();
  await expect(page.getByText(T(info, 'm12.hb.e.incident-response'))).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /runbooks/ })).toHaveCount(0); // plain-text paths, no links
  await audit(page, info, 'm12-admin-handbook');
});
