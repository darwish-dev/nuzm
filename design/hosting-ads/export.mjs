// Renders every ad tile in index.html to a 1080x1350 PNG, in Arabic and English.
// Run from the repo root:  node design/hosting-ads/export.mjs
// Needs Chrome installed (Playwright's bundled Chromium does not run on macOS 13) — same as the e2e suite.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../e2e/package.json'));
const { chromium } = require('@playwright/test');

const ids = [
  '01-hosting',
  '02-grows',
  '03-domain',
  '04-ssl',
  '05-backups',
  '06-runtimes',
  '07-ai-publish',
  '08-isolated',
  '09-compare',
  '10-agencies',
  '11-price',
  '12-start',
];
const out = join(here, 'out');
mkdirSync(join(out, 'ar'), { recursive: true });
mkdirSync(join(out, 'en'), { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 540, height: 675 }, deviceScaleFactor: 2 });
const base = pathToFileURL(join(here, 'index.html')).href;
for (const lang of ['ar', 'en']) {
  for (const id of ids) {
    await page.goto(`${base}?lang=${lang}&tile=${id}`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.tile').screenshot({ path: join(out, lang, `${id}.png`) });
  }
  await page.setViewportSize({ width: 1750, height: 2200 });
  await page.goto(`${base}?lang=${lang}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, `sheet-${lang}.png`), fullPage: true });
  await page.setViewportSize({ width: 540, height: 675 });
}
await browser.close();
console.log('done', out);
