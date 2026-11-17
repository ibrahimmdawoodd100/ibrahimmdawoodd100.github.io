'use strict';
// v5.11: the real core.js server-routed database adapter, the three pages' route tables, the employee notifications
// page, and the CSP/Leaflet self-hosting — against small fakes (no browser).
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { createDom, settle, plain } = require('./fake-dom');
const root = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8');

function core(server) {
  const calls = [], traces = [], timers = [], intervals = [], events = {};
  const ctx = { console, Promise, Date, Error, Object, Number, String, Set, Map, WeakMap, Math, JSON, Array, RegExp, queueMicrotask,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1; },
    performance: { now: () => 0 }, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { visibilityState: 'visible', addEventListener: (t, f) => { (events[t] ||= []).push(f); }, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), body: { appendChild() {} }, getElementById: () => null },
    BASMA_NO_SPINNER_GUARD: true, CustomEvent: class { constructor(type) { this.type = type; } } };
  ctx.window = ctx; ctx.addEventListener = (t, f) => { (events[t] ||= []).push(f); }; ctx.dispatchEvent = e => (events[e.type] || []).forEach(f => f(e));
  ctx.BASMA_CONFIG = { firebase: {}, appCheckSiteKey: 'k', region: 'us-central1' };
  const app = { auth: () => ({ currentUser: null, onAuthStateChanged: fn => { queueMicrotask(fn); return () => {}; }, setPersistence: async () => {} }), appCheck: () => ({ activate() {} }),
    functions: () => ({ httpsCallable: name => async data => { calls.push([name, JSON.parse(JSON.stringify(data))]); return { data: await server(name, data) }; } }) };
  ctx.firebase = { apps: [], initializeApp: () => app, appCheck: { ReCaptchaEnterpriseProvider: class {} }, auth: { Auth: { Persistence: { SESSION: 's', LOCAL: 'l' } } } };
  vm.runInNewContext(read('public/assets/core.js'), ctx);
  const ready = ctx.Basma.init('manager');
  return { ready, Basma: ctx.Basma, ctx, calls, timers, intervals, events, fire: t => (events[t] || []).forEach(f => f()) };
}
const realDb = log => () => ({ ref: p => { log.push(p); return { once: async () => ({ val: () => `real:${p}` }), on: () => 'real-on', off() {}, set: async () => 'real-set' }; } });

test('adapter: routed reads become ONE server call each (shared within 10 s), snapshots keep server order', async () => {
  const h = core(async (name, data) => (data.kind === 'missions' ? { order: ['b', 'a'], items: { a: { n: 1 }, b: { n: 2 } } } : { value: { checkIn: 'x' } }));
  await h.ready; const unrouted = [];
  const db = h.Basma.serverDb(realDb(unrouted), (p, op, { query }) => (op === 'read' && p === 'companies/c1/missions' && query.orderByChild === 'empId' && query.equalTo === 'e1' ? { name: 'managerList', data: { kind: 'missions' } } : op === 'read' && p === 'companies/c1/today/e1' ? { name: 'managerList', data: { kind: 'today' } } : null));
  const snap = await db.ref('companies/c1/missions').orderByChild('empId').equalTo('e1').limitToLast(200).once('value');
  const keys = []; snap.forEach(c => { keys.push(c.key); });
  assert.deepEqual(keys, ['b', 'a']); assert.equal(snap.numChildren(), 2); assert.deepEqual(plain(snap.val()), { a: { n: 1 }, b: { n: 2 } });
  await db.ref('companies/c1/missions').orderByChild('empId').equalTo('e1').limitToLast(200).once('value');
  assert.deepEqual((await db.ref('companies/c1/today/e1').get()).val().checkIn, 'x');
  assert.deepEqual(h.calls.map(c => c[1].kind), ['missions', 'today'], 'second identical read served from the short cache');
  assert.deepEqual(unrouted, [], 'the realtime database is never opened for routed paths');
  assert.equal(String(await db.ref('companies/c1/other').once('value').then(s => s.val())), 'real:companies/c1/other', 'unrouted paths still work');
});

test('adapter: listeners call back only on change, refresh on focus, and never log out on a network error', async () => {
  let value = 'active', fail = null;
  const h = core(async () => { if (fail) throw fail; return { value }; });
  await h.ready;
  const db = h.Basma.serverDb(() => { throw Error('no realtime'); }, p => (p === 'status' ? { name: 'employeeList', data: { kind: 'status' } } : null), { ttl: 0 });
  const seen = [], errors = [];
  db.ref('status').on('value', s => seen.push(s.val()), e => errors.push(e.code)); await settle();
  h.fire('focus'); await settle();
  assert.deepEqual(seen, ['active'], 'same value: no second callback');
  value = 'suspended'; h.fire('focus'); await settle();
  assert.deepEqual(seen, ['active', 'suspended']);
  fail = Object.assign(Error('slow'), { code: 'basma/timeout' }); h.fire('focus'); await settle();
  fail = Object.assign(Error('net'), { code: 'functions/unavailable' }); h.fire('focus'); await settle();
  assert.deepEqual(errors, [], 'timeouts and network errors do not reach the logout handler');
  fail = Object.assign(Error('no'), { code: 'functions/permission-denied' }); h.fire('focus'); await settle();
  assert.deepEqual(errors, ['functions/permission-denied']);
  assert.ok(h.intervals.some(i => i.ms === 120000), 'refresh every 2 minutes while visible');
  db.ref('status').off('value'); fail = null; value = 'x'; h.fire('focus'); await settle();
  assert.deepEqual(seen, ['active', 'suspended'], 'off() stops the refresh');
});

test('adapter: prime() serves the first value without a call; pick() shares one result; writes are calls that refresh listeners', async () => {
  const h = core(async (name, data) => (name === 'managerList' ? { status: 'active', leaves: ['l1', 'l2'] } : { ok: true }));
  const route = (p, op, { value }) => {
    if (op === 'read' && p === 'leaves') return { name: 'managerList', data: { kind: 'badges' }, pick: b => ({ order: b.leaves, items: Object.fromEntries(b.leaves.map(k => [k, true])) }) };
    if (op === 'read' && p === 'status') return { name: 'managerList', data: { kind: 'badges' }, pick: b => ({ value: b.status }) };
    if (op === 'update' && p === 'settings') return { name: 'managerSettings', data: { action: 'timeWindows', ...value } };
    if (op === 'push' && p === 'holidays') return { name: 'managerSettings', data: { action: 'holidayAdd', ...value } };
    return null;
  };
  await h.ready; const db = h.Basma.serverDb(() => { throw Error('no realtime'); }, route);
  db.prime('managerList', { kind: 'badges' }, { status: 'active', leaves: ['l1'] });
  const counts = []; db.ref('leaves').on('value', s => counts.push(s.numChildren()));
  assert.equal((await db.ref('status').once('value')).val(), 'active'); await settle();
  assert.deepEqual(h.calls, [], 'primed: no call on open');
  await db.ref('settings').update({ checkIn: { from: '08:00', to: '09:00' } }); await settle();
  assert.deepEqual(h.calls.map(c => c[0]), ['managerSettings', 'managerList'], 'write, then ONE badges refresh');
  assert.deepEqual(counts, [1, 2]);
  assert.throws(() => db.ref('holidays').push(), /غير مدعوم/, 'a routed push needs a value');
});

test('route tables: every remaining employee, manager and seller database path maps to a server call', () => {
  const load = (file, extra) => { const ctx = { window: {}, document: { getElementById: () => null }, ...extra }; ctx.window = ctx; try { vm.runInNewContext(read(file), ctx); } catch {} return ctx; };
  const emp = load('public/assets/employee.js', { COMPANY_ID: 'c1', ACTIVATION_UID: 'e1' }).employeeRoute;
  const q = (orderByChild, equalTo) => ({ query: { orderByChild, equalTo, limitToLast: 200 } });
  assert.deepEqual(plain(emp('companies/c1/today/e1', 'read', { query: {} })), { name: 'employeeList', data: { kind: 'today' } });
  assert.deepEqual(plain(emp('companies/c1/records', 'read', q('empId', 'e1'))).data, { kind: 'history' });
  for (const c of ['missions', 'leaves', 'excuses']) assert.deepEqual(plain(emp(`companies/c1/${c}`, 'read', q('empId', 'e1'))).data, { kind: c });
  assert.equal(emp('companies/c1/records', 'read', q('empId', 'e2')), null, 'another employee: never routed');
  assert.deepEqual(plain(emp('companies/c1/partialLeaveRecords/e1/2026-11-17', 'read', { query: {} })).data, { kind: 'partialRecords', date: '2026-11-17' });
  assert.deepEqual(plain(emp('companies/c1/notifications/e1', 'update', { query: {}, value: { 'n1/read': true } })).data, { kind: 'notificationsUpdate', updates: { 'n1/read': true } });
  for (const p of ['companies/c1/info/status', 'companies/c1/employees/e1/status', 'companies/c1/todayPartialLeave/e1', 'companies/c1/notifications/e1']) assert.ok(emp(p, 'read', { query: {} }), p);

  const mgr = load('public/assets/manager.js', { COMPANY_ID: 'c1' }).managerRoute, none = { query: {} };
  const badge = mgr('companies/c1/leaves', 'read', { query: { orderByChild: 'status', equalTo: 'pending' } });
  assert.deepEqual(plain(badge.data), { kind: 'badges' }); assert.deepEqual(plain(badge.pick({ leaves: ['a'] })), { order: ['a'], items: { a: true } });
  assert.deepEqual(plain(mgr('companies/c1/notifications/admin', 'read', { query: { orderByChild: 'read', equalTo: false } }).pick({ unread: ['n'] })).order, ['n']);
  assert.deepEqual(plain(mgr('companies/c1/missions', 'read', { query: { orderByChild: 'status', equalTo: 'started' } }).pick({ started: ['m'] })).order, ['m']);
  assert.deepEqual(plain(mgr('companies/c1/info/status', 'read', none).pick({ status: 'active' })), { value: 'active' });
  assert.deepEqual(plain(mgr('privatePayroll/c1/e9', 'read', none).data), { kind: 'payroll', employeeId: 'e9' });
  assert.deepEqual(plain(mgr('companies/c1/today/e9', 'read', none).data), { kind: 'employeeToday', employeeId: 'e9' }, 'employee modal');
  assert.deepEqual(plain(mgr('companies/c1/warehouses', 'read', none).data), { kind: 'warehouses' }, 'add-employee branch list');
  const w = { from: '08:00', to: '09:00' };
  assert.deepEqual(plain(mgr('companies/c1/settings', 'update', { query: {}, value: { checkIn: w, checkOut: w } }).data), { action: 'timeWindows', checkIn: w, checkOut: w });
  assert.equal(mgr('companies/c1/settings', 'update', { query: {}, value: { other: 1 } }), null, 'unknown settings fields are not routed');
  assert.deepEqual(plain(mgr('companies/c1/settings/holidays', 'push', { query: {}, value: { date: '2026-12-01', name: 'عطلة', active: true } }).data), { action: 'holidayAdd', date: '2026-12-01', name: 'عطلة' });
  assert.deepEqual(plain(mgr('companies/c1/settings/holidays/h1', 'remove', none).data), { action: 'holidayRemove', id: 'h1' });
  assert.deepEqual(plain(mgr('companies/c1/settings/geoZone', 'set', { query: {}, value: { enabled: false, zones: [] } }).data).action, 'geoZone');
  assert.deepEqual(plain(mgr('companies/c1/employees/e1/schedule', 'remove', none).data), { action: 'employeeSchedule', employeeId: 'e1', schedule: null });
  assert.deepEqual(plain(mgr('companies/c1/notifications/admin', 'remove', none).data), { action: 'adminNotificationsClear' });
  assert.deepEqual(plain(mgr('companies/c1/missions', 'push', { query: {}, value: { empId: 'e1' } }).data), { action: 'missionAdd', mission: { empId: 'e1' } });
  assert.deepEqual(plain(mgr('companies/c1/missions/m1', 'remove', none).data), { action: 'missionRemove', id: 'm1' });

  const sell = load('public/assets/seller.js', {}).sellerRoute;
  assert.deepEqual(plain(sell('seller/transactions', 'read', none).data), { kind: 'transactions' });
  assert.deepEqual(plain(sell('seller/notifications', 'update', { query: {}, value: { 'n/read': true } }).data), { kind: 'notificationsUpdate', updates: { 'n/read': true } });
  assert.deepEqual(plain(sell('seller/transactions', 'push', { query: {}, value: { amount: 5 } }).data), { kind: 'addTransaction', transaction: { amount: 5 } });
});

function notifPage(server) {
  const dom = createDom(['main-tab-notifs']), calls = [], writes = [];
  const stateBox = (kind, { text = '', error, retry } = {}) => { const b = dom.document.createElement('div'); b.className = `basma-state-${kind}`; b.appendChild(Object.assign(dom.document.createElement('div'), { textContent: text })); if (error?.code) b.appendChild(Object.assign(dom.document.createElement('div'), { textContent: error.code })); if (retry) { const r = Object.assign(dom.document.createElement('button'), { textContent: 'إعادة المحاولة' }); r.addEventListener('click', retry); b.appendChild(r); } return b; };
  const ctx = { document: dom.document, window: {}, COMPANY_ID: 'c1', EMP: { id: 'e1' }, COMPANY_INFO: {}, loadNotifBadge() {}, loadNotifPage() {},
    DB: { ref: p => ({ update: async v => { writes.push([p, v]); } }) },
    Basma: { stateBox, timeout: (p, ms) => { assert.equal(ms, 20000); return p; }, call: async (n, d) => { calls.push([n, d]); return server(); } } };
  ctx.window = ctx;
  const src = read('public/assets/employee-views.js'), from = src.indexOf('// v5.11: notifications page');
  vm.runInNewContext(src.slice(from), ctx);
  const text = () => { const out = []; const walk = n => { out.push(n.textContent); n.children.forEach(walk); }; walk(dom.byId.get('main-tab-notifs')); return out.join(' | '); };
  return { ctx, dom, calls, writes, text, button: label => { let hit; const walk = n => { if (n.tag === 'button' && n.textContent === label) hit = hit || n; n.children.forEach(walk); }; walk(dom.byId.get('main-tab-notifs')); return hit; } };
}

test('employee notifications: one server call, newest first, unread marked read; empty and error states with retry', async () => {
  const h = notifPage(async () => ({ order: ['n1', 'n2'], items: { n1: { type: 'checkin', message: 'قديم', read: true }, n2: { type: 'private_msg', message: '<b>جديد</b>', read: false } } }));
  await h.ctx.loadNotifPage();
  assert.match(h.text(), /جديد.*قديم/); assert.match(h.text(), /<b>جديد<\/b>/, 'shown as text, never as HTML');
  assert.deepEqual(plain(h.calls), [['employeeList', { kind: 'notifications' }]]);
  await settle(); assert.deepEqual(plain(h.writes), [['companies/c1/notifications/e1', { 'n2/read': true }]]);

  const empty = notifPage(async () => ({ order: [], items: {} })); await empty.ctx.loadNotifPage();
  assert.match(empty.text(), /لا توجد إشعارات/); assert.equal(empty.writes.length, 0);

  let fail = true;
  const broken = notifPage(async () => { if (fail) throw Object.assign(Error('x'), { code: 'basma/timeout' }); return { order: ['a'], items: { a: { message: 'وصل', read: true } } }; });
  await broken.ctx.loadNotifPage();
  assert.match(broken.text(), /تعذر تحميل الإشعارات.*basma\/timeout.*إعادة المحاولة/);
  fail = false; broken.button('إعادة المحاولة').listeners.click(); await settle(20);
  assert.match(broken.text(), /وصل/);
});

test('CSP: Esri tiles allowed, Leaflet served from this site, no third-party script/style/image hosts left', () => {
  const policy = JSON.parse(read('security-policy.json')).contentSecurityPolicy, part = name => policy.split('; ').find(x => x.startsWith(name + ' '));
  assert.equal(part('img-src'), "img-src 'self' data: https://server.arcgisonline.com");
  assert.doesNotMatch(policy, /unpkg|cdnjs|tile\.openstreetmap/);
  assert.doesNotMatch(part('script-src'), /firebaseio|\*/, 'no long-polling script hosts, no wildcards in script-src');
  for (const page of ['public/manager/index.html', 'public/employee/index.html', 'public/seller.html', 'public/manager/diagnostics.html']) {
    const html = read(page); assert.match(html, /img-src 'self' data: https:\/\/server\.arcgisonline\.com;/, page); assert.doesNotMatch(html, /unpkg\.com|cdnjs/, page);
  }
  const manager = read('public/manager/index.html');
  assert.match(manager, /<link rel="stylesheet" href="\/manager\/assets\/leaflet\/leaflet\.css"\/>/); assert.match(manager, /<script src="\/manager\/assets\/leaflet\/leaflet\.js"><\/script>/);
  for (const f of ['leaflet.js', 'leaflet.css', 'images/marker-icon.png', 'images/marker-icon-2x.png', 'images/marker-shadow.png', 'images/layers.png', 'images/layers-2x.png']) assert.ok(fs.statSync(path.join(root, 'public/assets/leaflet', f)).size > 500, f);
  assert.match(read('public/assets/leaflet/leaflet.css'), /url\(images\/marker-icon\.png\)/, 'marker path is relative to the self-hosted CSS');
  assert.match(read('public/assets/manager-views.js'), /L\.Icon\.Default\.imagePath='\/manager\/assets\/leaflet\/images\/'/);
});
