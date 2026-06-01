// Boot smoke tests — guards that the page script runs clean and routes to the
// right first screen based on session / API-key state.
import { test, expect } from '@playwright/test';
import { boot, seedSession, stubFetchEmpty } from './helper.js';

test('title is "Break" and core globals are defined after boot', async ({ page }) => {
  await boot(page);
  await expect(page).toHaveTitle('Break');
  const defined = await page.evaluate(() =>
    ['sm2', 'esc', 'localDateStr', 'regKey', 'renderActivityGrid',
     'getHiddenActivities', 'setHiddenActivities', 'sbFetch', 'srsCreate',
     'syncOfflineQueue', 'showScreen', 'navigateToActivity']
      .every((f) => typeof window[f] === 'function'));
  expect(defined).toBe(true);
});

test('ACTIVITY_REGISTRY and DURATION_ACTIVITIES are present', async ({ page }) => {
  await boot(page);
  // ACTIVITY_REGISTRY / DURATION_ACTIVITIES are top-level `const`s — they are
  // real globals (reachable as bare identifiers inside page.evaluate) but are
  // NOT properties of `window`, so reference them bare, not as window.X.
  const ok = await page.evaluate(() =>
    Array.isArray(ACTIVITY_REGISTRY) &&
    ACTIVITY_REGISTRY.length > 0 &&
    typeof DURATION_ACTIVITIES === 'object');
  expect(ok).toBe(true);
});

test('no session -> OTP gate is the active screen', async ({ page }) => {
  // No seeded session: boot should land on the auth gate, not home.
  await boot(page);
  await expect(page.locator('#screen-otp')).toHaveClass(/active/);
  await expect(page.locator('#screen-home')).not.toHaveClass(/active/);
});

test('session but no API key -> API-key screen', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sb-xsmnfcmtbpeaccnyinkr-auth-token', JSON.stringify({
      access_token: 'test-fake-token', refresh_token: 'r',
      expires_at: 4102444800, user: { email: 'qa@test.local' },
    }));
    // deliberately NO anthropic_api_key
  });
  await stubFetchEmpty(page);
  await boot(page);
  await expect(page.locator('#screen-apikey')).toHaveClass(/active/);
  await expect(page.locator('#screen-home')).not.toHaveClass(/active/);
});

test('valid session + API key -> home is the active screen', async ({ page }) => {
  await seedSession(page);
  await stubFetchEmpty(page); // neutralise the badge-count fetches boot fires
  await boot(page);
  await expect(page.locator('#screen-home')).toHaveClass(/active/);
  await expect(page.locator('#screen-otp')).not.toHaveClass(/active/);
});

test('boot throws no uncaught page errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seedSession(page);
  await stubFetchEmpty(page);
  await boot(page);
  await page.waitForTimeout(300); // let deferred boot work surface
  expect(errors).toEqual([]);
});
