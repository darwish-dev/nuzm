import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { dir, t, type Locale, type MessageKey } from '@nuzm/i18n';

export const loc = (info: TestInfo) => info.project.name as Locale;
export const T = (info: TestInfo, key: MessageKey, params?: Record<string, string | number>) =>
  t(loc(info), key, params);

const SHOTS = join(__dirname, '..', '..', 'docs', 'reports', 'screenshots');

/** Sign in through the dev IdP user picker. `base` selects the console (customer :3000 / admin :3001). */
export async function signIn(
  page: Page,
  info: TestInfo,
  email: string,
  base = 'http://127.0.0.1:3000',
) {
  await page.goto(`${base}/${loc(info)}/login`);
  await page.getByRole('link', { name: T(info, 'action.signin') }).click();
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
export async function audit(page: Page, info: TestInfo, name: string, mask: Locator[] = []) {
  const l = loc(info);
  await expect(page.locator('html')).toHaveAttribute('lang', l);
  await expect(page.locator('html')).toHaveAttribute('dir', dir(l));
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    res.violations.map(
      (v) =>
        `${v.id}: ${v.nodes
          .slice(0, 2)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    ),
    `axe violations on ${name} (${l})`,
  ).toEqual([]);
  mkdirSync(join(SHOTS, l), { recursive: true });
  // secrets (even throwaway test ones) never reach a stored screenshot
  await page.screenshot({ path: join(SHOTS, l, `${name}.png`), fullPage: true, mask });
}
