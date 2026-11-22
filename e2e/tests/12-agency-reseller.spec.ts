import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';
import { DB_URL as DB } from './env';

/**
 * Agency and reseller screens of M11 (UI-M11-10..19), customer console, Arabic and English projects.
 *
 * STATUS: NOT RUN. Written without running Playwright (the E2E ports and the local database belong to other sessions). No selector, timing or
 * data assumption has been exercised; the axe/screenshot step of `audit` is part of the same NOT RUN status.
 *
 * Flow: the owner creates an AGENCY organization (type picker in /orgs/new), the existing customer organization is the CLIENT. The agency invites the
 * client; the client (the same user, after switching organization) accepts the link and a grant at /settings/partners; the agency then acts in the
 * client, which must show the client-context banner on every page. Then a RESELLER organization links the client as a sub-organization, edits its price
 * rules (a negative markup is blocked) and reads a statement (issuer model disabled / BLOCKED). The revoke buttons are asserted DISABLED (SCR-M11-01),
 * the consolidated billing screen is asserted BLOCKED.
 */

const sql = async <T extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as T[];
  } finally {
    await c.end();
  }
};
async function flag(key: string, on: boolean) {
  await sql(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id IS NULL`, [key]);
  await sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, NULL, $2::jsonb)`,
    [key, on ? 'true' : 'false'],
  );
}
async function elevate(email: string) {
  await sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
}
const orgOf = async (email: string, type: string) =>
  (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id JOIN tenancy.organizations o ON o.id = m.org_id WHERE u.email = $1 AND o.type = $2 ORDER BY o.created_at LIMIT 1`,
      [email, type],
    )
  )[0]?.id;

/** Create an organization of a type through the console (idempotent: reuses one that exists). */
async function ensureOrg(page: Page, info: TestInfo, email: string, type: 'agency' | 'reseller') {
  const L = loc(info);
  let id = await orgOf(email, type);
  if (id) return id;
  await page.goto(`/${L}/orgs/new`);
  await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(`M11 ${type} ${L}`);
  await page.getByLabel(T(info, 'field.type'), { exact: true }).selectOption(type);
  await page.getByRole('button', { name: T(info, 'action.create') }).click();
  await expect(page.getByText(T(info, 'home.org', { org: `M11 ${type} ${L}` }))).toBeVisible();
  id = await orgOf(email, type);
  if (!id) throw new Error(`organization of type ${type} was not created`);
  return id;
}
/** Switch the active organization the way the console does (the `nuzm_org` cookie). */
async function switchOrg(page: Page, info: TestInfo, orgId: string) {
  await page
    .context()
    .addCookies([{ name: 'nuzm_org', value: orgId, url: 'http://127.0.0.1:3000' }]);
  await page.goto(`/${loc(info)}`);
}

test('agency: invite, client accepts, propose a grant, act as the client (UI-M11-10..14, 19)', async ({
  page,
}, info) => {
  const L = loc(info);
  const go = (p: string) => page.goto(`/${L}${p}`);
  const email = `owner-${L}@example.test`;
  const nav = page.getByRole('navigation', { name: T(info, 'nav.primary') });
  await signIn(page, info, email);
  await elevate(email);
  const client = await orgOf(email, 'customer');
  if (!client) throw new Error('run 01-customer first: no customer organization');
  const agency = await ensureOrg(page, info, email, 'agency');
  await flag('agency.enabled', false);
  await flag('automation.enabled', true);

  // --- the entry is hidden and the page says why while the flag is off
  await switchOrg(page, info, agency);
  await expect(nav.getByRole('link', { name: T(info, 'nav.agency') })).toHaveCount(0);
  await go('/agency');
  await expect(page.getByText(T(info, 'm11.state.featureOff.title'))).toBeVisible();
  await flag('agency.enabled', true);

  // --- UI-M11-10: dashboard, no profile yet → create it
  await go('/agency');
  await expect(nav.getByRole('link', { name: T(info, 'nav.agency') })).toBeVisible();
  const create = page.getByRole('button', { name: T(info, 'm11.ag.createProfile') });
  if (await create.isVisible()) await create.click();
  await expect(page.getByText(T(info, 'm11.ag.stat.clients'))).toBeVisible();
  await expect(page.getByText(T(info, 'm11.ag.health.title'))).toBeVisible(); // health/usage: BLOCKED, said plainly
  await audit(page, info, 'm11-agency');

  // --- UI-M11-11: invite the client (a bad id is refused in the browser)
  await go('/agency/clients');
  await page.getByLabel(T(info, 'm11.ag.clientOrgId')).fill('not-a-uuid');
  await page.getByRole('button', { name: T(info, 'm11.ag.inviteAction') }).click();
  await expect(page.getByText(T(info, 'm11.ag.errOrgId'))).toBeVisible();
  await page.getByLabel(T(info, 'm11.ag.clientOrgId')).fill(client);
  await page.getByRole('button', { name: T(info, 'm11.ag.inviteAction') }).click();
  await expect(page.getByText(T(info, 'm11.ag.invited'))).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: client }).getByText(T(info, 'm11.link.status.pending')),
  ).toBeVisible();
  await audit(page, info, 'm11-agency-clients');

  // --- UI-M11-19: the client accepts the link
  await switchOrg(page, info, client);
  await go('/settings/partners');
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.pt.title'), level: 1 }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: T(info, 'm11.pt.accept') })
    .first()
    .click();
  await expect(page.getByText(T(info, 'm11.link.status.active'))).toBeVisible();

  // --- UI-M11-12: the agency proposes a grant: scopes picker, mandatory expiry (default 90 days)
  await switchOrg(page, info, agency);
  await go(`/agency/clients/${client}/access`);
  const expiry = page.getByLabel(T(info, 'm11.gr.expiry'));
  await expect(expiry).not.toHaveValue('');
  await page.getByRole('button', { name: T(info, 'm11.gr.proposeAction') }).click();
  await expect(page.getByText(T(info, 'm11.gr.errScopes'))).toBeVisible();
  await expiry.fill('');
  await page.getByLabel('automation:read').check();
  await page.getByRole('button', { name: T(info, 'm11.gr.proposeAction') }).click();
  await expect(page.getByText(T(info, 'm11.gr.errExpiry.missing'))).toBeVisible();
  await expiry.fill(new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10));
  await page.getByLabel('automation:write').check();
  await page.getByRole('button', { name: T(info, 'm11.gr.proposeAction') }).click();
  await expect(page.getByText(T(info, 'm11.gr.proposed'))).toBeVisible();
  await audit(page, info, 'm11-agency-access');

  // --- the client accepts the grant; revoke is shown disabled with the SCR note
  await switchOrg(page, info, client);
  await go('/settings/partners');
  await page
    .getByRole('button', { name: T(info, 'm11.pt.accept') })
    .first()
    .click();
  await expect(page.getByRole('button', { name: T(info, 'm11.gr.revoke') }).first()).toBeDisabled();
  await expect(page.getByText(T(info, 'm11.gr.revokeBlocked')).first()).toBeVisible();
  await audit(page, info, 'm11-partners');

  // --- UI-M11-13: act as the client; the banner is on EVERY page; workflow screens work in the client context
  await switchOrg(page, info, agency);
  await go(`/agency/acting/${client}`);
  await page.getByRole('button', { name: T(info, 'm11.act.start') }).click();
  const banner = page.getByTestId('acting-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(client);
  for (const p of ['/agency', '/agency/clients', '/automation/workflows', '/notifications']) {
    await go(p);
    await expect(banner).toBeVisible();
  }
  await go('/automation/workflows');
  await expect(
    page.getByRole('heading', { name: T(info, 'm11.wf.title'), level: 1 }),
  ).toBeVisible(); // 200 in the client context
  await audit(page, info, 'm11-agency-acting');
  await banner.getByRole('button', { name: T(info, 'm11.act.stop') }).click();
  await expect(banner).toHaveCount(0);

  // --- UI-M11-14: consolidated billing is BLOCKED (no endpoint)
  await go('/agency/billing');
  await expect(page.getByText('BLOCKED')).toBeVisible();
  await expect(page.getByText(T(info, 'm11.ag.billing.blockedBody'))).toBeVisible();
  await audit(page, info, 'm11-agency-billing');
});

test('reseller: link a sub-organization, price rules with margin preview and below-cost block, statement (UI-M11-15..18)', async ({
  page,
}, info) => {
  const L = loc(info);
  const go = (p: string) => page.goto(`/${L}${p}`);
  const email = `owner-${L}@example.test`;
  await signIn(page, info, email);
  await elevate(email);
  const sub = await orgOf(email, 'customer');
  if (!sub) throw new Error('run 01-customer first: no customer organization');
  const reseller = await ensureOrg(page, info, email, 'reseller');
  await flag('reseller.enabled', true);
  await switchOrg(page, info, reseller);

  // --- UI-M11-15: dashboard (create the profile when missing)
  await go('/reseller');
  const create = page.getByRole('button', { name: T(info, 'm11.rs.createProfile') });
  if (await create.isVisible()) await create.click();
  await expect(page.getByText(T(info, 'm11.rs.stat.subs'))).toBeVisible();
  await audit(page, info, 'm11-reseller');

  // --- UI-M11-16: link an existing organization; creating a new one is said to be unavailable
  await go('/reseller/sub-organizations');
  await expect(page.getByText(T(info, 'm11.rs.createUnavailable'))).toBeVisible();
  await page.getByLabel(T(info, 'm11.rs.subOrgId')).fill(sub);
  await page.getByRole('button', { name: T(info, 'm11.rs.linkAction') }).click();
  await expect(page.getByText(T(info, 'm11.rs.linked'))).toBeVisible();
  await audit(page, info, 'm11-reseller-subs');
  await switchOrg(page, info, sub);
  await go('/settings/partners');
  await page
    .getByRole('button', { name: T(info, 'm11.pt.accept') })
    .last()
    .click();
  await switchOrg(page, info, reseller);

  // --- UI-M11-17: price rules: margin preview, below-cost blocking, If-Match with the rule-set version
  await go('/reseller/pricing');
  await page.getByRole('button', { name: T(info, 'm11.pr.add') }).click();
  await page.getByLabel(T(info, 'm11.pr.scopeKey')).first().fill('compute.hours');
  await page
    .getByLabel(T(info, 'm11.pr.value.percent', { currency: 'SAR' }))
    .first()
    .fill('12.5');
  await expect(page.getByTestId('preview-0')).toContainText('112.50'); // 100.00 sample + 12.5 %
  await page
    .getByLabel(T(info, 'm11.pr.value.percent', { currency: 'SAR' }))
    .first()
    .fill('-5');
  await expect(page.getByText(T(info, 'm11.pr.belowCost')).first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: T(info, 'm11.pr.save', { version: 0 }) }),
  ).toBeDisabled();
  await page
    .getByLabel(T(info, 'm11.pr.value.percent', { currency: 'SAR' }))
    .first()
    .fill('12.5');
  await page.getByRole('button', { name: T(info, 'm11.pr.save', { version: 0 }) }).click();
  await expect(page.getByText(T(info, 'm11.pr.saved'))).toBeVisible();
  await audit(page, info, 'm11-reseller-pricing');

  // --- UI-M11-18: statement, CSV link, issuer-model banner shows disabled/BLOCKED and offers no control to enable it
  await go('/reseller/statements');
  await expect(page.getByText(T(info, 'm11.st.issuer.title'))).toBeVisible();
  await expect(page.getByText('BLOCKED').first()).toBeVisible();
  await expect(page.getByRole('link', { name: T(info, 'm11.st.csv') })).toHaveAttribute(
    'href',
    /statements\/export\?period=\d{4}-\d{2}$/,
  );
  await audit(page, info, 'm11-reseller-statements');
});
