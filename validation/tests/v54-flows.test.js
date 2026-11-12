'use strict';
// v5.4 frontend flows: plain-Arabic errors, reset-manager lock, fingerprint retry on 'aborted', single activation.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { createDom, settle, plain } = require('./fake-dom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const forbidden = () => { throw Error('native dialog used'); };
const aborted = () => Object.assign(new Error('توجد عملية أخرى على الحساب؛ أعد المحاولة'), { code: 'functions/aborted' });

function loadDialogs(document) {
  const ctx = { window: {}, document, navigator: { clipboard: { writeText: async () => {} } } };
  vm.runInNewContext(read('public/assets/dialogs.js'), ctx);
  return ctx.window;
}

// ---------------- BasmaErrors ----------------
test('BasmaErrors rewrites the lock message, keeps clear messages and always shows the code', () => {
  const { BasmaErrors: E } = loadDialogs(createDom().document);
  assert.equal(E.message(aborted()), 'الحساب مشغول بعملية أخرى الآن. انتظر لحظات ثم حاول مرة أخرى. (رمز: functions/aborted)');
  assert.equal(E.message(Object.assign(new Error('الشركة غير موجودة'), { code: 'functions/not-found' })), 'الشركة غير موجودة (رمز: functions/not-found)');
  assert.equal(E.describe(Object.assign(new Error('تحدي منتهي أو مستخدم'), { code: 'functions/permission-denied' })).text, 'انتهت مهلة طلب البصمة. اضغط زر البصمة مرة أخرى.');
  assert.equal(E.describe(Object.assign(new Error('ربط حساب غير صالح'), { code: 'functions/failed-precondition' })).text, 'تعذر العثور على حساب مدير هذه الشركة. أبلغ المورّد.');
  assert.equal(E.describe(Object.assign(new Error('INTERNAL'), { code: 'functions/internal' })).text, 'حدث خطأ في الخادم. حاول بعد قليل.');
  const webauthn = Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
  assert.equal(E.message(webauthn), 'أُلغي التحقق أو انتهت مهلته. اضغط زر البصمة مرة أخرى. (رمز: NotAllowedError)');
  assert.equal(E.message(new Error('رسالة محلية واضحة')), 'رسالة محلية واضحة');
  assert.equal(E.message(null, 'بديل'), 'بديل');
});

test('every server lock/aborted variant becomes the same friendly message', () => {
  const { BasmaErrors: E } = loadDialogs(createDom().document);
  for (const message of ['توجد عملية أخرى على الحساب؛ أعد المحاولة', 'تعارض التحقق، أعد المحاولة', 'ABORTED'])
    assert.doesNotMatch(E.describe(Object.assign(new Error(message), { code: 'functions/aborted' })).text, /توجد عملية أخرى|ABORTED/);
});

test('BasmaErrors.render puts the message and the code (small) into a status box', () => {
  const dom = createDom(['status']);
  const { BasmaErrors: E } = loadDialogs(dom.document);
  const node = dom.byId.get('status');
  E.render(node, aborted());
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0].textContent, 'الحساب مشغول بعملية أخرى الآن. انتظر لحظات ثم حاول مرة أخرى.');
  assert.equal(node.children[1].tag, 'small'); assert.equal(node.children[1].textContent, 'functions/aborted');
});

test('no page script shows a raw error.message to users any more', () => {
  for (const file of fs.readdirSync(path.join(__dirname, '../public/assets')).filter(f => f.endsWith('.js'))) {
    const raw = [...read('public/assets/' + file).matchAll(/(showToast\(|banner\(|textContent\s*=\s*)\s*error\.message/g)].map(m => m[0]);
    assert.deepEqual(raw, [], file);
  }
});

// ---------------- core.js: fingerprint retry and single run ----------------
function coreHarness(handlers) {
  const calls = [];
  const auth = { currentUser: { getIdToken: async () => {} }, setPersistence: async () => {}, onAuthStateChanged: fn => { queueMicrotask(fn); return () => {}; }, signOut: async () => {} };
  const app = { auth: () => auth, appCheck: () => ({ activate() {} }), functions: () => ({ httpsCallable: name => async data => { calls.push(name); return { data: await handlers[name](data, calls.filter(c => c === name).length) }; } }) };
  const firebase = { apps: [], initializeApp: () => app, appCheck: { ReCaptchaEnterpriseProvider: class {} }, auth: { Auth: { Persistence: { LOCAL: 'local', SESSION: 'session' } } } };
  const buf = () => new Uint8Array([1, 2, 3]).buffer;
  const credential = { id: 'cred', rawId: buf(), type: 'public-key', getClientExtensionResults: () => ({}), response: { clientDataJSON: buf(), attestationObject: buf(), getTransports: () => ['internal'] } };
  const window = { BASMA_CONFIG: { firebase: {}, appCheckSiteKey: 'k', region: 'r' }, BASMA_RETRY_DELAY_MS: 5, dispatchEvent() {} };
  const navigator = { credentials: { create: async () => credential, get: async () => credential } };
  vm.runInNewContext(read('public/assets/core.js'), { window, firebase, navigator, document: createDom().document, URL, console, atob, btoa, setTimeout, CustomEvent: class { constructor(t) { this.type = t; } } });
  return { Basma: window.Basma, calls };
}
const beginOk = async () => ({ challengeId: 'ch1', options: { challenge: 'AQID', user: { id: 'AQID' } } });

test('activation retries finishWebAuthn on the server lock (aborted) and then succeeds', async () => {
  const h = coreHarness({ beginWebAuthn: beginOk, finishWebAuthn: async (data, n) => { if (n <= 2) throw aborted(); return { credentialId: 'saved', challengeId: data.challengeId }; } });
  await h.Basma.init('employee');
  const result = await h.Basma.biometric('register');
  assert.equal(result.credentialId, 'saved');
  assert.deepEqual(plain(h.calls), ['beginWebAuthn', 'finishWebAuthn', 'finishWebAuthn', 'finishWebAuthn']);
});

test('beginWebAuthn is also retried on aborted, at most 3 times, then the error is raised', async () => {
  const h = coreHarness({ beginWebAuthn: async () => { throw aborted(); }, finishWebAuthn: async () => ({}) });
  await h.Basma.init('employee');
  await assert.rejects(h.Basma.biometric('register'), e => e.code === 'functions/aborted');
  assert.equal(h.calls.filter(c => c === 'beginWebAuthn').length, 4, '1 try + 3 retries');
  assert.equal(h.calls.includes('finishWebAuthn'), false);
});

test('other errors are not retried', async () => {
  const h = coreHarness({ beginWebAuthn: beginOk, finishWebAuthn: async () => { throw Object.assign(new Error('فشل التحقق'), { code: 'functions/permission-denied' }); } });
  await h.Basma.init('employee');
  await assert.rejects(h.Basma.biometric('register'), e => e.code === 'functions/permission-denied');
  assert.equal(h.calls.filter(c => c === 'finishWebAuthn').length, 1);
});

test('a second fingerprint request while one runs never calls begin/finish twice at once', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = coreHarness({ beginWebAuthn: async () => { await gate; return beginOk(); }, finishWebAuthn: async () => ({ credentialId: 'x' }) });
  await h.Basma.init('employee');
  const first = h.Basma.biometric('register');
  await assert.rejects(h.Basma.biometric('register'), e => e.code === 'basma/busy');
  release(); await first;
  assert.deepEqual(plain(h.calls), ['beginWebAuthn', 'finishWebAuthn']);
  await h.Basma.biometric('authenticate'); // allowed again once the first finished
  assert.equal(h.calls.length, 4);
});

// ---------------- employee.js: activation screen ----------------
function employeeHarness({ biometric, homes } = {}) {
  const dom = createDom(['act-bio-status', 'act-bio-btn', 'act-emp-name', 'act-emp-id', 'act-emp-role', 'act-emp-wh']);
  const log = { listeners: 0, offs: 0, screens: [], biometricCalls: 0, homeCalls: 0 };
  const w = loadDialogs(dom.document);
  const ref = () => ({ on: (ev, fn) => { log.listeners++; return fn; }, off: () => { log.offs++; } });
  const ctx = {
    window: w, document: dom.document, console,
    Basma: { db: () => ({ ref }), call: async name => { if (name === 'employeeHome') { log.homeCalls++; return homes ? homes.shift() : { employee: { status: 'pending_activation', name: 'م' } }; } }, controls() {}, logout() {}, banner() {}, profile: { companyId: 'c1', employeeId: 'e1' },
      biometric: async (...a) => { log.biometricCalls++; return biometric(...a); } },
    COMPANY_ID: null, DB: null, ACTIVATION_UID: null, CRED_ID: null,
    secureAttendanceWindows: { seed() {}, sync: async () => {}, evaluate() {} }, showScreen: s => log.screens.push(s), setupMainScreen: async () => log.screens.push('main'),
    showToast() {}, showLoading() {}, hideLoading() {}, alert: forbidden, confirm: forbidden, prompt: forbidden
  };
  for (let i = 0; i < 60; i++) {
    try { vm.runInNewContext(read('public/assets/employee.js'), ctx); break; }
    catch (e) { const m = /^(\w+) is not defined$/.exec(e.message); if (!m) throw e; ctx[m[1]] = () => {}; }
  }
  return { ctx, dom, log };
}

test('activation shows "جارٍ التحقق...", locks the button, and ignores extra taps', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = employeeHarness({ biometric: async () => { await gate; return { credentialId: 'c' }; }, homes: [{ employee: { status: 'approved', credId: 'c' } }] });
  const btn = h.dom.byId.get('act-bio-btn'), status = h.dom.byId.get('act-bio-status');
  const first = h.ctx.activateBio(); h.ctx.activateBio(); h.ctx.activateBio(); await settle();
  assert.equal(status.textContent, 'جارٍ التحقق...');
  assert.equal(btn.style.pointerEvents, 'none');
  assert.equal(h.log.biometricCalls, 1);
  release(); await first;
  assert.equal(btn.style.pointerEvents, '');
  assert.ok(h.log.screens.includes('main'));
});

test('a failed activation shows a plain message with the code in small text, never the raw lock text', async () => {
  const h = employeeHarness({ biometric: async () => { throw aborted(); } });
  await h.ctx.activateBio();
  const status = h.dom.byId.get('act-bio-status');
  assert.equal(status.children[0].textContent, 'الحساب مشغول بعملية أخرى الآن. انتظر لحظات ثم حاول مرة أخرى.');
  assert.equal(status.children[1].textContent, 'functions/aborted');
  assert.equal(h.dom.byId.get('act-bio-btn').style.pointerEvents, '', 'button usable again for a manual retry');
});

test('opening the employee screen twice keeps exactly one company-status listener', async () => {
  const h = employeeHarness({ biometric: async () => ({}) });
  await h.ctx.secureEmployeeOpen({ companyId: 'c1', employeeId: 'e1' });
  await h.ctx.secureEmployeeOpen({ companyId: 'c1', employeeId: 'e1' });
  assert.equal(h.log.listeners - h.log.offs, 1);
});

// ---------------- seller.js: reset manager ----------------
function sellerHarness(calls) {
  const dom = createDom();
  const w = loadDialogs(dom.document);
  const resetButtons = [{ disabled: false }, { disabled: false }];
  dom.document.querySelectorAll = sel => (sel.includes('resetManagerCredentials') ? resetButtons : []);
  const log = { calls: [], toasts: [] };
  const ctx = {
    window: w, document: dom.document, navigator: { clipboard: { writeText: async () => {} } }, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, crypto: { randomUUID: () => 'r' },
    BasmaDialogs: w.BasmaDialogs, Basma: { call: (n, d) => { log.calls.push(n); return calls[n](d); }, db: () => ({}) }, setTimeout, clearTimeout,
    showToast: (m, t) => log.toasts.push({ m, t }), showLoading() {}, hideLoading() {}, filterCompanies() {}, initEmojiGrid() {}, allCompanies: {}, DB: null, pageLoaders: {}, openPanel: async () => {}, loadDashboard: async () => {},
    alert: forbidden, confirm: forbidden, prompt: forbidden
  };
  for (const n of ['lockSeller', 'resetSellerFirebase', 'changeSellerPin', 'createCompany', 'suspendCompany', 'activateCompany', 'resetManagerCredentials', 'doResetManagerCredentials', 'confirmDeleteCompany', 'resetAdminPin', 'refreshLiveEmployeeCounts', 'loadAllCompanies', 'shareWhatsapp']) ctx[n] = () => {};
  vm.runInNewContext(read('public/assets/seller.js'), ctx);
  return { ctx, dom, log, resetButtons };
}

test('reset manager uses the exact plain-Arabic text and shows the new login once', async () => {
  const h = sellerHarness({ resetManager: async () => ({ username: 'manager_u', password: 'New-Pass-9' }) });
  const done = h.ctx.resetManagerCredentials('c1'); await settle();
  assert.ok(h.dom.all().some(n => n.textContent === 'سيتم إنشاء كلمة مرور جديدة للمدير وتسجيل خروجه من أجهزته القديمة. لن تُحذف أي بيانات.'));
  h.dom.button('إعادة التعيين').listeners.click(); await settle();
  assert.deepEqual(h.dom.inputs().map(i => i.value), ['manager_u', 'New-Pass-9']);
  assert.equal(h.dom.button('نسخ كلمة المرور') ? true : false, true);
  h.dom.button('حفظتها، أغلق').listeners.click(); await done;
  assert.equal(h.dom.inputs().length, 0);
});

test('reset manager cannot be pressed twice: buttons disabled and only one server call', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = sellerHarness({ resetManager: async () => { await gate; return { username: 'u', password: 'p' }; } });
  const first = h.ctx.resetManagerCredentials('c1'); await settle();
  h.dom.button('إعادة التعيين').listeners.click(); await settle();
  assert.ok(h.resetButtons.every(b => b.disabled), 'panel buttons locked during the call');
  const second = h.ctx.resetManagerCredentials('c1'); await settle();
  assert.equal(h.dom.button('إعادة التعيين'), undefined, 'no second confirm while the first runs');
  await second;
  release(); await settle();
  assert.equal(h.log.calls.filter(c => c === 'resetManager').length, 1);
  assert.ok(h.resetButtons.every(b => !b.disabled), 'buttons unlocked after the call');
  h.dom.button('حفظتها، أغلق').listeners.click(); await first;
});

test('a failed reset shows the plain message and unlocks the buttons', async () => {
  const h = sellerHarness({ resetManager: async () => { throw Object.assign(new Error('ربط حساب غير صالح'), { code: 'functions/failed-precondition' }); } });
  const done = h.ctx.resetManagerCredentials('c1'); await settle();
  h.dom.button('إعادة التعيين').listeners.click(); await done; await settle();
  assert.ok(h.log.toasts.some(t => t.t === 'error' && t.m === 'تعذر العثور على حساب مدير هذه الشركة. أبلغ المورّد. (رمز: functions/failed-precondition)'), JSON.stringify(h.log.toasts));
  assert.ok(h.resetButtons.every(b => !b.disabled));
});

test('seller panel shows the manager username from listCompanies, or "--" when the server has none', async () => {
  const h = sellerHarness({});
  const mkRow = (labelText, valueText) => { const label = { textContent: labelText }, value = { textContent: valueText }; return { querySelector: sel => (sel === '.info-label' ? label : sel === '.info-value' ? value : null), value }; };
  const userRow = mkRow('اسم المستخدم', '--'), otherRow = mkRow('الحالة', 'نشطة');
  const panel = h.dom.document.createElement('div'); panel.id = 'panel-content'; panel.querySelectorAll = () => [userRow, otherRow]; h.dom.byId.set('panel-content', panel);
  h.ctx.allCompanies = { c1: { id: 'c1', managerUsername: 'manager_abc123', info: {} }, c2: { id: 'c2', info: {} } };
  await h.ctx.openPanel('c1');
  assert.equal(userRow.value.textContent, 'manager_abc123');
  assert.equal(otherRow.value.textContent, 'نشطة', 'other rows untouched');
  await h.ctx.openPanel('c2');
  assert.equal(userRow.value.textContent, '--', 'old backend without the field: still "--", no invented value');
});
