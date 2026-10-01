// Theme: 'sun' (default) is light by day and dark at night; 'dark' / 'light' pin it.
import { test, expect } from '@playwright/test';
import { boot, seedSession, stubFetchEmpty } from './helper.js';

test.beforeEach(async ({ page }) => { await seedSession(page); await stubFetchEmpty(page); });

test('sunrise in Brooklyn on the June solstice is about 5:25am EDT', async ({ page }) => {
  await boot(page);
  const iso = await page.evaluate(() => sunTimes(new Date('2026-06-21T12:00:00Z'), 40.705, -73.923).sunrise.toISOString());
  const mins = (new Date(iso) - new Date('2026-06-21T09:25:00Z')) / 60000;
  expect(Math.abs(mins)).toBeLessThan(6);
});

test('pinned themes set the class; the pick survives and Sun is the default', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(() => getTheme())).toBe('sun');
  const light = await page.evaluate(() => { localStorage.setItem('break_theme', 'light'); applyTheme(); return document.documentElement.classList.contains('light'); });
  expect(light).toBe(true);
  const dark = await page.evaluate(() => { localStorage.setItem('break_theme', 'dark'); applyTheme(); return document.documentElement.classList.contains('light'); });
  expect(dark).toBe(false);
});

test('Sun mode matches resolveSun()', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('break_geo', JSON.stringify({ lat: 40.705, lng: -73.923 })));
  await boot(page);
  const s = await page.evaluate(() => ({ want: resolveSun().light, got: document.documentElement.classList.contains('light') }));
  expect(s.got).toBe(s.want);
});
