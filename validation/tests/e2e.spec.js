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
// Console messages that are NOT faults of our pages. Each entry: exact text, exact SOURCE (URL prefix), mode, reason.
// Anything from our own origin still fails. Every ignored message is counted in the timing report (never hidden).
const ALLOWED_CONSOLE = [
  { text: /^requestStorageAccess: Permission denied\.$/, from: /^https:\/\/www\.google\.com\/recaptcha\/enterprise\/anchor\?/, modes: ['live'],
    reason: "logged inside Google's reCAPTCHA iframe (third-party storage access is denied in headless Chrome); not our code" },
  { text: /^Failed to load resource: the server responded with a status of 403 \(\)$/, from: /^https:\/\/content-firebaseappcheck\.googleapis\.com\/v1\/projects\/signature-7706e\/apps\/[^/]+:exchangeRecaptchaEnterpriseToken/, modes: ['live'],
    reason: 'reCAPTCHA Enterprise refuses an automated headless browser on a GitHub data-centre IP, so App Check gives it no token; real phones get tokens (production calls pass App Check). Logged-in flows are covered by the emulator run' }
];
ALLOWED_CONSOLE.push({ text: /^\[Report Only\] Refused to frame 'https:\/\/www\.google\.com\/' because an ancestor violates the following Content Security Policy directive: "frame-ancestors 'self'"\.\s*$/, from: /^$|^\?$/, modes: ['live', 'emulator'],
  reason: "Chrome reporting Google's OWN report-only header for a www.google.com frame (reCAPTCHA); report-only never blocks, and our pages have no report-only policy" });
const ignored = [];
const allowedConsole = m => { const hit = ALLOWED_CONSOLE.find(a => a.modes.includes(MODE) && a.text.test(m.text()) && a.from.test(m.location()?.url || '')); if (hit) ignored.push(hit.reason); return !!hit; };
const timings = [], shots = [];
fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true });

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const testAppCheckToken = () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ app_id: '1:0:web:e2e', sub: '1:0:web:e2e', exp: Math.floor(Date.now() / 1000) + 3600 })}.e2e`;

async function guarded(browser, options = {}, { realPoll = false } = {}) {
  const context = await browser.newContext(options), issues = [], open = new Map(), consoleTail = [], calls = [];
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
    await context.addInitScript(fast => { self.FIREBASE_APPCHECK_DEBUG_TOKEN = 'e2e-local-debug-token'; if (fast) window.BASMA_VERSION_POLL_MS = 2000; }, !realPoll); // production: 3 min; realPoll = budget tests
    await context.route(/firebaseappcheck\.googleapis\.com/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: testAppCheckToken(), ttl: '3600s' }) }));
  }
  context.on('page', page => {
    // Every server (callable) answer: function name + response bytes, for the cost budgets.
    page.on('response', r => { const m = r.url().match(/:5001\/demo-basma\/us-central1\/([A-Za-z]+)/); if (m && r.request().method() === 'POST') r.body().then(b => calls.push({ name: m[1], bytes: b.length })).catch(() => calls.push({ name: m[1], bytes: 0 })); });
    page.on('request', r => open.set(r, Date.now())); page.on('requestfinished', r => open.delete(r)); page.on('requestfailed', r => open.delete(r));
    page.on('console', m => { consoleTail.push(`${m.type()}: ${m.text().slice(0, 200)}`); if (consoleTail.length > 8) consoleTail.shift(); });
    // The source URL is part of the message: it tells our page apart from Google's frames and names a failed resource.
    page.on('console', m => { if (m.type() === 'error' && !allowedConsole(m)) issues.push(`console error: ${m.text().slice(0, 240)} [from ${(m.location()?.url || '?').slice(0, 140)}]`); });
    page.on('pageerror', e => issues.push(`page error: ${String(e.message).slice(0, 300)}`));
    page.on('requestfailed', r => { const why = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(why) && REQUIRED.test(r.url())) issues.push(`request failed: ${r.url().slice(0, 160)} (${why})`); });
    page.on('response', r => { if (r.status() >= 400 && REQUIRED.test(r.url())) issues.push(`HTTP ${r.status()}: ${r.url().slice(0, 160)}`); });
  });
  // Requests still open after `ms` (a resource that never finishes is a finding, not something to wait on forever).
  const stuck = (ms = 15000) => [...open].filter(([, at]) => Date.now() - at > ms).map(([r]) => r.url().slice(0, 160));
  return {
    context, issues, stuck, consoleTail, calls, resetCalls() { calls.length = 0; },
    // A refusal the test provoked ON PURPOSE and asserted itself: remove exactly those entries (and require they exist).
    expectRefusal(url, status) {
      const mine = issues.filter(i => i.includes(url) && (i.startsWith(`HTTP ${status}:`) || i.includes(`status of ${status}`)));
      expect(mine.length, `the provoked refusal (HTTP ${status} from ${url}) reached the page`).toBeGreaterThan(0);
      for (const i of mine) issues.splice(issues.indexOf(i), 1);
    },
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
  const counts = ignored.reduce((c, r) => ({ ...c, [r]: (c[r] || 0) + 1 }), {});
  if (Object.keys(counts).length) lines.push('', '**Ignored third-party console messages (counted, not hidden):**', '', ...Object.entries(counts).map(([r, n]) => `- ${n} × ${r}`));
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

// ---------------- helpers for the logged-in tests ----------------
// An employee's phone: one browser profile with a virtual platform authenticator and GPS at the branch.
async function employeePhone(browser, flags = {}) {
  const { branch } = FIX;
  const g = await guarded(browser, { permissions: ['geolocation'], geolocation: { latitude: branch.lat, longitude: branch.lng, accuracy: 15 } }, flags), page = await g.context.newPage();
  const cdp = await g.context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { g, page, cdp, authenticatorId };
}
async function employeeLogin({ g, page }, account, ready = '#act-bio-btn') {
  await g.open(page, '/employee/', '#dl-emp-username', `employee login ${account}`);
  await page.fill('#dl-emp-username', account); await page.fill('#dl-emp-password', FIX.password); await page.click('#dl-emp-submit');
  await expect(page.locator(ready)).toBeVisible({ timeout: 20000 });
}
async function managerSession(browser) {
  const g = await guarded(browser), page = await g.context.newPage();
  await g.open(page, '/manager/', '#dl-username', 'manager login'); await page.fill('#dl-username', FIX.accounts.manager); await page.fill('#dl-password', FIX.password); await page.click('#dl-submit-btn');
  await expect(page.locator('#dash-tbody')).toContainText('e2e موظف السجلات', { timeout: 20000 });
  return { g, page };
}
// The manager approves a pending device from the employees page (the real button, the real server call).
async function approveDevice({ page }, employeeName) {
  await show(page, 'showPage', 'emps');
  const row = page.locator('#pending-devices-section .approval-card', { hasText: employeeName });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.getByRole('button', { name: 'اعتماد الجهاز' }).click();
  await expect(page.locator('#pending-devices-section')).not.toContainText(employeeName, { timeout: 15000 });
}
const hhmm = minutes => `${String(Math.floor(((minutes % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String((((minutes % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`;

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
      await expect(page.locator('#ds-active')).toHaveText('333', { timeout: 20000 }); // the e2e company + 332 synthetic cost-budget companies timing('seller: login → dashboard (cold)', Date.now() - t, BUDGET.cold);
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
      await expect(manager.locator('#excuses-list')).toContainText('عذر تأخير'); // v5.17: excuses are for lateness only
      // v5.17 (owner decision 1): the employee window has NO manual attendance editing.
      await show(manager, 'showPage', 'emps'); await show(manager, 'showEmpModal', 'e2e-emp2');
      await expect(manager.locator('#emp-modal')).toHaveClass(/active/, { timeout: 15000 });
      await expect(manager.locator('#emp-modal [data-basma-click^="overrideAttendance"]')).toHaveCount(0);
      await expect(manager.locator('#emp-modal')).not.toContainText('تعديل → حاضر'); await manager.evaluate(() => closeEmpModal());
      await show(manager, 'showPage', 'payroll'); await manager.evaluate(() => calculatePayroll()); await expect(manager.locator('#pr-tbody')).toContainText('e2e موظف السجلات'); await expect(manager.locator('#pr-stats')).toContainText('لا توجد بيانات راتب لـ: e2e موظف الجدول'); await shot(manager, 'manager-payroll');
      await gm.verify(manager, 'manager lists');
    }, { timeout: 60000 });
    await test.step('manager: work location in the special schedule, permanent transfer with its log (v5.18)', async () => {
      await show(manager, 'showPage', 'settings');
      await manager.selectOption('#sched-emp-sel', 'e2e-emp2'); await expect(manager.locator('#sched-form')).toBeVisible();
      await expect(manager.locator('#sched-loc-mode')).toHaveValue('branch'); await expect(manager.locator('#sched-loc-box')).toBeHidden();
      await manager.selectOption('#sched-loc-mode', 'other'); await expect(manager.locator('#sched-loc-box')).toBeVisible();
      await manager.click('#sched-loc-box button'); await expect(manager.locator('#wh-gz-save-btn')).toContainText('اعتماد هذه النقطة');
      await manager.evaluate(() => whGzClose()); await manager.selectOption('#sched-loc-mode', 'branch');
      await show(manager, 'showPage', 'emps'); await show(manager, 'showEmpModal', 'e2e-emp2');
      const modal = manager.locator('#emp-modal'); await expect(modal).toContainText('الفرع الحالي: e2e الفرع الرئيسي', { timeout: 15000 });
      await expect(modal).toContainText('لا توجد تغييرات بعد', { timeout: 15000 });
      await modal.locator('select.form-input').last().selectOption('e2e-w2'); await modal.getByRole('button', { name: 'حفظ النقل' }).click();
      await manager.getByRole('button', { name: 'نقل', exact: true }).click();
      await expect(manager.locator('#emp-modal')).not.toHaveClass(/active/, { timeout: 20000 });
      await show(manager, 'showEmpModal', 'e2e-emp2');
      await expect(modal).toContainText('الفرع الحالي: e2e الفرع الثاني', { timeout: 15000 });
      await expect(modal).toContainText('نقل من «e2e الفرع الرئيسي» إلى «e2e الفرع الثاني»', { timeout: 15000 });
      await manager.evaluate(() => closeEmpModal());
      await show(manager, 'showPage', 'attend'); await expect(manager.locator('#att-tbody')).toContainText('e2e الفرع الرئيسي'); // today's record keeps the old branch
      await gm.verify(manager, 'manager transfer');
    }, { timeout: 90000 });
    await test.step('manager: company records on this device; encrypted backup export (v6.0)', async () => {
      await show(manager, 'showPage', 'settings');
      await expect(manager.locator('#local-data-status')).toContainText('السجلات على هذا الجهاز', { timeout: 20000 });
      await expect(manager.locator('#local-data-status')).not.toContainText('حضور 0 ');
      await manager.click('[data-basma-click="localExport()"]');
      await expect(manager.getByText('إن نسيت كلمة السر فلا يمكن فتح الملف أبدًا')).toBeVisible();
      await manager.getByRole('button', { name: 'متابعة' }).click();
      const pw = manager.locator('input[type="password"]:visible'); await expect(pw).toHaveCount(2); await pw.nth(0).fill('e2e-backup-pass'); await pw.nth(1).fill('e2e-backup-pass'); // the dialog's two fields, not the hidden login field
      const [download] = await Promise.all([manager.waitForEvent('download', { timeout: 30000 }), manager.getByRole('button', { name: 'موافق' }).click()]);
      const file = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      expect(file.format).toBe('basma-backup-v1'); expect(file.count).toBeGreaterThan(0); expect(JSON.stringify(file)).not.toContain('e2e موظف');
      await expect(manager.locator('#local-data-status')).not.toContainText('آخر نسخة احتياطية: —', { timeout: 15000 });
      await gm.verify(manager, 'manager device backup');
    }, { timeout: 90000 });
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
      try { await expect(page.locator('#btn-checkin')).toBeVisible({ timeout: 30000 }); await expect(page.locator('#win-msg')).toContainText('بانتظار اعتماد المدير', { timeout: 15000 }); await expect(page.locator('#btn-checkin')).toBeDisabled(); }
      catch (error) {
        const status = await page.locator('#act-bio-status').innerText({ timeout: 2000 }).catch(() => '?');
        const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId }).then(r => r.credentials.length).catch(e => `error ${e.message}`);
        throw new Error(`fingerprint registration did not reach the home screen in 30 s. Page status: "${status}". Credentials on the virtual authenticator: ${creds}. Last console: ${JSON.stringify(ge.consoleTail)}`);
      }
      await shot(page, 'employee-home');
    }, { timeout: 60000 });
    await test.step('manager: sees the new-device notice and approves; the OPEN employee page enables check-in by itself', async () => {
      const m = await managerSession(browser);
      await show(m.page, 'showPage', 'admin-notifs'); await expect(m.page.locator('#admin-notif-list')).toContainText('بانتظار اعتمادك', { timeout: 15000 });
      await approveDevice(m, 'e2e موظف البصمة'); await shot(m.page, 'manager-device-approved'); await m.g.verify(m.page, 'manager device approval'); await m.g.context.close();
      const t = Date.now(); await expect(page.locator('#btn-checkin')).toBeEnabled({ timeout: 20000 }); timing('employee page updated after manager approval (no reload)', Date.now() - t);
    }, { timeout: 60000 });
    await test.step('employee: notifications, leave and excuse pages', async () => {
      await show(page, 'showTab', 'notifs'); await expect(page.locator('#main-tab-notifs')).toContainText('e2e إشعار للموظف'); await shot(page, 'employee-notifications');
      await show(page, 'showTab', 'leave'); await page.waitForTimeout(1500); await shot(page, 'employee-leave');
      await show(page, 'showTab', 'excuse'); await page.waitForTimeout(1500); await shot(page, 'employee-excuse');
      // v5.17: one excuse type only (lateness); timed leave is also from tomorrow at the earliest.
      await expect(page.locator('input[name="excuse-type"]')).toHaveCount(1); await expect(page.locator('input[name="excuse-type"]')).toHaveValue('late');
      await show(page, 'showTab', 'leave'); await page.waitForTimeout(800);
      const minDates = await page.evaluate(() => { const type = document.getElementById('leave-type'), date = document.getElementById('leave-date'); if (!type || !date) return null; type.value = 'partial'; togglePartialFields(); const partial = date.min; type.value = 'paid'; togglePartialFields(); return [partial, date.min]; });
      if (minDates) { expect(minDates[0]).toBe(minDates[1]); expect(minDates[0] > await page.evaluate(() => secureEmployeeDate())).toBe(true); }
      await ge.verify(page, 'employee pages');
    }, { timeout: 60000 });
    await test.step('employee: fingerprint check-in inside the branch radius', async () => {
      await show(page, 'showTab', 'home'); await expect(page.locator('#btn-checkin')).toBeEnabled({ timeout: 25000 });
      const t = Date.now(); await page.click('#btn-checkin'); await expect(page.locator('#stat-in')).not.toHaveText('—', { timeout: 30000 }); timing('employee: fingerprint check-in', Date.now() - t, BUDGET.cold);
    }, { timeout: 60000 });
    await test.step('employee: check-out waits 10 minutes after check-in (v5.19)', async () => {
      await expect(page.locator('#win-msg')).toContainText('يمكنك الانصراف بعد', { timeout: 15000 });
      await expect(page.locator('#btn-checkout')).toBeDisabled();
      // Test clock: move THIS check-in 11 minutes back in the LOCAL emulator database (same admin access as the seed).
      const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
      let moved = false;
      for (const ns of ['demo-basma-default-rtdb', 'demo-basma']) {
        const days = await (await fetch(`http://${host}/attendanceLedger/e2e-co/e2e-emp1.json?ns=${ns}`, { headers: { Authorization: 'Bearer owner' } })).json();
        for (const [date, day] of Object.entries(days || {})) if (day?.events?.in?.timestamp) {
          const earlier = new Date(Date.parse(day.events.in.timestamp) - 11 * 60000).toISOString();
          const r = await fetch(`http://${host}/attendanceLedger/e2e-co/e2e-emp1/${date}/events/in.json?ns=${ns}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify({ timestamp: earlier }) });
          expect(r.ok).toBe(true); moved = true;
        }
      }
      expect(moved, 'the check-in was found in the local emulator').toBe(true);
      await page.waitForTimeout(2500); await page.reload(); await show(page, 'showTab', 'home');
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

test.describe('account switch and open-app updates (local emulators)', () => {
  test.skip(MODE !== 'emulator', 'logged-in tests run only against the local emulators');

  test('account switch on one phone: B cannot use A\'s fingerprint, and B\'s new device is refused until the manager approves', async ({ browser }) => {
    const phone = await employeePhone(browser), { page, cdp, authenticatorId, g } = phone, { accounts } = FIX;
    const m = await managerSession(browser);
    await test.step('A registers on this phone, the manager approves, A checks in', async () => {
      await employeeLogin(phone, accounts.employeeA); await expect(page.locator('#act-emp-name')).toHaveText('e2e موظف أ');
      await page.click('#act-bio-btn'); await expect(page.locator('#win-msg')).toContainText('بانتظار اعتماد المدير', { timeout: 30000 }); await expect(page.locator('#btn-checkin')).toBeDisabled();
      await approveDevice(m, 'e2e موظف أ');
      await expect(page.locator('#btn-checkin')).toBeEnabled({ timeout: 20000 });
      await page.click('#btn-checkin'); await expect(page.locator('#stat-in')).not.toHaveText('—', { timeout: 30000 }); await shot(page, 'switch-A-checked-in');
    }, { timeout: 60000 });
    await test.step('A logs out: no session and none of A\'s data stays in the browser', async () => {
      await page.evaluate(() => Basma.logout()); await page.locator('#dl-emp-username').waitFor({ state: 'visible', timeout: 30000 });
      const left = await page.evaluate(async () => {
        const storage = [localStorage, sessionStorage].flatMap(s => Object.keys(s).map(k => [k, s.getItem(k)])).filter(([k, v]) => /^basma_/.test(k) && /e2e-employee3|e2e-emp3|e2e موظف أ/.test(v || ''));
        const users = await new Promise(resolve => { const r = indexedDB.open('firebaseLocalStorageDb'); r.onerror = () => resolve(-1); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('firebaseLocalStorage')) { resolve(0); return; } const q = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll(); q.onsuccess = () => resolve(q.result.filter(x => /authUser/.test(x.fbase_key || '')).length); q.onerror = () => resolve(-1); }; });
        return { storage, users, signedIn: Basma.signedIn };
      });
      expect(left).toEqual({ storage: [], users: 0, signedIn: false });
    }, { timeout: 60000 });
    await test.step('B logs in on the same phone: B\'s own activation; B\'s new device is pending; the SERVER refuses B\'s check-in', async () => {
      await employeeLogin(phone, accounts.employeeB); await expect(page.locator('#act-emp-name')).toHaveText('e2e موظف ب');
      await page.click('#act-bio-btn'); await expect(page.locator('#win-msg')).toContainText('بانتظار اعتماد المدير', { timeout: 30000 }); await expect(page.locator('#btn-checkin')).toBeDisabled();
      // The UI blocks it; call the real check-in path anyway (fingerprint + server) to prove the server refuses.
      const answer = await page.evaluate(async () => { try { await Basma.attendance('in', GPS_DATA); return 'ACCEPTED'; } catch (e) { return `${e.code} ${e.message}`; } });
      expect(answer).toMatch(/failed-precondition.*بانتظار اعتماد المدير/);
      g.expectRefusal('/finishWebAuthn', 400); // the refusal we just asserted; any OTHER problem still fails
      const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      expect(creds.credentials.length, 'A\'s and B\'s fingerprints are both on this phone; only B\'s own is accepted for B').toBe(2);
      await shot(page, 'switch-B-pending');
    }, { timeout: 60000 });
    await test.step('manager: A\'s check-in is recorded, nothing for B', async () => {
      await show(m.page, 'showPage', 'attend'); await expect(m.page.locator('#att-tbody')).toContainText('e2e موظف أ', { timeout: 15000 });
      const rows = await m.page.locator('#att-tbody tr', { hasText: 'e2e موظف ب' }).allInnerTexts();
      expect(rows.join(' '), 'B has no check-in time').not.toMatch(/\d{1,2}:\d{2}/);
    }, { timeout: 60000 });
    await g.verify(page, 'account switch'); await m.g.verify(m.page, 'account switch manager'); await g.context.close(); await m.g.context.close();
  });

  test('open employee app updates by itself: a manager schedule change arrives, and the window boundary flips the button (mocked clock, no reload)', async ({ browser }) => {
    const phone = await employeePhone(browser), { page, g } = phone, { accounts } = FIX;
    await page.clock.install(); // fake timers; time keeps flowing until fastForward
    await employeeLogin(phone, accounts.employeeC, '#btn-checkin');
    await expect(page.locator('#btn-checkin')).toBeEnabled({ timeout: 25000 });
    const m = await managerSession(browser);
    const now = Math.floor(Date.now() / 60000), from = hhmm(now - 20), to = hhmm(now + 3);
    await test.step('the manager changes C\'s schedule; the open page shows it within seconds', async () => {
      await m.page.evaluate(({ from, to }) => DB.ref(`companies/${COMPANY_ID}/employees/e2e-emp5/schedule`).set({ checkIn: { from, to }, checkOut: { from: to, to: '23:59' } }), { from, to }); // v5.19: check-out starts when check-in ends
      const t = Date.now(); await expect(page.locator('#tw-in-range')).toHaveText(`${from} — ${to}`, { timeout: 20000 }); timing('open employee page shows a manager schedule change', Date.now() - t);
      await expect(page.locator('#tw-in-status')).toContainText('مفتوح'); await expect(page.locator('#btn-checkin')).toBeEnabled();
    }, { timeout: 60000 });
    await test.step('time passes the end of the check-in window: the button disables by itself', async () => {
      await page.clock.fastForward('05:00');
      await expect(page.locator('#tw-in-status')).toContainText('يبدأ بعد', { timeout: 10000 }); await expect(page.locator('#btn-checkin')).toBeDisabled();
      await shot(page, 'window-closed-by-itself');
    }, { timeout: 60000 });
    await g.verify(page, 'open-app updates'); await m.g.verify(m.page, 'open-app manager'); await g.context.close(); await m.g.context.close();
  });
});

// ---------------- cost budgets (CI guard, v5.16) ----------------
// Calls and response bytes per page open and while idle, on 10,000-employee data (333 companies x 30). The server's own
// database reads are not visible to the browser; response bytes are the measured stand-in.
const BUDGET_COST = {
  // v6.0 (owner decision 24 Nov 2026): the manager's phone keeps the records and pulls new ones on every open. The FIRST
  // open on a phone pulls the whole 45-day mailbox once (here ~2,250 signed records: was 2 calls / 120 KB); every later
  // open is checked separately and must stay at 1 call / 60 KB. Reports and closed months then read the phone copy.
  employeeOpen: { calls: 4, kb: 8 }, employeeIdle30min: { calls: 15 }, managerOpen: { calls: 4, kb: 1000 }, managerLaterOpenSync: { calls: 1, kb: 60 }, managerIdle30min: { calls: 15 },
  dayView: { calls: 1, kb: 60 }, monthPayroll: { calls: 2, kb: 900 }, closedMonthFirst: { calls: 3, kb: 1200 }, closedMonthRepeat: { calls: 2, kb: 12 }
};
function costCheck(label, calls, budget) {
  const n = calls.length, kb = Math.round(calls.reduce((t, c) => t + c.bytes, 0) / 102.4) / 10;
  timings.push({ mode: MODE, name: `COST ${label}: ${n} calls, ${kb} KB [${[...new Set(calls.map(c => c.name))].join(', ')}]`, ms: n, budget: budget.calls });
  expect.soft(n, `${label}: ${n} calls (budget ${budget.calls}): ${calls.map(c => c.name).join(', ')}`).toBeLessThanOrEqual(budget.calls);
  if (budget.kb) expect.soft(kb, `${label}: ${kb} KB (budget ${budget.kb} KB)`).toBeLessThanOrEqual(budget.kb);
}
const settleCalls = page => page.waitForTimeout(2500);
test.describe('cost budgets (local emulators, 10,000 employees)', () => {
  test.skip(MODE !== 'emulator', 'cost budgets run against the local emulators');
  test('employee and manager: calls and bytes per open, idle pages, day/month/payroll, closed-month cache', async ({ browser }) => {
    const { accounts } = FIX;
    await test.step('employee: open, then 30 idle minutes (mocked clock)', async () => {
      const phone = await employeePhone(browser, { realPoll: true }); await phone.page.clock.install();
      await employeeLogin(phone, accounts.employeeC, '#btn-checkin'); await settleCalls(phone.page);
      costCheck('employee open', phone.g.calls, BUDGET_COST.employeeOpen);
      phone.g.resetCalls(); await phone.page.clock.runFor(30 * 60000); await settleCalls(phone.page);
      costCheck('employee idle 30 min', phone.g.calls, BUDGET_COST.employeeIdle30min);
      await phone.g.context.close();
    }, { timeout: 60000 });
    const g = await guarded(browser, {}, { realPoll: true }), page = await g.context.newPage();
    await test.step('manager: open the dashboard, then 30 idle minutes (mocked clock)', async () => {
      await page.clock.install();
      await g.open(page, '/manager/', '#dl-username', 'manager login'); await page.fill('#dl-username', accounts.manager); await page.fill('#dl-password', FIX.password);
      g.resetCalls(); await page.click('#dl-submit-btn'); await expect(page.locator('#dash-tbody')).toContainText('e2e حجم 3', { timeout: 20000 }); await settleCalls(page);
      costCheck('manager open', g.calls, BUDGET_COST.managerOpen);
      g.resetCalls(); await page.clock.runFor(30 * 60000); await settleCalls(page);
      costCheck('manager idle 30 min', g.calls, BUDGET_COST.managerIdle30min);
      g.resetCalls(); await page.evaluate(() => localData.open(true)); await settleCalls(page);
      costCheck('manager later open: device sync', g.calls, BUDGET_COST.managerLaterOpenSync);
    }, { timeout: 60000 });
    await test.step('manager: day view, this month\'s payroll, a closed month twice (second time from the phone cache)', async () => {
      g.resetCalls(); await show(page, 'showPage', 'attend'); await expect(page.locator('#att-tbody')).toContainText('e2e حجم 3', { timeout: 15000 }); await settleCalls(page);
      costCheck('day view', g.calls, BUDGET_COST.dayView);
      await show(page, 'showPage', 'payroll');
      g.resetCalls(); await page.evaluate(() => calculatePayroll()); await expect(page.locator('#pr-tbody')).toContainText('e2e حجم 3', { timeout: 20000 }); await settleCalls(page);
      costCheck('payroll this month', g.calls, BUDGET_COST.monthPayroll);
      const previous = await page.evaluate(() => { const d = new Date(Date.now() - 28 * 864e5); return d.toISOString().slice(0, 7) === new Date().toISOString().slice(0, 7) ? new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 7) : d.toISOString().slice(0, 7); });
      await page.fill('#pr-month', previous);
      g.resetCalls(); await page.evaluate(() => calculatePayroll()); await expect(page.locator('#pr-tbody')).toContainText('e2e حجم 3', { timeout: 20000 }); await settleCalls(page);
      costCheck('closed month, first time', g.calls, BUDGET_COST.closedMonthFirst);
      g.resetCalls(); await page.evaluate(() => calculatePayroll()); await expect(page.locator('#pr-tbody')).toContainText('e2e حجم 3', { timeout: 20000 }); await settleCalls(page);
      costCheck('closed month, again (phone cache)', g.calls, BUDGET_COST.closedMonthRepeat);
      expect(g.calls.some(c => c.name === 'managerRecords'), 'a closed month is not downloaded again').toBe(false);
    }, { timeout: 60000 });
    await g.verify(page, 'cost budgets'); await g.context.close();
  });
});
