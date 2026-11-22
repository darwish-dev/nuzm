import { expect, test } from '@playwright/test';

test('public services render photo-led features and setup steps', async ({ page }, testInfo) => {
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
    await expect(page.locator('.svc-benefits-layout .svc-card')).toHaveCount(4);
    await expect(page.locator('.svc-process-layout .svc-steps > li')).toHaveCount(3);
    await expect(page.locator('.svc-photo img')).toHaveCount(2);
    await page.locator('.svc-photo img').evaluateAll(async (images) => {
      await Promise.all(images.map((image) => (image as HTMLImageElement).decode()));
    });
  }
  await page.goto(`/${locale}/services/hosting`);
  await page.locator('.svc-benefits-section').scrollIntoViewIfNeeded();
  await testInfo.attach('service-features', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
