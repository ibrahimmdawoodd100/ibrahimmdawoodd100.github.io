'use strict';
// Playwright (Chromium) browser E2E. Runs in GitHub Actions only (no browser in Cloud Shell). One worker, no retries:
// a flaky step is a finding, not something to hide.
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: __dirname, testMatch: /e2e\.spec\.js$/, workers: 1, retries: 0, timeout: 10 * 60 * 1000, expect: { timeout: 15000 },
  outputDir: process.env.E2E_OUT || 'e2e-results', reporter: [['list'], ['json', { outputFile: (process.env.E2E_OUT || 'e2e-results') + '/report.json' }]],
  use: { browserName: 'chromium', headless: true, viewport: { width: 360, height: 780 }, locale: 'ar', serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'retain-on-failure', actionTimeout: 15000, navigationTimeout: 60000 }
});
