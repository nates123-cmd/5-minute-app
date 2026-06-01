// Shared helpers for the 5-Minute Break PWA test suite.
import { SB_AUTH_KEY, API_KEY_KEY } from './constants.js';

// Load the app and wait until the page <script> has finished running. `sm2` is
// the canary — it's a top-level function declaration, so once window.sm2 exists
// the whole script body (incl. the boot() call at the bottom) has executed.
export async function boot(page) {
  // The app registers a service worker that calls reg.update() on load and
  // reloads the page on `controllerchange`. That reload races page.evaluate and
  // surfaces as "Execution context was destroyed". Neutralise SW registration
  // before the app script runs so the page never navigates out from under us.
  // (Additive test-side stub — the shipped SW code is untouched.)
  await page.addInitScript(() => {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = async () => ({
        update: () => {}, addEventListener: () => {}, installing: null,
        waiting: null, active: null, scope: location.href,
      });
    }
  });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.sm2 === 'function');
}

// Seed a non-expired fake auth session + an API key BEFORE the page script runs,
// so boot() takes the hasSession() && getApiKey() -> showScreen('home') branch
// instead of stopping at the OTP gate or the API-key screen. Pairs with a
// stubbed fetch so the fake token is never used on the wire.
export async function seedSession(page) {
  await page.addInitScript(({ authKey, apiKeyKey }) => {
    localStorage.setItem(authKey, JSON.stringify({
      access_token: 'test-fake-token',
      refresh_token: 'test-fake-refresh',
      // far-future expiry (seconds) so _sessionExpired() is false
      expires_at: 4102444800,
      user: { email: 'qa@test.local' },
    }));
    localStorage.setItem(apiKeyKey, 'sk-ant-test-fake-key');
  }, { authKey: SB_AUTH_KEY, apiKeyKey: API_KEY_KEY });
}

// Replace window.fetch with a no-op that returns empty JSON, before the app
// script runs — neutralises all network so boot/render is deterministic and
// quiet (badge updates etc. fire fetches on boot).
export async function stubFetchEmpty(page) {
  await page.addInitScript(() => {
    window.fetch = async () =>
      new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' },
      });
  });
}
