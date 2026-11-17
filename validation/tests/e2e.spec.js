'use strict';
// Browser E2E smoke test (Playwright + Chromium, GitHub Actions only).
//   E2E_MODE=emulator  full logged-in flow against LOCAL Firebase emulators (real server code, real rules, App Check
//                      enforced with a local test token) — no production accounts, data or secrets.
//   E2E_MODE=static    read-only checks of a local copy of a built site (E2E_BASE = local server).
//   E2E_MODE=live      read-only checks of the live site (no login, nothing written).
// Fails on: console errors, CSP violations, failed requests to required hosts, a spinner visible > 15 s, an empty list
// when data exists, a page over its time budget, a broken map tile or marker image.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const MODE = process.env.E2E_MODE || 'live';
const BASE = (process.env.E2E_BASE || 'https://ibrahimmdawoodd100.github.io').replace(/\/$/, '');
const OUT = process.env.E2E_OUT || 'e2e-results';
const FIX = JSON.parse(process.env.E2E_FIXTURE || 'null');
// Budgets (ms). Cold = new browser profile; warm = reload / reopen with the session. Measured baseline: see report.
const BUDGET = { cold: Number(process.env.E2E_COLD_MS) || 6000, warm: Number(process.env.E2E_WARM_MS) || 3000, spinner: 15000 };
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
// Hosts the pages need: a failed request or HTTP error to them fails the run.
const REQUIRED = new RegExp(`^(${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|http://127\\.0\\.0\\.1:(9099|9000|5001)|https://www\\.gstatic\\.com|https://server\\.arcgisonline\\.com)`);
// Console errors that are not page faults: none by default. Add a pattern only with a written reason.
const ALLOWED_CONSOLE = [];
const timings = [], shots = [];
fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true });

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const testAppCheckToken = () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ app_id: '1:0:web:e2e', sub: '1:0:web:e2e', exp: Math.floor(Date.now() / 1000) + 3600 })}.e2e`;

async function guarded(browser, options = {}) {
  const context = await browser.newContext(options), issues = [], open = new Map(), consoleTail = [];
  await context.addInitScript(spinnerMs => {
    window.__e2e = { csp: [], spinners: [] };
    document.addEventListener('securitypolicyviolation', e => window.__e2e.csp.push(`${e.effectiveDirective || e.violatedDirective} ${e.blockedURI}`));
    const seen = new Map();
    setInterval(() => {
      const now = performance.now();
      for (const n of document.querySelectorAll('.spinner-sm,.spinner,.spinner-lg,.lo-spinner')) {
        const overlay = n.closest('.loading-overlay');
        const visible = n.style.display !== 'none' && (overlay ? overlay.classList.contains('active') : n.offsetParent !== null);
        if (!visible) { seen.delete(n); continue; }
        if (!seen.has(n)) seen.set(n, now);
        else if (now - seen.get(n) > spinnerMs && !n.__e2eReported) { n.__e2eReported = true; window.__e2e.spinners.push(n.parentElement?.id || n.closest('[id]')?.id || 'spinner'); }
      }
    }, 500);
  }, BUDGET.spinner);
  if (MODE === 'emulator') {
    await context.addInitScript(() => { self.FIREBASE_APPCHECK_DEBUG_TOKEN = 'e2e-local-debug-token'; });
    await context.route(/firebaseappcheck\.googleapis\.com/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: testAppCheckToken(), ttl: '3600s' }) }));
  }
  context.on('page', page => {
    page.on('request', r => open.set(r, Date.now())); page.on('requestfinished', r => open.delete(r)); page.on('requestfailed', r => open.delete(r));
    page.on('console', m => { consoleTail.push(`${m.type()}: ${m.text().slice(0, 200)}`); if (consoleTail.length > 8) consoleTail.shift(); });
    // The source URL is part of the message: it tells our page apart from Google's frames and names a failed resource.
    page.on('console', m => { if (m.type() === 'error' && !ALLOWED_CONSOLE.some(r => r.test(m.text()))) issues.push(`console error: ${m.text().slice(0, 240)} [from ${(m.location()?.url || '?').slice(0, 140)}]`); });
    page.on('pageerror', e => issues.push(`page error: ${String(e.message).slice(0, 300)}`));
    page.on('requestfailed', r => { const why = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(why) && REQUIRED.test(r.url())) issues.push(`request failed: ${r.url().slice(0, 160)} (${why})`); });
    page.on('response', r => { if (r.status() >= 400 && REQUIRED.test(r.url())) issues.push(`HTTP ${r.status()}: ${r.url().slice(0, 160)}`); });
  });
  // Requests still open after `ms` (a resource that never finishes is a finding, not something to wait on forever).
  const stuck = (ms = 15000) => [...open].filter(([, at]) => Date.now() - at > ms).map(([r]) => r.url().slice(0, 160));
  return {
    context, issues, stuck, consoleTail,
    // Open a page and wait for its ready control; on failure say exactly what was still loading.
    async open(page, url, ready, label) {
      try {
        await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator(ready).waitFor({ state: 'visible', timeout: 60000 });
      } catch (error) {
        throw new Error(`${label}: ${url} — "${ready}" not visible within 60 s (${String(error.message).split('\n')[0]}). Requests still open: ${JSON.stringify(stuck(0))}. Last console: ${JSON.stringify(consoleTail)}`);
      }
    },
    async verify(page, label) {
      const state = await page.evaluate(() => window.__e2e).catch(() => null);
      for (const v of state?.csp || []) issues.push(`CSP violation: ${v}`);
      for (const s of state?.spinners || []) issues.push(`spinner visible > ${BUDGET.spinner / 1000} s in #${s}`);
      // Paths the pages still send to the realtime database directly (traced by core.js as "unrouted").
      const unrouted = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('basma_diag_trace') || '[]').filter(t => t.code === 'unrouted').map(t => t.step); } catch { return []; } }).catch(() => []);
      for (const u of unrouted) issues.push(`direct database access: ${u}`);
      for (const u of stuck(15000)) issues.push(`request still open after 15 s: ${u}`);
      if (state) await page.evaluate(() => { window.__e2e.csp = []; window.__e2e.spinners = []; });
      expect.soft(issues, `${label}: page problems`).toEqual([]);
      issues.length = 0;
    }
  };
}
async function shot(page, name) { const file = path.join(OUT, 'screens', `${MODE}-${name}.png`); await page.screenshot({ path: file, fullPage: false, timeout: 15000 }).catch(() => {}); shots.push(file); }
function timing(name, ms, budget) { timings.push({ mode: MODE, name, ms, budget }); if (budget) expect.soft(ms, `${name} took ${ms} ms (budget ${budget} ms)`).toBeLessThanOrEqual(budget); }
const show = (page, fn, arg) => page.evaluate(([f, a]) => window[f](a), [fn, arg]);

test.afterAll(() => {
  fs.writeFileSync(path.join(OUT, `timings-${MODE}.json`), JSON.stringify(timings, null, 2));
  const lines = [`# E2E timings (${MODE}, ${BASE})`, '', '| step | ms | budget | ok |', '|---|---:|---:|---|', ...timings.map(t => `| ${t.name} | ${t.ms} | ${t.budget || '—'} | ${!t.budget || t.ms <= t.budget ? '✅' : '❌'} |`)];
  fs.writeFileSync(path.join(OUT, `timings-${MODE}.md`), lines.join('\n') + '\n');
});

// ---------------- read-only page checks (live, static, emulator) ----------------
const PAGES = [['seller', '/seller.html', '#seller-email'], ['manager', '/manager/', '#dl-username'], ['employee', '/employee/', '#dl-emp-username'], ['diagnostics', '/manager/diagnostics.html', '#diag-run']];
for (const [name, url, ready] of PAGES) {
  test(`${MODE}: ${name} page opens cleanly within budget`, async ({ browser }) => {
    const g = await guarded(browser), page = await g.context.newPage();
    test.setTimeout(150000);
    let t = Date.now(); await g.open(page, url, ready, `${name} cold open`); timing(`${name}: cold open`, Date.now() - t, BUDGET.cold);
    t = Date.now(); await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); await page.locator(ready).waitFor({ state: 'visible', timeout: 60000 }); timing(`${name}: warm reload`, Date.now() - t, BUDGET.warm);
    await page.waitForTimeout(2000); await shot(page, name); await g.verify(page, name); await g.context.close();
  });
}

test(`${MODE}: branch map — satellite tiles and the marker image load, no broken images`, async ({ browser }) => {
  const g = await guarded(browser), page = await g.context.newPage();
  test.setTimeout(150000);
  await g.open(page, '/manager/', '#dl-username', 'map check');
  // Same tile URL and default marker as the branch location modal; the page's own CSP and Leaflet copy apply.
  const result = await page.evaluate(url => new Promise(resolve => {
    if (!window.L) { resolve({ leaflet: false }); return; }
    const div = document.createElement('div'); div.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:320px;z-index:99999'; document.body.appendChild(div);
    const map = L.map(div).setView([24.7136, 46.6753], 15), layer = L.tileLayer(url, { maxZoom: 19 }).addTo(map); let ok = 0, bad = 0;
    layer.on('tileload', () => ok++); layer.on('tileerror', () => bad++);
    const marker = L.marker([24.7136, 46.6753]).addTo(map);
    setTimeout(() => { const img = marker.getElement(); resolve({ leaflet: true, ok, bad, marker: !!img && img.complete && img.naturalWidth > 0, markerSrc: img?.src || '' }); }, 8000);
  }), ESRI);
  await shot(page, 'map-check');
  expect.soft(result.leaflet, 'Leaflet loaded').toBe(true);
  expect.soft(result.bad, `map tiles that failed (${JSON.stringify(result)})`).toBe(0);
  expect.soft(result.ok, 'map tiles loaded').toBeGreaterThan(0);
  expect.soft(result.marker, `marker image loaded (${result.markerSrc})`).toBe(true);
  await g.verify(page, 'map'); await g.context.close();
});

// ---------------- full logged-in flow (emulator only) ----------------
test.describe('full flow on local emulators', () => {
  test.skip(MODE !== 'emulator', 'logged-in flow runs only against the local emulators (no production accounts)');
  test('seller, manager and employee end to end', async ({ browser }) => {
    const { password, accounts, branch, companyName } = FIX;

    await test.step('seller: login and company list', async () => {
      const g = await guarded(browser), page = await g.context.newPage();
      await g.open(page, '/seller.html', '#seller-email', 'seller login'); await page.fill('#seller-email', accounts.seller); await page.fill('#seller-password', password);
      const t = Date.now(); await page.click('#seller-login');
      // The dashboard counts the companies; the list itself is drawn when the companies page opens (as a user does).
      await expect(page.locator('#ds-active')).toHaveText('1', { timeout: 20000 }); timing('seller: login → dashboard (cold)', Date.now() - t, BUDGET.cold);
      await show(page, 'showPage', 'companies'); await expect(page.locator('#companies-list')).toContainText(companyName, { timeout: 15000 }); await shot(page, 'seller-companies'); await g.verify(page, 'seller'); await g.context.close();
    }, { timeout: 60000 });

    const gm = await guarded(browser), manager = await gm.context.newPage();
    await test.step('manager: login and dashboard', async () => {
      await gm.open(manager, '/manager/', '#dl-username', 'manager login'); await manager.fill('#dl-username', accounts.manager); await manager.fill('#dl-password', password);
      const t = Date.now(); await manager.click('#dl-submit-btn');
      await expect(manager.locator('#dash-tbody')).toContainText('e2e موظف السجلات', { timeout: 20000 }); timing('manager: login → dashboard (cold)', Date.now() - t, BUDGET.cold);
      await shot(manager, 'manager-dashboard'); await gm.verify(manager, 'manager dashboard');
    }, { timeout: 60000 });
    await test.step('manager: employees, branches, attendance, leaves, excuses, payroll lists are filled', async () => {
      const lists = [['emps', '#emp-grid .emp-card', 'employees'], ['warehouses', '#warehouses-list .wh-card-admin', 'branches']];
      for (const [pageName, selector, label] of lists) { const t = Date.now(); await show(manager, 'showPage', pageName); await expect(manager.locator(selector).first(), `${label} list not empty`).toBeVisible({ timeout: 15000 }); timing(`manager: ${label} list (warm)`, Date.now() - t, BUDGET.warm); await shot(manager, `manager-${label}`); }
      await show(manager, 'showPage', 'attend'); await expect(manager.locator('#att-tbody')).toContainText('e2e موظف السجلات'); await shot(manager, 'manager-attendance');
      await show(manager, 'showPage', 'leaves'); await expect(manager.locator('#leaves-list')).toContainText('e2e إجازة'); await shot(manager, 'manager-leaves');
      await show(manager, 'showPage', 'excuses'); await expect(manager.locator('#excuses-list')).toContainText('e2e عذر');
      await show(manager, 'showPage', 'payroll'); await manager.evaluate(() => calculatePayroll()); await expect(manager.locator('#pr-tbody')).toContainText('e2e موظف السجلات'); await shot(manager, 'manager-payroll');
      await gm.verify(manager, 'manager lists');
    }, { timeout: 60000 });
    await test.step('manager: add, rename and delete a branch', async () => {
      await show(manager, 'showPage', 'warehouses'); await expect(manager.locator('#warehouses-list .wh-card-admin').first()).toBeVisible();
      await manager.fill('#new-wh-name', 'e2e فرع مؤقت'); await manager.click('[data-basma-click="addWarehouse()"]');
      const card = manager.locator('#warehouses-list .wh-card-admin', { hasText: 'e2e فرع مؤقت' }); await expect(card).toBeVisible();
      await card.getByRole('button', { name: '✏️' }).click();
      const form = manager.locator('div', { has: manager.locator('h3', { hasText: 'تعديل اسم الفرع' }) }).last();
      await form.locator('input.form-input').fill('e2e فرع معدّل'); await form.getByRole('button', { name: 'موافق' }).click();
      const renamed = manager.locator('#warehouses-list .wh-card-admin', { hasText: 'e2e فرع معدّل' }); await expect(renamed).toBeVisible();
      await renamed.getByRole('button', { name: '🗑' }).click(); await manager.getByRole('button', { name: 'حذف', exact: true }).click();
      await expect(manager.locator('#warehouses-list')).not.toContainText('e2e فرع معدّل'); await gm.verify(manager, 'branch changes');
    }, { timeout: 60000 });
    await test.step('manager: branch location modal shows satellite tiles and the marker', async () => {
      const main = manager.locator('#warehouses-list .wh-card-admin', { hasText: 'e2e الفرع الرئيسي' }); await main.getByRole('button', { name: '📍' }).click();
      await expect(manager.locator('#wh-gz-modal')).toBeVisible(); await manager.waitForTimeout(6000);
      const map = await manager.evaluate(() => { const tiles = [...document.querySelectorAll('#wh-gz-map img.leaflet-tile')]; const marker = document.querySelector('#wh-gz-map img.leaflet-marker-icon');
        return { tiles: tiles.length, loaded: tiles.filter(i => i.complete && i.naturalWidth > 0).length, broken: tiles.filter(i => i.complete && i.naturalWidth === 0).length, marker: !!marker && marker.complete && marker.naturalWidth > 0 }; });
      await shot(manager, 'manager-branch-map');
      expect.soft(map.loaded, `tiles loaded in the modal (${JSON.stringify(map)})`).toBeGreaterThan(0); expect.soft(map.broken, 'broken tiles').toBe(0); expect.soft(map.marker, 'marker image in the modal').toBe(true);
      await manager.evaluate(() => whGzClose()); await gm.verify(manager, 'branch map');
    }, { timeout: 60000 });
    await test.step('manager: add an employee, then delete (disable) it', async () => {
      await show(manager, 'showPage', 'emps'); await manager.evaluate(() => toggleAddEmpPanel());
      await manager.fill('#ae-name', 'e2e موظف مؤقت'); await manager.fill('#ae-empid', 'E2E-9'); await manager.fill('#ae-role', 'مؤقت'); await manager.fill('#ae-salary', '500');
      await manager.selectOption('#ae-wh', 'e2e-w1'); await manager.click('[data-basma-click="addEmployee()"]');
      await manager.getByRole('button', { name: 'تم، حفظتها' }).click({ timeout: 20000 });
      await expect(manager.locator('#page-emps')).toContainText('e2e موظف مؤقت');
      const eid = await manager.evaluate(() => Object.entries(ALL_EMPLOYEES).find(([, e]) => e.name === 'e2e موظف مؤقت')?.[0]); expect(eid).toBeTruthy();
      await manager.evaluate(id => confirmDeleteEmp(id), eid); await manager.click('#confirm-ok');
      await expect(manager.locator('#page-emps')).not.toContainText('e2e موظف مؤقت', { timeout: 20000 }); await gm.verify(manager, 'employee add/delete');
    }, { timeout: 60000 });
    await test.step('manager: session survives closing and reopening the browser', async () => {
      const state = await gm.context.storageState({ indexedDB: true }); await gm.context.close();
      const g2 = await guarded(browser, { storageState: state }), again = await g2.context.newPage();
      const t = Date.now(); await again.goto(BASE + '/manager/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await expect(again.locator('#dash-tbody')).toContainText('e2e موظف السجلات', { timeout: 20000 }); timing('manager: reopen with saved session (warm)', Date.now() - t, BUDGET.warm);
      await expect(again.locator('#dl-username')).toBeHidden(); await shot(again, 'manager-reopened'); await g2.verify(again, 'manager reopen'); await g2.context.close();
    }, { timeout: 60000 });

    // Employee: one browser, five steps of at most 60 s each.
    const ge = await guarded(browser, { permissions: ['geolocation'], geolocation: { latitude: branch.lat, longitude: branch.lng, accuracy: 15 } }), page = await ge.context.newPage();
    const cdp = await ge.context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await test.step('employee: login and fingerprint registration (virtual authenticator)', async () => {
      await ge.open(page, '/employee/', '#dl-emp-username', 'employee login'); await page.fill('#dl-emp-username', accounts.employee); await page.fill('#dl-emp-password', password);
      const t = Date.now(); await page.click('#dl-emp-submit'); await expect(page.locator('#act-bio-btn')).toBeVisible({ timeout: 20000 }); timing('employee: login → activation screen (cold)', Date.now() - t, BUDGET.cold);
      await page.click('#act-bio-btn');
      try { await expect(page.locator('#btn-checkin')).toBeVisible({ timeout: 30000 }); }
      catch (error) {
        const status = await page.locator('#act-bio-status').innerText({ timeout: 2000 }).catch(() => '?');
        const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId }).then(r => r.credentials.length).catch(e => `error ${e.message}`);
        throw new Error(`fingerprint registration did not reach the home screen in 30 s. Page status: "${status}". Credentials on the virtual authenticator: ${creds}. Last console: ${JSON.stringify(ge.consoleTail)}`);
      }
      await shot(page, 'employee-home');
    }, { timeout: 60000 });
    await test.step('employee: notifications, leave and excuse pages', async () => {
      await show(page, 'showTab', 'notifs'); await expect(page.locator('#main-tab-notifs')).toContainText('e2e إشعار للموظف'); await shot(page, 'employee-notifications');
      await show(page, 'showTab', 'leave'); await page.waitForTimeout(1500); await shot(page, 'employee-leave');
      await show(page, 'showTab', 'excuse'); await page.waitForTimeout(1500); await shot(page, 'employee-excuse');
      await ge.verify(page, 'employee pages');
    }, { timeout: 60000 });
    await test.step('employee: fingerprint check-in inside the branch radius', async () => {
      await show(page, 'showTab', 'home'); await expect(page.locator('#btn-checkin')).toBeEnabled({ timeout: 25000 });
      const t = Date.now(); await page.click('#btn-checkin'); await expect(page.locator('#stat-in')).not.toHaveText('—', { timeout: 30000 }); timing('employee: fingerprint check-in', Date.now() - t, BUDGET.cold);
    }, { timeout: 60000 });
    await test.step('employee: fingerprint check-out', async () => {
      await expect(page.locator('#btn-checkout')).toBeEnabled({ timeout: 25000 });
      const t = Date.now(); await page.click('#btn-checkout'); await expect(page.locator('#stat-out')).not.toHaveText('—', { timeout: 30000 }); timing('employee: fingerprint check-out', Date.now() - t, BUDGET.cold);
      await shot(page, 'employee-checked-out');
    }, { timeout: 60000 });
    await test.step('employee: records show check-in and check-out', async () => {
      await show(page, 'showTab', 'hist'); await expect(page.locator('#main-tab-hist')).toContainText('حضور'); await expect(page.locator('#main-tab-hist')).toContainText('انصراف'); await shot(page, 'employee-records');
      await ge.verify(page, 'employee'); await ge.context.close();
    }, { timeout: 60000 });
  });
});
