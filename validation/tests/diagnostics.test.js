'use strict';
// Runs public/assets/diagnostics.js against a fake Firebase SDK.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const { createDom, plain } = require('./fake-dom');
const source = fs.readFileSync(require.resolve('../public/assets/diagnostics.js'), 'utf8');
const TOKEN = 'APPCHECK-TOKEN-SHOULD-NEVER-SHOW', SITE_KEY = 'SITE-KEY-SHOULD-NEVER-SHOW', UID = 'uidSeller123456';

function fakeFirebase({ signedIn = 'seller', dbHang = false, connected = true, profileRole = 'seller' } = {}) {
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
          on(_, cb) { if (connected) setImmediate(() => cb({ val: () => true })); return cb; }, off() {}
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
  const storage = { getItem: () => storageValue };
  return ctx.window.BasmaDiagnostics.run({ firebase, config: { firebase: { projectId: 'p' }, appCheckSiteKey: SITE_KEY, region: 'us-central1' }, document: dom.document, storage, region: 'us-central1' })
    .then(results => ({ results, dom, calls, text: ['diag-lines', 'diag-summary'].map(id => dom.all(dom.byId.get(id)).map(n => `${n.textContent} ${n.value}`).join('\n')).join('\n') }));
}

test('signed-in seller: one line per step, with times, and no token, key or full uid printed', async () => {
  const { results, text, calls } = await runDiag({}, JSON.stringify([{ at: '2026-11-11T13:20:00.000Z', operation: 'renewSubscription', code: 'basma/timeout' }]));
  assert.deepEqual(plain(results.map(r => r.step)), ['تحميل مكتبات Firebase', 'حالة تسجيل الدخول', 'رمز App Check', 'الدالة profile', 'الدالة listCompanies', 'قراءة صغيرة من قاعدة البيانات', 'حالة اتصال قاعدة البيانات', 'آخر أخطاء لوحة المورّد']);
  assert.deepEqual(plain(results.map(r => r.status)), ['OK', 'OK', 'OK', 'OK', 'OK', 'WARN', 'OK', 'WARN']);
  assert.ok(results.every(r => Number.isInteger(r.ms) && r.ms >= 0));
  assert.match(text, /uidS…/);
  for (const secret of [TOKEN, SITE_KEY, UID]) assert.equal(text.includes(secret), false, secret);
  assert.ok(calls.some(c => c[0] === 'activate' && c[1] === true), 'App Check activated with the configured key');
  assert.deepEqual(plain(calls.filter(c => c[0] === 'call').map(c => c[1])), ['profile', 'listCompanies']);
  assert.match(text, /renewSubscription: basma\/timeout/);
});

test('not signed in: callables are skipped, App Check and connection still checked', async () => {
  const { results, calls } = await runDiag({ signedIn: 'nobody' });
  const by = Object.fromEntries(results.map(r => [r.step, r.status]));
  assert.equal(by['حالة تسجيل الدخول'], 'WARN');
  assert.equal(by['الدالة profile'], 'SKIP');
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
