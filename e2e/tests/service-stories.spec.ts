import { expect, test } from '@playwright/test';

test('public services render the feature tiles, the setup steps and the hero illustration', async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name === 'ar' ? 'ar' : 'en';
  for (const slug of [
    'hosting',
    'cloud',
    'vps',
    'domains',
    'ai-builder',
    'email',
    'data',
    'automation',
  ]) {
    const response = await page.goto(`/${locale}/services/${slug}`);
    expect(response?.status(), slug).toBe(200);
    // the service pages use the illustrated design (ServiceDetail): four feature tiles, a three-step timeline and the framed hero illustration (the earlier photo-led layout is gone)
    await expect(page.locator('.svx-bento .svx-tile')).toHaveCount(4);
    await expect(page.locator('.svx-timeline > li')).toHaveCount(3);
    await expect(page.locator('.svx-hero .svx-frame')).toHaveCount(1);
  }
  await page.goto(`/${locale}/services/hosting`);
  await page.locator('.svx-bento').scrollIntoViewIfNeeded();
  await testInfo.attach('service-features', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
