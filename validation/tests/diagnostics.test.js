'use strict';
// Runs public/assets/diagnostics.js against a fake Firebase SDK.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const { createDom, plain } = require('./fake-dom');
const source = fs.readFileSync(require.resolve('../public/assets/diagnostics.js'), 'utf8');
const TOKEN = 'APPCHECK-TOKEN-SHOULD-NEVER-SHOW', SITE_KEY = 'SITE-KEY-SHOULD-NEVER-SHOW', UID = 'uidSeller123456';

function fakeFirebase({ signedIn = 'seller', dbHang = false, connected = true, profileRole = 'seller', connectedSync = false } = {}) {
  const calls = [];
  const apps = [];
  const firebase = {
    apps,
    initializeApp(config, name) {
      const app = {
        name,
        auth: () => ({ onAuthStateChanged(cb) { setImmediate(() => cb(name === `secure-${signedIn}` ? { uid: UID } : null)); return () => {}; } }),
        appCheck: () => ({ activate(provider) { calls.push(['activate', provider.key === SITE_KEY]); }, getToken: async () => ({ token: TOKEN }) }),
        functions: region => ({ httpsCallable: fn => async () => { calls.push(['call', fn, region]); return { data: fn === 'profile' ? { role: profileRole } : { companies: { a: {}, b: {} } } }; } }),
        database: () => ({ ref: path => ({
          once: () => dbHang ? new Promise(() => {}) : (path.startsWith('access/') ? Promise.reject(Object.assign(new Error('Permission denied'), { code: 'PERMISSION_DENIED' })) : Promise.resolve({ val: () => 0 })),
          // connectedSync: the real SDK calls back IMMEDIATELY when the value is cached (live E2E v5.13 found this).
          on(_, cb) { if (connected) { if (connectedSync) cb({ val: () => true }); else setImmediate(() => cb({ val: () => true })); } return cb; }, off() {}
        }) })
      };
      apps.push(app); return app;
    },
    appCheck: { ReCaptchaEnterpriseProvider: class { constructor(key) { this.key = key; } } }
  };
  return { firebase, calls };
}

function runDiag(opts = {}, storageValue = '[]') {
  const dom = createDom(['diag-lines', 'diag-summary']);
  const ctx = { window: {}, setTimeout, clearTimeout, Promise, Date, JSON, String, Math, Object, Error, performance };
  vm.runInNewContext(source, ctx);
  const { firebase, calls } = fakeFirebase(opts);
  const storage = { getItem: key => key === 'basma_diag_events' ? storageValue : key === 'basma_diag_trace' ? (opts.trace ?? null) : key === 'basma_geo_diag' ? (opts.geoDiag ?? null) : null };
  return ctx.window.BasmaDiagnostics.run({ firebase, config: { firebase: { projectId: 'p' }, appCheckSiteKey: SITE_KEY, region: 'us-central1' }, document: dom.document, storage, region: 'us-central1', ...(opts.fetch ? { fetch: opts.fetch } : {}) })
    .then(results => ({ results, dom, calls, text: ['diag-lines', 'diag-summary'].map(id => dom.all(dom.byId.get(id)).map(n => `${n.textContent} ${n.value}`).join('\n')).join('\n') }));
}

test('signed-in seller: one line per step, with times, and no token, key or full uid printed', async () => {
  const { results, text, calls } = await runDiag({}, JSON.stringify([{ at: '2026-11-11T13:20:00.000Z', operation: 'renewSubscription', code: 'basma/timeout' }]));
  const P = n => `الشبكة فقط (ملف صغير من الموقع) ${n}/3`, F = (name, n) => `الدالة ${name} — المرة ${n}`;
  assert.deepEqual(plain(results.map(r => r.step)), ['تحميل مكتبات Firebase', 'خدمة العنوان (OpenStreetMap) متاحة؟', 'آخر نتيجة عنوان على هذا الهاتف', P(1), P(2), P(3), 'حالة تسجيل الدخول', 'استعادة تسجيل الدخول (seller)', 'رمز App Check', F('profile', 1), F('profile', 2), 'الدالة listCompanies', F('managerHome', 1), F('managerHome', 2), F('employeeHome', 1), F('employeeHome', 2), 'الملخص', 'قراءة صغيرة من قاعدة البيانات', 'حالة اتصال قاعدة البيانات', 'خطوات فتح الصفحات بعد الدخول', 'آخر أخطاء لوحة المورّد']);
  assert.deepEqual(plain(results.map(r => r.status)), ['OK', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'OK', 'WARN', 'OK', 'SKIP', 'WARN']);
  assert.ok(results.every(r => Number.isInteger(r.ms) && r.ms >= 0));
  assert.match(text, /uidS…/);
  for (const secret of [TOKEN, SITE_KEY, UID]) assert.equal(text.includes(secret), false, secret);
  assert.ok(calls.some(c => c[0] === 'activate' && c[1] === true), 'App Check activated with the configured key');
  assert.deepEqual(plain(calls.filter(c => c[0] === 'call').map(c => c[1])), ['profile', 'profile', 'listCompanies'], 'profile called twice in a row');
  assert.match(text, /renewSubscription: basma\/timeout/);
});

test('not signed in: callables are skipped, App Check and connection still checked', async () => {
  const { results, calls } = await runDiag({ signedIn: 'nobody' });
  const by = Object.fromEntries(results.map(r => [r.step, r.status]));
  assert.equal(by['حالة تسجيل الدخول'], 'WARN');
  assert.equal(by['الدالة profile — المرة 1'], 'SKIP'); assert.equal(by['الدالة profile — المرة 2'], 'SKIP');
  assert.equal(by['الدالة listCompanies'], 'SKIP');
  assert.equal(by['رمز App Check'], 'OK');
  assert.equal(calls.filter(c => c[0] === 'call').length, 0);
});

test('a manager session skips listCompanies (seller only)', async () => {
  const { results } = await runDiag({ signedIn: 'manager', profileRole: 'manager' });
  assert.equal(results.find(r => r.step === 'الدالة listCompanies').status, 'SKIP');
});

test('a database read that never answers is reported as TIMEOUT after 10 seconds, not a hang', async () => {
  const { results } = await runDiag({ dbHang: true });
  const read = results.find(r => r.step === 'قراءة صغيرة من قاعدة البيانات');
  assert.equal(read.status, 'TIMEOUT');
  assert.ok(read.ms >= 9900 && read.ms < 13000, String(read.ms));
});

test('missing Firebase libraries are reported in one clear line', async () => {
  const dom = createDom(['diag-lines', 'diag-summary']);
  const ctx = { window: {}, setTimeout, clearTimeout, Promise, Date, JSON, String, Math, Object, Error, performance };
  vm.runInNewContext(source, ctx);
  const results = await ctx.window.BasmaDiagnostics.run({ firebase: undefined, config: undefined, document: dom.document });
  assert.equal(results.length, 1); assert.equal(results[0].status, 'FAIL');
});

test('manager page step timings recorded after login are listed with their ms (names and times only)', async () => {
  const trace = JSON.stringify([{ at: '2026-11-14T08:00:00.000Z', page: 'manager', step: 'الدالة profile', ms: 812, ok: true, code: '' }, { at: '2026-11-14T08:00:01.000Z', page: 'manager', step: 'الدالة managerHome', ms: 25000, ok: false, code: 'basma/timeout' }]);
  const { results } = await runDiag({ trace });
  const rows = results.filter(r => r.step.startsWith('manager: '));
  assert.deepEqual(plain(rows.map(r => [r.step, r.status, r.ms])), [['manager: الدالة profile', 'OK', 812], ['manager: الدالة managerHome', 'FAIL', 25000]]);
  assert.match(rows[1].detail, /basma\/timeout/);
});

test('database connection step reports OK when the SDK calls back immediately (no "before initialization" error)', async () => {
  const { results } = await runDiag({ connectedSync: true });
  const step = results.find(r => r.step === 'حالة اتصال قاعدة البيانات');
  assert.equal(step?.status, 'OK', JSON.stringify(step));
});

// v6.5 (owner, 26 Nov 2026): network separated from functions.
test('network x3 from our own site, each function twice, sign-in restore, Arabic summary, dated old rows', async () => {
  const urls = [];
  const fetch = async (url, opts) => { urls.push([url, opts?.cache]); return { ok: true, status: 200, text: async () => 'x' }; };
  const trace = JSON.stringify([{ at: '2026-11-20T08:15:30.000Z', page: 'manager', step: 'الدالة managerHome', ms: 6000, ok: true }]);
  const { results, calls, text } = await runDiag({ signedIn: 'manager', profileRole: 'manager', fetch, trace });
  const geo = urls.filter(([u]) => /nominatim/.test(u)); assert.equal(geo.length, 1, 'one address-service check');
  assert.match(geo[0][0], /lat=33\.3333&lon=44\.4167/, 'a FIXED public point, never the user location');
  assert.match(results.find(r => r.step === 'خدمة العنوان (OpenStreetMap) متاحة؟').detail, /^نعم — \d+\.\d ث$/);
  urls.splice(urls.indexOf(geo[0]), 1);
  assert.equal(urls.length, 3); assert.ok(urls.every(([u, c]) => /^\/\.well-known\/assetlinks\.json\?ping=/.test(u) && c === 'no-store'), 'a file the service worker never serves, never cached');
  assert.equal(new Set(urls.map(([u]) => u)).size, 3, 'a unique address each time');
  const by = Object.fromEntries(results.map(r => [r.step, r]));
  for (const n of [1, 2, 3]) assert.equal(by[`الشبكة فقط (ملف صغير من الموقع) ${n}/3`].status, 'OK');
  assert.equal(by['استعادة تسجيل الدخول (manager)'].status, 'OK');
  assert.deepEqual(plain(calls.filter(c => c[0] === 'call').map(c => c[1])), ['profile', 'profile', 'managerHome', 'managerHome'], 'each function twice in a row');
  assert.match(by['الدالة managerHome — المرة 1'].detail, /استيقاظ \+ شبكة/); assert.match(by['الدالة managerHome — المرة 2'].detail, /شبكة فقط/);
  assert.equal(by['الدالة employeeHome — المرة 1'].status, 'SKIP', 'employee account only');
  assert.match(by['الملخص'].detail, /^الشبكة: \d+\.\d ث، الاستيقاظ: \d+\.\d ث$/);
  assert.match(text, /الشبكة: \d+\.\d ث، الاستيقاظ: \d+\.\d ث\./, 'also in the summary line');
  assert.match(by['manager: الدالة managerHome'].detail, /^2026-11-20 08:15:30/, 'old rows show their date');
});

test('the page has the "clear old log" button, and it clears only the old step list', () => {
  const html = fs.readFileSync(require.resolve('../public/manager/diagnostics.html'), 'utf8');
  assert.match(html, /<button type="button" id="diag-clear">امسح السجل القديم<\/button>/);
  assert.match(source, /getElementById\('diag-clear'\)\?\.addEventListener\('click', \(\) => \{ try \{ localStorage\.removeItem\('basma_diag_trace'\); \}/);
});

test('address service blocked: the line says "no" with the time, as a warning (not a failure)', async () => {
  const fetch = async url => { if (/nominatim/.test(url)) throw new TypeError('blocked'); return { ok: true, status: 200, text: async () => 'x' }; };
  const { results } = await runDiag({ signedIn: 'manager', profileRole: 'manager', fetch });
  const row = results.find(r => r.step === 'خدمة العنوان (OpenStreetMap) متاحة؟');
  assert.equal(row.status, 'WARN'); assert.match(row.detail, /^لا — لم تصل خلال \d+\.\d ث/);
});

// v6.10 (owner): the LAST address result of this phone (success / fallback / error + reason + time), never the place.
test('diagnostics: last address result of this phone — fallback with the reason and time, or none yet', async () => {
  const at = new Date(2026, 10, 27, 9, 5).getTime();
  const fb = await runDiag({ geoDiag: JSON.stringify({ result: 'fallback', reason: 'http-503', at }) });
  const line = fb.results.find(r => r.step === 'آخر نتيجة عنوان على هذا الهاتف');
  assert.equal(line.status, 'WARN'); assert.equal(line.detail, 'احتياطي (البعد عن الفرع) — ردّ الخدمة 503 — 2026-11-27 09:05');
  const ok = await runDiag({ geoDiag: JSON.stringify({ result: 'success', reason: 'service', at }) });
  assert.equal(ok.results.find(r => r.step === 'آخر نتيجة عنوان على هذا الهاتف').status, 'OK');
  assert.match(ok.text, /نجاح — من خدمة العنوان — 2026-11-27 09:05/);
  const err = await runDiag({ geoDiag: JSON.stringify({ result: 'fallback', reason: 'network', at }) });
  assert.match(err.text, /الخدمة محجوبة أو لا شبكة/);
  const none = await runDiag({});
  assert.equal(none.results.find(r => r.step === 'آخر نتيجة عنوان على هذا الهاتف').status, 'SKIP');
});
