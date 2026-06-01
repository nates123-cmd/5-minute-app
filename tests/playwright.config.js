// Playwright config for the 5-Minute Break PWA. Serves the single-file app from
// the parent dir on :8211 so fetch/origin/localStorage behave like production.
// No app build step.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The dev static server (python http.server) is single-threaded; too many
  // concurrent page loads can starve it. Cap workers for deterministic runs.
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8211',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Serve the app root (parent of tests/) so index.html is at "/".
    command: 'python3 -m http.server 8211 --directory ..',
    port: 8211,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
