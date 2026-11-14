'use strict';
// Real public/assets/core.js and manager-views.js against small fakes (no browser):
// the database watchdog switches to long polling, and the dashboard never spins forever.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const read = f => fs.readFileSync(require.resolve('../public/assets/' + f), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));

function coreHarness({ connects = 'never' } = {}) {
  const timers = [], log = { polling: 0, offline: 0, online: 0 }, store = {}, session = {};
  let listeners = [];
  const database = {
    ref: path => ({ on: (type, fn) => { listeners.push({ path, fn }); if (connects === 'websocket') queueMicrotask(() => fn({ val: () => true })); return fn; }, off: (type, fn) => { listeners = listeners.filter(l => l.fn !== fn); } }),
    goOffline() { log.offline++; }, goOnline() { log.online++; if (connects === 'polling') for (const l of listeners.filter(l => l.path === '.info/connected')) queueMicrotask(() => l.fn({ val: () => true })); },
    INTERNAL: { forceLongPolling() { log.polling++; } }
  };
  const auth = { currentUser: { getIdToken: async () => 't' }, setPersistence: async () => {}, onAuthStateChanged: fn => { queueMicrotask(fn); return () => {}; } };
  const app = { name: 'secure-manager', auth: () => auth, database: () => database, appCheck: () => ({ activate() {} }),
    functions: () => ({ httpsCallable: name => async () => ({ data: name === 'profile' ? { role: 'manager', companyId: 'c1', serverTime: Date.now() } : {} }) }) };
  const firebase = { apps: [], initializeApp: () => app, appCheck: { ReCaptchaEnterpriseProvider: class {} }, auth: { Auth: { Persistence: { SESSION: 's', LOCAL: 'l' } } } };
  const storage = obj => ({ getItem: k => (k in obj ? obj[k] : null), setItem: (k, v) => { obj[k] = String(v); }, removeItem: k => { delete obj[k]; } });
  const ctx = { firebase, console, Promise, Date, JSON, Math, Object, Error, String, Number, Uint8Array, queueMicrotask, performance: { now: () => 0 },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, localStorage: storage(store), sessionStorage: storage(session),
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), body: { appendChild() {} } }, location: {}, CustomEvent: class {} };
  ctx.window = ctx; ctx.BASMA_CONFIG = { firebase: {}, appCheckSiteKey: 'k', region: 'us-central1' };
  vm.runInNewContext(read('core.js'), ctx);
  return { ctx, log, timers, store, session };
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('database watchdog: a stalled WebSocket switches this tab to long polling and reconnects', async () => {
  const h = coreHarness({ connects: 'polling' });
  await h.ctx.Basma.session('manager'); h.ctx.Basma.db(); await tick();
  const watchdog = h.timers.find(t => t.ms === 5000); assert.ok(watchdog, '5 s watchdog armed');
  assert.equal(h.log.polling, 0, 'WebSocket is tried first');
  watchdog.fn(); await tick();
  assert.deepEqual(plain(h.log), { polling: 1, offline: 1, online: 1 });
  assert.equal(h.session.basma_db_long_polling, '1', 'remembered for this tab');
  assert.equal(h.ctx.Basma.connection.state, 'connected'); assert.equal(h.ctx.Basma.connection.transport, 'long-polling');
  const steps = JSON.parse(h.store.basma_diag_trace).map(t => [t.step, t.ok, t.code]);
  assert.ok(steps.some(([s, ok, c]) => /websocket/.test(s) && !ok && c === 'db/connect-timeout'));
  assert.ok(steps.some(([s, ok]) => /long-polling/.test(s) && ok));
  assert.ok(steps.some(([s]) => s === 'الدالة profile'));
});
test('database watchdog: a working WebSocket is left alone', async () => {
  const h = coreHarness({ connects: 'websocket' });
  await h.ctx.Basma.session('manager'); h.ctx.Basma.db(); await tick();
  h.timers.find(t => t.ms === 5000).fn(); await tick();
  assert.deepEqual(plain(h.log), { polling: 0, offline: 0, online: 0 });
  assert.equal(h.ctx.Basma.connection.transport, 'websocket');
});
test('database watchdog: a tab that needed long polling starts with it next time', async () => {
  const h = coreHarness({ connects: 'websocket' }); h.session.basma_db_long_polling = '1';
  await h.ctx.Basma.session('manager'); h.ctx.Basma.db(); await tick();
  assert.equal(h.log.polling, 1); assert.equal(h.ctx.Basma.connection.transport, 'long-polling');
});
test('Basma.timeout rejects with basma/timeout and a plain Arabic message', async () => {
  const h = coreHarness();
  const pending = h.ctx.Basma.timeout(new Promise(() => {}), 25000, 'managerHome');
  h.timers.find(t => t.ms === 25000).fn();
  await assert.rejects(pending, e => e.code === 'basma/timeout' && /لم يرد الخادم خلال 25 ثانية/.test(e.message));
});

// ---- Dashboard ----
function dashHarness(callImpl) {
  const nodes = new Map();
  class Node { constructor(tag = 'div') { this.tag = tag; this.children = []; this.style = {}; this.listeners = {}; this.textContent = ''; this.value = 'all'; }
    set innerHTML(_) { throw Error('no raw HTML'); } appendChild(c) { this.children.push(c); c.parentElement = this; return c; } append(...c) { c.forEach(x => this.appendChild(x)); }
    replaceChildren(...c) { this.children = []; this.append(...c); } addEventListener(t, f) { this.listeners[t] = f; } remove() {} get options() { return this.children; } }
  for (const id of ['ds-total', 'ds-present', 'ds-absent', 'ds-leave', 'dash-tbody', 'pr-wh', 'pr-emp', 'sb-company', 'sb-logo']) { const n = new Node(); n.id = id; nodes.set(id, n); }
  const calls = [], traces = [];
  const node = id => { if (!nodes.has(id)) { const n = new Node(); n.id = id; nodes.set(id, n); } return nodes.get(id); };
  const ctx = { document: { getElementById: node, createElement: t => new Node(t), addEventListener() {}, visibilityState: 'visible' }, BasmaReports: require('../public/assets/report-model'),
    BasmaManagerData: require('../public/assets/manager-data'), window: { addEventListener() {} }, setInterval() {}, Date, Intl, JSON, Object, Promise, Number, String, Error, Math,
    DB: { ref: () => { throw Error('dashboard must not read the database directly'); } }, COMPANY_ID: 'c1', COMPANY_INFO: { timeZone: 'UTC' }, ALL_EMPLOYEES: {}, ALL_WAREHOUSES: {},
    dashWHFilter: 'all', reportData: [], payrollData: {}, showToast() {}, showLoading() {}, hideLoading() {}, populateWHSelects() {}, loadBadges() {}, loadAdminNotifBadge() {},
    Basma: { profile: { clockOffset: 0 }, call: async name => { calls.push(name); return callImpl(name, calls.length); }, clock: () => 0, trace: (s, t, ok, code) => traces.push([s, ok, code]),
      timeout: (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(Object.assign(Error('لم يرد الخادم خلال ثانية'), { code: 'basma/timeout' })), 20))]) } };
  for (const n of ['loadAttendance', 'generateReport', 'calculatePayroll', 'showEmpModal', 'saveEmpSalary', 'loadAdminNotifBadge', 'loadAllData', 'closeEmpModal']) ctx[n] ??= async () => {};
  ctx.loadDashboard = async () => {};
  vm.runInNewContext(read('dialogs.js'), ctx); // as on the page: BasmaErrors is loaded before the manager scripts
  vm.runInNewContext(read('manager-views.js'), ctx);
  // Badge counters are live listeners (not the dashboard path and not blocking); they are tested elsewhere.
  ctx.loadBadges = () => {}; ctx.loadAdminNotifBadge = () => {};
  const text = id => { const all = (n, o = []) => { o.push(n); n.children.forEach(c => all(c, o)); return o; }; return all(nodes.get(id)).map(n => n.textContent).join('\n'); };
  return { ctx, nodes, calls, traces, text };
}
const today = new Date().toISOString().slice(0, 10);
const home = { date: today, serverTime: Date.now(), info: { nameAr: 'شركة أ', logo: '🏢', timeZone: 'UTC' }, settings: {}, warehouses: { w1: { name: 'الفرع' } },
  employees: { e1: { name: 'أحمد', status: 'approved', warehouseId: 'w1', warehouseName: 'الفرع' }, e2: { name: 'سارة', status: 'approved', warehouseId: 'w1', warehouseName: 'الفرع' } },
  records: { r1: { empId: 'e1', type: 'in', timestamp: `${today}T08:00:00Z`, dateKey: today, warehouseId: 'w1', warehouseName: 'الفرع', locStatus: 'approved' } }, leaves: {}, excuses: {} };

test('dashboard loads from ONE managerHome call, with no direct database read', async () => {
  const h = dashHarness(name => (name === 'managerHome' ? home : {}));
  await h.ctx.loadAllData();
  assert.deepEqual(plain(h.calls), ['managerHome']);
  assert.equal(h.nodes.get('ds-total').textContent, 2); assert.equal(h.nodes.get('ds-present').textContent, 1); assert.equal(h.nodes.get('ds-absent').textContent, 1);
  assert.equal(h.nodes.get('dash-tbody').children.length, 2);
  assert.equal(h.nodes.get('sb-company').textContent, 'شركة أ'); assert.equal(h.nodes.get('sb-logo').textContent, '🏢');
  assert.ok(h.traces.some(([s, ok]) => s === 'الدالة managerHome' && ok));
});
test('dashboard: a silent server shows a clear Arabic error and a retry button (no endless spinner); retry loads', async () => {
  const h = dashHarness((name, n) => (n === 1 ? new Promise(() => {}) : home));
  await h.ctx.loadDashboard();
  assert.equal(h.nodes.get('ds-total').textContent, '—');
  assert.match(h.text('dash-tbody'), /تعذر تحميل لوحة التحكم/); assert.match(h.text('dash-tbody'), /basma\/timeout/);
  assert.ok(h.traces.some(([s, ok, c]) => s === 'الدالة managerHome' && !ok && c === 'basma/timeout'));
  const all = (n, o = []) => { o.push(n); n.children.forEach(c => all(c, o)); return o; };
  const retry = all(h.nodes.get('dash-tbody')).find(n => n.tag === 'button' && n.textContent === 'إعادة المحاولة');
  assert.ok(retry, 'retry button'); await retry.listeners.click(); await new Promise(r => setTimeout(r, 5));
  assert.equal(h.nodes.get('ds-total').textContent, 2);
});
test('dashboard: a server error is shown in plain Arabic with its code', async () => {
  const h = dashHarness(() => { throw Object.assign(Error('denied'), { code: 'functions/permission-denied' }); });
  await h.ctx.loadDashboard();
  assert.match(h.text('dash-tbody'), /تعذر تحميل لوحة التحكم/); assert.match(h.text('dash-tbody'), /functions\/permission-denied/);
});
