'use strict';
// Executes the real public/assets/seller.js against a small DOM fixture. Not a browser test:
// it proves the in-page boxes, time limits and server calls behave as designed.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../public/assets/seller.js'), 'utf8');
const dialogsSource = fs.readFileSync(require.resolve('../public/assets/dialogs.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness({ calls = {}, timeoutMs, dbTimeoutMs, sessionThrows = false } = {}) {
  const byId = new Map();
  class Node {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.value = ''; this.textContent = ''; this.className = ''; this.disabled = false; this.parent = null; }
    set innerHTML(_) { throw Error('seller.js must not write raw HTML'); }
    appendChild(child) { child.parent = this; this.children.push(child); if (child.id) byId.set(child.id, child); return child; }
    append(...children) { children.forEach(c => this.appendChild(c)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    focus() {} select() {} setAttribute() {}
  }
  const body = new Node('body');
  for (const id of ['nc-admin-username', 'nc-admin-password', 'nc-success', 'panel-content', 'ds-mrr', 'ds-active', 'ds-expired', 'ds-emps', 'dash-alerts', 'dash-companies-mini', 'trans-date']) { const n = new Node(); n.id = id; byId.set(id, n); }
  const log = { calls: [], toasts: [], loading: 0, hidden: 0, clipboard: [], storage: {}, console: [], opened: [] };
  const Basma = { call: (name, data) => { log.calls.push({ name, data }); const fn = calls[name]; return fn ? fn(data) : Promise.resolve({ ok: true }); }, db: () => ({}) };
  const storage = { getItem: k => (k in log.storage ? log.storage[k] : null), setItem: (k, v) => { log.storage[k] = String(v); }, removeItem: k => { delete log.storage[k]; } };
  const session = sessionThrows ? { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); }, removeItem: () => { throw Error('blocked'); } } : { getItem: () => null, setItem() {}, removeItem() {} };
  const ctx = {
    window: { BASMA_SELLER_TIMEOUT_MS: timeoutMs, BASMA_SELLER_DB_TIMEOUT_MS: dbTimeoutMs, open: url => { log.opened.push(url); } },
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(k => [k, (...a) => log.console.push(a.map(String).join(' '))])),
    document: { getElementById: id => byId.get(id) || null, createElement: tag => new Node(tag), body, execCommand: () => false },
    navigator: { clipboard: { writeText: async text => { log.clipboard.push(text); } } },
    localStorage: storage, sessionStorage: session, crypto: { randomUUID: () => 'req-1' },
    Basma, setTimeout, clearTimeout, Promise, Date, Math, JSON, Number, String, Object, Error,
    showToast: (msg, type) => log.toasts.push({ msg, type }), showLoading: () => { log.loading++; }, hideLoading: () => { log.hidden++; },
    filterCompanies() {}, initEmojiGrid() {}, selectedEmoji: '🏢', defaultWHs: [], lastCreatedCID: null, lastCreatedData: null,
    allCompanies: {}, DB: null, pageLoaders: { dash: () => 'legacy' },
    openPanel: async () => {}, loadDashboard: async () => 'legacy',
    alert: () => { throw Error('alert() must not be used'); }, confirm: () => { throw Error('confirm() must not be used'); }, prompt: () => { throw Error('prompt() must not be used'); }
  };
  for (const name of ['lockSeller', 'resetSellerFirebase', 'changeSellerPin', 'createCompany', 'suspendCompany', 'activateCompany', 'resetManagerCredentials', 'doResetManagerCredentials', 'confirmDeleteCompany', 'resetAdminPin', 'refreshLiveEmployeeCounts', 'loadAllCompanies', 'shareWhatsapp']) ctx[name] = () => {};
  vm.runInNewContext(dialogsSource, ctx); ctx.BasmaDialogs = ctx.window.BasmaDialogs;
  vm.runInNewContext(source, ctx);
  const all = (node = body, out = []) => { out.push(node); node.children.forEach(c => all(c, out)); return out; };
  const button = label => all().find(n => n.tag === 'button' && n.textContent === label);
  const inputs = () => all().filter(n => n.tag === 'input');
  const click = async label => { const b = button(label); assert.ok(b, `button "${label}" exists`); const r = b.listeners.click(); await settle(); return r; };
  const texts = () => all().map(n => `${n.textContent} ${n.value}`).join("\n");
  return { ctx, log, body, byId, all, button, inputs, click, texts };
}

test('seller.js has no native prompt/alert/confirm dialogs', () => {
  const native = [...source.matchAll(/(?:([\w$]+)\.)?\b(prompt|alert|confirm)\s*\(/g)].filter(m => !['BasmaDialogs', 'dialogs'].includes(m[1]));
  assert.deepEqual(native.map(m => m[0]), []);
});

test('renew opens an in-page box, accepts Arabic digits and calls renewSubscription once', async () => {
  const h = harness({ calls: { renewSubscription: async () => ({ ok: true, expiresAt: Date.UTC(2026, 11, 11) }) } });
  h.ctx.allCompanies = { c1: { id: 'c1', status: 'expired', info: { nameAr: 'شركة', status: 'active' } } };
  await h.ctx.openPanel('c1');
  const renewButton = h.byId.get('panel-content').children.find(n => n.textContent === 'تجديد الاشتراك');
  assert.ok(renewButton, 'renew button added to the panel');
  renewButton.listeners.click(); await settle();
  assert.equal(h.inputs()[0].value, '30');
  h.inputs()[0].value = '٣٠';
  await h.click('موافق'); await settle();
  const renew = h.log.calls.filter(c => c.name === 'renewSubscription');
  assert.equal(renew.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(renew[0].data)), { companyId: 'c1', days: 30, requestId: 'req-1' });
  assert.ok(h.log.toasts.some(t => t.type === 'success' && t.msg.startsWith('جُدد الاشتراك')));
  assert.equal(h.ctx.allCompanies.c1.status, 'active');
  assert.ok(h.log.loading >= 1 && h.log.hidden >= 1, 'a loading indicator was shown and hidden');
  assert.equal(h.inputs().length, 0, 'the box closed');
});

test('renew with a silent server shows a clear timeout message instead of nothing', async () => {
  const h = harness({ timeoutMs: 30, calls: { renewSubscription: () => new Promise(() => {}) } });
  h.ctx.allCompanies = { c1: { id: 'c1', status: 'expired', info: {} } };
  await h.ctx.openPanel('c1');
  const renewButton = h.byId.get('panel-content').children.find(n => n.textContent === 'تجديد الاشتراك');
  renewButton.listeners.click(); await settle();
  await h.click('موافق'); await sleep(80); await settle();
  assert.ok(h.log.toasts.some(t => t.type === 'error' && t.msg.includes('لم يرد الخادم')), JSON.stringify(h.log.toasts));
  assert.equal(renewButton.disabled, false);
  assert.ok(h.log.hidden >= 1);
  const diag = JSON.parse(h.log.storage.basma_diag_events);
  assert.equal(diag.at(-1).operation, 'renewSubscription'); assert.equal(diag.at(-1).code, 'basma/timeout');
  assert.equal(JSON.stringify(diag).includes('req-1'), false, 'the diagnostics log holds no request data');
});

test('renew still works when the browser blocks sessionStorage', async () => {
  const h = harness({ sessionThrows: true, calls: { renewSubscription: async () => ({ ok: true, expiresAt: Date.now() + 86400000 }) } });
  h.ctx.allCompanies = { c1: { id: 'c1', status: 'expired', info: {} } };
  await h.ctx.openPanel('c1');
  h.byId.get('panel-content').children.find(n => n.textContent === 'تجديد الاشتراك').listeners.click(); await settle();
  await h.click('موافق'); await settle();
  assert.equal(h.log.calls.filter(c => c.name === 'renewSubscription').length, 1);
  assert.ok(h.log.toasts.some(t => t.type === 'success'));
});

test('renew rejects an invalid number without calling the server', async () => {
  const h = harness();
  h.ctx.allCompanies = { c1: { id: 'c1', status: 'expired', info: {} } };
  await h.ctx.openPanel('c1');
  h.byId.get('panel-content').children.find(n => n.textContent === 'تجديد الاشتراك').listeners.click(); await settle();
  h.inputs()[0].value = 'abc';
  await h.click('موافق');
  assert.equal(h.log.calls.some(c => c.name === 'renewSubscription'), false);
  assert.ok(h.log.toasts.some(t => t.type === 'error'));
});

test('reset manager uses an in-page confirm and a copy box, never alert()', async () => {
  const h = harness({ calls: { resetManager: async () => ({ username: 'manager_abc', password: 'Secret-123' }) } });
  const done = h.ctx.resetManagerCredentials('c1'); await settle();
  await h.click('إعادة التعيين'); await settle();
  assert.equal(h.log.calls.filter(c => c.name === 'resetManager').length, 1);
  const values = h.inputs().map(i => i.value);
  assert.deepEqual(values, ['manager_abc', 'Secret-123']);
  assert.ok(h.inputs().every(i => i.readOnly));
  await h.click('نسخ كلمة المرور');
  assert.deepEqual(h.log.clipboard, ['Secret-123']);
  await h.click('نسخ الاثنين معًا');
  assert.ok(h.log.clipboard.at(-1).includes('manager_abc') && h.log.clipboard.at(-1).includes('Secret-123'));
  await h.click('حفظتها، أغلق'); await done;
  assert.equal(h.inputs().length, 0);
  assert.equal(JSON.stringify(h.log.storage).includes('Secret-123'), false, 'the password is never stored');
});

test('cancelling reset manager does not call the server', async () => {
  const h = harness();
  const done = h.ctx.resetManagerCredentials('c1'); await settle();
  await h.click('إلغاء'); await done;
  assert.equal(h.log.calls.some(c => c.name === 'resetManager'), false);
});

test('suspend from the delete button asks in-page, then suspends and reports success', async () => {
  const h = harness({ calls: { listCompanies: async () => ({ companies: {}, cursor: null }) } });
  const done = h.ctx.confirmDeleteCompany('c1'); await settle();
  await h.click('تعليق'); await done; await settle();
  const status = h.log.calls.find(c => c.name === 'companyStatus');
  assert.deepEqual(JSON.parse(JSON.stringify(status.data)), { companyId: 'c1', status: 'suspended' });
  assert.ok(h.log.toasts.some(t => t.type === 'success'));
});

test('suspend/activate errors are shown, not silent', async () => {
  const h = harness({ calls: { companyStatus: async () => { throw Object.assign(new Error('الشركة غير موجودة'), { code: 'functions/not-found' }); } } });
  await h.ctx.activateCompany('c1');
  assert.ok(h.log.toasts.some(t => t.type === 'error' && t.msg === 'الشركة غير موجودة (رمز: functions/not-found)'), JSON.stringify(h.log.toasts));
  assert.ok(h.log.hidden >= 1);
});

test('dashboard shows the server list even when the direct database read hangs', async () => {
  const soon = Date.now() + 2 * 86400000;
  const companies = {
    a: { id: 'a', status: 'active', expiresAt: soon, empCount: 3, info: { nameAr: 'أ', maxEmployees: 10 } },
    b: { id: 'b', status: 'expired', expiresAt: 1, empCount: 1, info: { nameAr: 'ب' } },
    c: { id: 'c', status: 'suspended', expiresAt: soon * 2, empCount: 0, info: { nameAr: 'ج' } }
  };
  const h = harness({ dbTimeoutMs: 30, calls: { listCompanies: async () => ({ companies, cursor: null }) } });
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: () => new Promise(() => {}) }) });
  await h.ctx.loadDashboard();
  assert.equal(h.byId.get('ds-active').textContent, '1');
  assert.equal(h.byId.get('ds-expired').textContent, '1');
  assert.equal(h.byId.get('ds-emps').textContent, '4');
  assert.equal(h.byId.get('dash-alerts').children.length, 3);
  assert.equal(h.byId.get('dash-companies-mini').children.length, 3);
  assert.equal(h.byId.get('ds-mrr').textContent, '—');
  assert.ok(h.log.hidden >= 1, 'loading closed');
  assert.equal(await h.ctx.pageLoaders.dash(), undefined, 'the dashboard menu uses the new loader');
});

test('dashboard with an unreachable server closes the loading screen and explains', async () => {
  const h = harness({ timeoutMs: 30, calls: { listCompanies: () => new Promise(() => {}) } });
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: async () => ({ forEach() {} }) }) });
  await h.ctx.loadDashboard();
  assert.ok(h.log.hidden >= 1);
  assert.ok(h.log.toasts.some(t => t.type === 'error' && t.msg.includes('diagnostics')));
});

test('a failed company list keeps the previous list instead of emptying it', async () => {
  const h = harness({ calls: { listCompanies: async () => { throw Object.assign(new Error('x'), { code: 'functions/internal' }); } } });
  h.ctx.allCompanies = { keep: { id: 'keep' } };
  await assert.rejects(h.ctx.loadAllCompanies());
  assert.deepEqual(Object.keys(h.ctx.allCompanies), ['keep']);
});

test('a new company shows the manager login once in the box, never on the page, in the URL, storage or console', async () => {
  const h = harness({ calls: { createCompany: async () => ({ companyId: 'c9', username: 'manager_new', password: 'Pw-Secret-987' }) } });
  const done = h.ctx.createCompany(); await settle();
  assert.deepEqual(h.inputs().map(i => i.value), ['manager_new', 'Pw-Secret-987']);
  for (const id of ['nc-admin-username', 'nc-admin-password']) assert.equal(h.byId.get(id).textContent.includes('Pw-Secret-987') || h.byId.get(id).textContent.includes('manager_new'), false);
  assert.equal(h.byId.get('nc-success').style.display, 'block');
  await h.click('نسخ اسم المستخدم'); assert.deepEqual(h.log.clipboard, ['manager_new']);
  const fields = h.inputs();
  await h.click('حفظتها، أغلق'); await done;
  assert.equal(h.inputs().length, 0, 'the box is gone');
  assert.ok(fields.every(f => f.value === ''), 'the closed box no longer holds the login');
  h.ctx.lastCreatedData = { nameAr: 'شركة' }; h.ctx.shareWhatsapp();
  assert.equal(h.log.opened.length, 1);
  const url = decodeURIComponent(h.log.opened[0]);
  assert.equal(url.includes('Pw-Secret-987') || url.includes('manager_new'), false, 'WhatsApp text has no login details');
  const everywhere = JSON.stringify([h.log.storage, h.log.console, h.log.calls.map(c => c.data), h.texts()]);
  assert.equal(everywhere.includes('Pw-Secret-987'), false);
});

test('reset manager clears the password from the box when closed and never logs it', async () => {
  const h = harness({ calls: { resetManager: async () => ({ username: 'manager_r', password: 'Reset-Pass-55' }) } });
  const done = h.ctx.resetManagerCredentials('c1'); await settle();
  await h.click('إعادة التعيين'); await settle();
  const fields = h.inputs();
  await h.click('حفظتها، أغلق'); await done;
  assert.ok(fields.every(f => f.value === ''));
  assert.equal(JSON.stringify([h.log.storage, h.log.console, h.texts()]).includes('Reset-Pass-55'), false);
});
