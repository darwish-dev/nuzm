import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { dir, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { WEB } from './env';

export const loc = (info: TestInfo) => info.project.name as Locale;
export const T = (info: TestInfo, key: MessageKey, params?: Record<string, string | number>) =>
  t(loc(info), key, params);

const SHOTS = join(__dirname, '..', '..', 'docs', 'reports', 'screenshots');

/** Sign in through the dev IdP user picker. `base` selects the console (customer :3000 / admin :3001). */
export async function signIn(page: Page, info: TestInfo, email: string, base = WEB) {
  await page.goto(`${base}/${loc(info)}/login`);
  // already signed in (a fixture created the person's organization through the screens): the console leaves the sign-in page, nothing more to do
  if (!/\/login\/?$/.test(new URL(page.url()).pathname)) return;
  // the sign-in pages offer a password form and, below it, the identity provider (the dev IdP user picker) as a link
  await page.getByRole('link', { name: T(info, 'login.sso') }).click();
  await page.getByRole('link', { name: new RegExp(email.replace('.', '\\.')) }).click();
}

export function totp(secret: string) {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate();
}

/** Page-level checks every screen must pass, then a stored screenshot: direction, language, axe (WCAG A/AA incl. contrast). */
export async function audit(
  page: Page,
  info: TestInfo,
  name: string,
  mask: Locator[] = [],
  /** CSS selectors of regions axe cannot enter and that are not the console's own UI (a script-less sandboxed frame showing a customer's content): the frame element itself stays audited */
  exclude: string[] = [],
) {
  const l = loc(info);
  // axe measures colours at one instant: a button under the pointer or mid-transition reads as a false contrast failure. Settle the page first.
  await page.mouse.move(0, 0);
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await expect(page.locator('html')).toHaveAttribute('lang', l);
  await expect(page.locator('html')).toHaveAttribute('dir', dir(l));
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const sel of exclude) builder = builder.exclude(sel);
  // legacy mode runs axe in the page itself (`axe.run`, the same rules, frames included when they can answer). The default mode finishes the run in a second blank page, which Chrome refused
  // here once a page had held a script-less sandboxed frame ("Failed to find browser context"), and such a frame cannot answer the frame protocol anyway (it is reported as incomplete, not as a violation)
  builder = builder.setLegacyMode(true);
  const res = await builder.analyze();
  expect(
    res.violations.map(
      (v) =>
        `${v.id}: ${v.nodes
          .slice(0, 2)
          .map((n) => {
            // contrast findings say which colours were measured, which is what is needed to fix them
            const d = n.any[0]?.data as
              { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined;
            const why = (n.any[0]?.message ?? n.all[0]?.message ?? '').slice(0, 160); // what axe measured: the reason is needed to fix it
            return `${n.target.join(' ')}${d?.contrastRatio ? ` [${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}]` : ''}${why ? ` (${why})` : ''}`;
          })
          .join(' | ')}`,
    ),
    `axe violations on ${name} (${l})`,
  ).toEqual([]);
  mkdirSync(join(SHOTS, l), { recursive: true });
  // secrets (even throwaway test ones) never reach a stored screenshot
  await page.screenshot({ path: join(SHOTS, l, `${name}.png`), fullPage: true, mask });
}

/** The organization the person is working in is shown by the header's organization switcher (the old "Current organization: X" line of the dashboard no longer exists). */
export async function expectActiveOrg(page: Page, info: TestInfo, name: string) {
  await expect(page.getByRole('combobox', { name: T(info, 'field.orgSwitcher') })).toContainText(
    name,
  );
}

/**
 * The organization's pages (settings, single sign-on, agency, reseller...) are listed in the account menu, not on the rail: opens it, asserts whether the entry is
 * there, and closes it again.
 */
export async function expectOrgMenuEntry(
  page: Page,
  info: TestInfo,
  key: MessageKey,
  present: boolean,
) {
  const button = page.getByRole('banner').getByRole('button', { name: T(info, 'nc.profile.menu') });
  await button.click();
  const menu = page.getByRole('menu', { name: T(info, 'nc.profile.menu') });
  const entry = menu.getByRole('menuitem', { name: T(info, key), exact: true });
  if (present) await expect(entry).toBeVisible();
  else {
    await expect(menu).toBeVisible();
    await expect(entry).toHaveCount(0);
  }
  if (await menu.isVisible()) await button.click();
}
