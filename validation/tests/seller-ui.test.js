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
  for (const id of ['nc-admin-username', 'nc-admin-password', 'nc-success', 'panel-content', 'ds-mrr', 'ds-active', 'ds-expired', 'ds-emps', 'dash-alerts', 'dash-companies-mini', 'trans-date', 'seller-notifs-list', 'trans-tbody', 'rev-total', 'rev-month', 'rev-avg', 'trans-company', 'trans-amount', 'trans-note']) { const n = new Node(); n.id = id; byId.set(id, n); }
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
  for (const name of ['lockSeller', 'resetSellerFirebase', 'changeSellerPin', 'createCompany', 'suspendCompany', 'activateCompany', 'resetManagerCredentials', 'doResetManagerCredentials', 'confirmDeleteCompany', 'resetAdminPin', 'refreshLiveEmployeeCounts', 'loadAllCompanies', 'shareWhatsapp', 'loadNotifs', 'loadRevenue', 'addTransaction']) ctx[name] = () => {};
  ctx.copyLink = id => { log.legacyCopy = (log.legacyCopy || []).concat(id); };
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
  await h.click('تم، حفظتها'); await done;
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

test('a new company: real login in the box and on the card (password masked) until «تم، حفظتها», never in URL, storage or console', async () => {
  const h = harness({ calls: { createCompany: async () => ({ companyId: 'c9', username: 'manager_new', password: 'Pw-Secret-987' }) } });
  const done = h.ctx.createCompany(); await settle();
  const [userField, passField] = h.inputs();
  assert.equal(userField.value, 'manager_new'); assert.equal(passField.value, 'Pw-Secret-987');
  assert.equal(passField.type, 'password', 'password masked by default');
  await h.click('👁 إظهار'); assert.equal(passField.type, 'text', 'eye shows it');
  await h.click('🙈 إخفاء'); assert.equal(passField.type, 'password', 'eye hides it again');
  assert.equal(h.byId.get('nc-admin-username').textContent, 'manager_new', 'card shows the real username');
  assert.equal(h.byId.get('nc-admin-password').textContent, '••••••••', 'card masks the password');
  assert.equal(h.byId.get('nc-success').style.display, 'block');
  await h.click('نسخ اسم المستخدم'); await h.click('نسخ كلمة المرور');
  await h.ctx.copyLink('nc-admin-password'); await h.ctx.copyLink('nc-admin-username'); await settle();
  assert.deepEqual(h.log.clipboard, ['manager_new', 'Pw-Secret-987', 'Pw-Secret-987', 'manager_new'], 'box and card copy buttons copy the REAL values');
  await new Promise(r => setTimeout(r, 50)); await settle();
  assert.equal(h.inputs().length, 2, 'never closes by itself');
  await h.click('تم، حفظتها'); await done;
  assert.equal(h.inputs().length, 0, 'the box is gone');
  assert.equal(userField.value, ''); assert.equal(passField.value, '');
  assert.equal(h.byId.get('nc-admin-username').textContent, '—'); assert.equal(h.byId.get('nc-admin-password').textContent, '—');
  const copiesBefore = h.log.clipboard.length; await h.ctx.copyLink('nc-admin-password'); await settle();
  assert.equal(h.log.clipboard.length, copiesBefore, 'after «تم، حفظتها» nothing is left to copy');
  assert.ok(h.log.toasts.some(t => t.type === 'info'));
  h.ctx.lastCreatedData = { nameAr: 'شركة' }; h.ctx.shareWhatsapp();
  const url = decodeURIComponent(h.log.opened[0]);
  assert.equal(url.includes('Pw-Secret-987') || url.includes('manager_new'), false, 'WhatsApp text has no login details');
  const everywhere = JSON.stringify([h.log.storage, h.log.console, h.log.calls.map(c => c.data), h.texts()]);
  assert.equal(everywhere.includes('Pw-Secret-987'), false, 'password nowhere after closing');
});

test('reset manager clears the password from the box when closed and never logs it', async () => {
  const h = harness({ calls: { resetManager: async () => ({ username: 'manager_r', password: 'Reset-Pass-55' }) } });
  const done = h.ctx.resetManagerCredentials('c1'); await settle();
  await h.click('إعادة التعيين'); await settle();
  const fields = h.inputs();
  await h.click('تم، حفظتها'); await done;
  assert.ok(fields.every(f => f.value === ''));
  assert.equal(JSON.stringify([h.log.storage, h.log.console, h.texts()]).includes('Reset-Pass-55'), false);
});

// A snapshot that behaves like Firebase: forEach STOPS when the callback returns a truthy value.
const listText = h => h.all(h.byId.get('seller-notifs-list')).map(n => n.textContent).join('\n');
const plain = v => JSON.parse(JSON.stringify(v));
const fakeSnap = obj => ({ forEach(action) { for (const [key, value] of Object.entries(obj)) if (action({ key, val: () => value })) return true; return false; } });
test('notifications: a failed read shows a clear Arabic error and a retry button, not an endless spinner', async () => {
  const h = harness({ dbTimeoutMs: 30 });
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: () => new Promise(() => {}) }) });
  await h.ctx.pageLoaders.notifs(); await sleep(60); await settle();
  assert.match(listText(h), /تعذر تحميل الإشعارات/);
  assert.match(listText(h), /لم يرد الخادم خلال/);
  assert.ok(!h.all(h.byId.get('seller-notifs-list')).some(n => n.className === 'spinner-sm'), 'spinner removed');
  const retry = h.all(h.byId.get('seller-notifs-list')).find(n => n.tag === 'button' && n.textContent === 'إعادة المحاولة');
  assert.ok(retry, 'retry button shown');
  assert.equal(JSON.parse(h.log.storage.basma_diag_events).at(-1).operation, 'notifications');
  // Retry now succeeds.
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: async () => fakeSnap({}), update: async () => {} }) });
  retry.listeners.click(); await settle();
  assert.match(listText(h), /لا توجد إشعارات/);
});
test('notifications: ALL items are shown (newest first), as text only, and unread ones are marked read', async () => {
  const h = harness(); const updates = [];
  const data = { n1: { type: 'new_company', message: 'أول', read: false, timestamp: '2026-11-10T10:00:00Z' }, n2: { type: 'expiry', message: '<img src=x onerror=alert(1)>', read: true, timestamp: '2026-11-12T10:00:00Z' }, n3: { message: 'ثالث', read: false, timestamp: '2026-11-11T10:00:00Z' } };
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: async () => fakeSnap(data), update: async u => { updates.push(u); } }) });
  await h.ctx.pageLoaders.notifs(); await settle();
  const items = h.byId.get('seller-notifs-list').children;
  assert.equal(items.length, 3, 'all three notifications, not only the first');
  assert.deepEqual(plain(items.map(i => i.children[1].textContent)), ['<img src=x onerror=alert(1)>', 'ثالث', 'أول']);
  assert.deepEqual(plain(items.map(i => i.className)), ['notif-item', 'notif-item unread', 'notif-item unread']);
  assert.deepEqual(plain(updates), [{ 'n1/read': true, 'n3/read': true }]);
});
test('notifications: if marking as read fails, the list stays visible and no error box replaces it', async () => {
  const h = harness();
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: async () => fakeSnap({ n1: { message: 'م', read: false } }), update: async () => { throw Object.assign(Error('denied'), { code: 'PERMISSION_DENIED' }); } }) });
  await h.ctx.pageLoaders.notifs(); await settle();
  assert.equal(h.byId.get('seller-notifs-list').children.length, 1);
  assert.doesNotMatch(listText(h), /تعذر تحميل/);
});

const rows = h => h.byId.get('trans-tbody').children;
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-05`; };
test('revenue: ALL transactions are counted and listed (newest first), as text only', async () => {
  const companies = { a: { id: 'a', status: 'active', info: { nameAr: 'أ' } }, b: { id: 'b', status: 'active', info: { nameAr: 'ب' } } };
  const h = harness({ calls: { listCompanies: async () => ({ companies, cursor: null }) } }); let chart;
  h.ctx.drawRevenueChart = data => { chart = data; };
  const day = thisMonth(), at = Date.parse(day);
  const data = { t1: { companyName: 'أ', amount: 10, dateStr: day, date: at }, t2: { companyName: '<b>x</b>', amount: '20', dateStr: day, date: at + 2000 }, t3: { companyName: 'ج', amount: 30, dateStr: day, date: at + 1000, note: 'n' } };
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: async () => fakeSnap(data) }) });
  await h.ctx.pageLoaders.revenue(); await settle();
  assert.equal(rows(h).length, 3, 'all three transactions, not only the first');
  assert.deepEqual(plain(rows(h).map(r => r.children[0].textContent)), ['<b>x</b>', 'ج', 'أ']);
  assert.equal(h.byId.get('rev-month').textContent, '$60', 'amount stored as text "20" is added as a number');
  assert.equal(h.byId.get('rev-total').textContent, '$60');
  assert.equal(h.byId.get('rev-avg').textContent, '$30');
  assert.equal(Object.values(chart).reduce((s, v) => s + v, 0), 60);
  assert.equal(h.byId.get('trans-company').children.length, 2);
  assert.ok(h.log.hidden >= 1, 'loading closed');
});
test('revenue: a failed read shows a clear Arabic error with retry, closes loading, and retry works', async () => {
  const h = harness({ dbTimeoutMs: 30 }); h.ctx.drawRevenueChart = () => {};
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: () => new Promise(() => {}) }) });
  await h.ctx.pageLoaders.revenue(); await sleep(60); await settle();
  const text = h.all(h.byId.get('trans-tbody')).map(n => n.textContent).join('\n');
  assert.match(text, /تعذر تحميل الإيرادات/); assert.match(text, /لم يرد الخادم خلال/);
  assert.equal(h.byId.get('rev-total').textContent, '—');
  assert.ok(h.log.hidden >= 1, 'loading closed');
  assert.equal(JSON.parse(h.log.storage.basma_diag_events).at(-1).operation, 'revenue');
  const retry = h.all(h.byId.get('trans-tbody')).find(n => n.tag === 'button' && n.textContent === 'إعادة المحاولة');
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ once: async () => fakeSnap({}) }) });
  retry.listeners.click(); await settle();
  assert.equal(rows(h)[0].children[0].children[0].textContent, 'لا توجد معاملات');
  assert.equal(h.byId.get('rev-total').textContent, '$0');
});
test('revenue: adding a transaction saves once and reloads; a failure shows a clear message', async () => {
  const companies = { a: { id: 'a', status: 'active', info: { nameAr: 'أ', plan: 'pro' } } };
  const h = harness({ calls: { listCompanies: async () => ({ companies, cursor: null }) } }); h.ctx.drawRevenueChart = () => {}; const pushed = [];
  h.ctx.allCompanies = companies;
  Object.assign(h.byId.get('trans-company'), { value: 'a' }); Object.assign(h.byId.get('trans-amount'), { value: '15' }); Object.assign(h.byId.get('trans-date'), { value: '2026-11-12' }); Object.assign(h.byId.get('trans-note'), { value: ' ok ' });
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ push: async v => { pushed.push(v); }, once: async () => fakeSnap({}) }) });
  await h.ctx.addTransaction(); await settle();
  assert.equal(pushed.length, 1);
  assert.deepEqual(plain({ ...pushed[0], createdAt: 0 }), { companyId: 'a', companyName: 'أ', plan: 'pro', amount: 15, dateStr: '2026-11-12', date: Date.parse('2026-11-12'), note: 'ok', createdAt: 0 });
  assert.equal(h.byId.get('trans-amount').value, '');
  assert.equal(h.log.toasts.at(-1).msg, 'تم تسجيل المعاملة');
  h.byId.get('trans-amount').value = '0'; await h.ctx.addTransaction();
  assert.equal(pushed.length, 1, 'zero amount is refused without saving');
  h.byId.get('trans-amount').value = '5';
  h.ctx.DB = h.ctx.guardDb({ ref: () => ({ push: async () => { throw Object.assign(Error('denied'), { code: 'PERMISSION_DENIED' }); } }) });
  await h.ctx.addTransaction();
  assert.match(h.log.toasts.at(-1).msg, /^تعذر تسجيل المعاملة/);
});
