'use strict';
// v5.10: the real manager-views.js list pages and core.js spinner/write limits against small fakes (no browser).
// The database fake throws on ANY direct read: lists must come only from the managerList server call.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const { createDom, settle, plain } = require('./fake-dom');
const read = f => fs.readFileSync(require.resolve('../public/assets/' + f), 'utf8');

function managerHarness(server) {
  const dom = createDom(), calls = [], writes = [], toasts = [], filtered = [];
  const getElementById = id => { if (!dom.byId.has(id)) { const n = new dom.Node(); n.id = id; dom.byId.set(id, n); } return dom.byId.get(id); };
  const directRead = path => () => { throw Error(`direct database read: ${path}`); };
  const DB = { ref: path => ({ once: directRead(path), on: directRead(path), get: directRead(path), orderByChild: directRead(path), off() {}, update: async v => { writes.push([path, v]); } }) };
  const stateBox = (kind, { text = '', error = null, retry = null } = {}) => {
    const box = dom.document.createElement('div'); box.className = `basma-state basma-state-${kind}`; box.appendChild(Object.assign(dom.document.createElement('div'), { textContent: text }));
    if (error?.code) box.appendChild(Object.assign(dom.document.createElement('div'), { textContent: error.code }));
    if (retry) { const b = Object.assign(dom.document.createElement('button'), { textContent: 'إعادة المحاولة' }); b.addEventListener('click', retry); box.appendChild(b); }
    return box;
  };
  const timeouts = [];
  const Basma = { profile: { role: 'manager' }, clock: () => 0, trace() {}, stateBox,
    timeout: (promise, ms, label) => { timeouts.push([label, ms]); return promise; },
    call: async (name, data) => { calls.push([name, JSON.parse(JSON.stringify(data ?? {}))]); return server(name, data || {}); } };
  const ctx = { document: { ...dom.document, getElementById, querySelector: () => null }, window: { addEventListener() {} }, setInterval() {}, Basma, DB,
    BasmaManagerData: require('../public/assets/manager-data'), BasmaReports: require('../public/assets/report-model'),
    BasmaDialogs: { confirm: async () => true, form: async () => ({ name: 'اسم جديد' }) },
    COMPANY_ID: 'c1', COMPANY_INFO: { timeZone: 'UTC' }, ALL_EMPLOYEES: {}, ALL_WAREHOUSES: {}, dashWHFilter: 'all', attStatusFilter: 'all', reportData: [], payrollData: {}, adminNotifBadgeListener: null, adminNotifPageListener: null,
    pageLoaders: {}, currentPage: 'warehouses', whSchedCurrentId: null, whGzCurrentId: null, whGzLat: null, whGzLng: null, whGzReady: false,
    showToast: (m, t) => toasts.push([t, m]), showLoading() {}, hideLoading() {}, loadAllData: async () => {}, closeEmpModal() {}, populateWHSelects() {}, filterEmps: () => filtered.push(Object.keys(ctx.ALL_EMPLOYEES)), loadHolidays() {}, updateRepDates() {}, format12: v => v,
    Date, Intl, setTimeout, clearTimeout };
  for (const name of ['loadDashboard', 'loadAttendance', 'generateReport', 'calculatePayroll', 'showEmpModal', 'saveEmpSalary', 'loadAdminNotifBadge', 'loadLocReview', 'approveLocation', 'rejectLocation', 'answerBypass', 'loadEmployees', 'loadWarehouses', 'loadSettings', 'loadMessages', 'loadAdminNotifPage', 'addWarehouse', 'editWH', 'deleteWH', 'whSetGeoZone', 'whGzSave', 'saveWhSchedule', 'clearWhSchedule', 'showWhScheduleModal', 'loadMissions', 'loadApprovals'])
    if (!(name in ctx)) ctx[name] = async () => { throw Error(`original ${name} must not run`); };
  vm.runInNewContext(read('manager-views.js'), ctx);
  const texts = node => { const out = []; const walk = n => { out.push(n.textContent); n.children.forEach(walk); }; walk(node); return out.join(' | '); };
  const button = (node, label) => { let found; const walk = n => { if (n.tag === 'button' && n.textContent === label) found = found || n; n.children.forEach(walk); }; walk(node); return found; };
  return { ctx, dom, calls, writes, toasts, filtered, timeouts, el: getElementById, texts, button, list: name => calls.filter(c => c[0] === name).map(c => c[1]) };
}
const staffPages = { null: { order: ['e1'], items: { e1: { name: 'أحمد', status: 'approved', warehouseId: 'w1' } }, next: 'e1' }, e1: { order: ['e2'], items: { e2: { name: 'سارة', status: 'pending_activation', warehouseId: 'w1' } }, next: null } };
const branches = { order: ['w1', 'w2'], items: { w1: { name: 'الرئيسي', active: true, geoZone: { lat: 24.7, lng: 46.6, radius: 250 } }, w2: { name: 'الشمال', active: true, schedule: { checkIn: { from: '08:00' }, checkOut: { to: '16:00' } } } }, next: null, counts: { w1: 3 } };
const defaultServer = (name, data) => {
  if (name === 'managerList' && data.kind === 'employees') return staffPages[data.cursor ?? null];
  if (name === 'managerList' && data.kind === 'warehouses') return branches;
  if (name === 'managerList' && data.kind === 'settings') return { settings: { checkIn: { from: '07:30', to: '08:30' } } };
  if (name === 'managerList' && data.kind === 'messages') return data.cursor ? { order: ['m1'], items: { m1: { empId: 'e1', message: 'قديمة', read: true } }, next: null } : { order: ['m2'], items: { m2: { empId: 'e1', message: 'جديدة', read: false } }, next: 'm2' };
  if (name === 'managerList' && data.kind === 'notifications') return { order: ['n2', 'n1'], items: { n2: { type: 'checkin', message: 'حضور', read: false }, n1: { type: 'checkout', message: 'انصراف', read: true } }, next: null };
  if (name === 'managerList' && data.kind === 'devices') return { order: [], items: {} };
  if (name === 'managerBranch') return { id: data.id || 'w9' };
  throw Error('unexpected call ' + name);
};

test('employees page: every page from managerList (cursor), branches too, 20 s limit, no direct database read', async () => {
  const h = managerHarness(defaultServer);
  await h.ctx.pageLoaders.emps();
  assert.deepEqual(h.list('managerList').filter(d => d.kind === 'employees'), [{ kind: 'employees' }, { kind: 'employees', cursor: 'e1' }]);
  assert.ok(h.list('managerList').some(d => d.kind === 'warehouses'));
  assert.deepEqual(Object.keys(h.ctx.ALL_EMPLOYEES), ['e1', 'e2']); assert.deepEqual(h.filtered.at(-1), ['e1', 'e2']);
  assert.ok(h.timeouts.every(([, ms]) => ms === 20000), 'each list call has the 20 s limit');
});

test('branches page: cards with staff counts, location and hours; empty and error states with retry', async () => {
  const h = managerHarness(defaultServer);
  await h.ctx.pageLoaders.warehouses();
  const list = h.el('warehouses-list');
  assert.equal(list.children.length, 2);
  assert.match(h.texts(list.children[0]), /الرئيسي.*3 موظف.*موقع محدد \(250م\)/);
  assert.match(h.texts(list.children[1]), /الشمال.*0 موظف.*08:00 – 16:00/);

  const empty = managerHarness((n, d) => (n === 'managerList' && d.kind === 'warehouses' ? { order: [], items: {}, next: null, counts: {} } : defaultServer(n, d)));
  await empty.ctx.pageLoaders.warehouses();
  assert.match(empty.texts(empty.el('warehouses-list')), /لا توجد فروع بعد/);

  let fail = true;
  const broken = managerHarness((n, d) => { if (n === 'managerList' && d.kind === 'warehouses' && fail) throw Object.assign(Error('down'), { code: 'functions/unavailable' }); return defaultServer(n, d); });
  await broken.ctx.pageLoaders.warehouses();
  const box = broken.el('warehouses-list');
  assert.match(broken.texts(box), /تعذر تحميل القائمة.*functions\/unavailable/);
  fail = false; broken.button(box, 'إعادة المحاولة').listeners.click(); await settle(20);
  assert.equal(box.children.length, 2, 'retry reloads the list');
});

test('branch add / rename / delete / hours / location go through managerBranch and reload the list', async () => {
  const h = managerHarness(defaultServer);
  await h.ctx.pageLoaders.warehouses();
  h.el('new-wh-name').value = ' فرع الجنوب ';
  await h.ctx.addWarehouse(); await settle(20);
  await h.ctx.editWH('w1'); await settle(20);
  await h.ctx.deleteWH('w2'); await settle(20);
  h.ctx.whSchedCurrentId = 'w1'; for (const [id, v] of [['wh-ci-from', '08:00'], ['wh-ci-to', '09:00'], ['wh-co-from', '16:00'], ['wh-co-to', '17:00']]) h.el(id).value = v;
  await h.ctx.saveWhSchedule(); await settle(20);
  await h.ctx.clearWhSchedule(); await settle(20);
  h.ctx.whGzCurrentId = 'w1'; h.ctx.whGzLat = 24.1; h.ctx.whGzLng = 46.2; h.ctx.whGzGetRadius = () => 300;
  await h.ctx.whGzSave(); await settle(20);
  assert.deepEqual(h.list('managerBranch'), [
    { action: 'add', name: 'فرع الجنوب' }, { action: 'rename', id: 'w1', name: 'اسم جديد' }, { action: 'delete', id: 'w2' },
    { action: 'schedule', id: 'w1', schedule: { checkIn: { from: '08:00', to: '09:00' }, checkOut: { from: '16:00', to: '17:00' }, startTime: null, workDays: null } }, // v5.17: start time + work days (empty = inherit)
    { action: 'schedule', id: 'w1', schedule: null }, { action: 'geoZone', id: 'w1', geoZone: { lat: 24.1, lng: 46.2, radius: 300 } }]);
  assert.equal(h.el('new-wh-name').value, '', 'input cleared after add');
  assert.equal(h.list('managerList').filter(d => d.kind === 'warehouses').length >= 7, true, 'the list reloads after each of the 6 changes');
  assert.ok(h.list('managerBranch').length === 6 && h.timeouts.filter(([l]) => l === 'managerBranch').every(([, ms]) => ms === 20000));

  const refused = managerHarness((n, d) => { if (n === 'managerBranch') throw Object.assign(Error('الفرع غير موجود'), { code: 'functions/not-found' }); return defaultServer(n, d); });
  refused.el('new-wh-name').value = 'x'; await refused.ctx.addWarehouse();
  assert.equal(refused.toasts.at(-1)[0], 'error'); assert.match(refused.toasts.at(-1)[1], /تعذر حفظ التغيير/); assert.equal(refused.el('new-wh-name').value, 'x', 'kept on failure');
});

test('settings, messages and activity notifications load from managerList; older pages on demand', async () => {
  const h = managerHarness(defaultServer);
  await h.ctx.pageLoaders.settings(); await settle();
  assert.equal(h.el('ci-from').value, '07:30');
  await h.ctx.pageLoaders.messages();
  const msgs = h.el('sent-messages-list');
  assert.match(h.texts(msgs), /جديدة/); assert.doesNotMatch(h.texts(msgs), /قديمة/);
  h.button(msgs, 'عرض المزيد').listeners.click(); await settle(20);
  assert.match(h.texts(msgs), /جديدة.*قديمة/); assert.equal(h.button(msgs, 'عرض المزيد'), undefined);
  assert.deepEqual(h.list('managerList').filter(d => d.kind === 'messages'), [{ kind: 'messages' }, { kind: 'messages', cursor: 'm2' }]);
  await h.ctx.pageLoaders['admin-notifs']();
  assert.match(h.texts(h.el('admin-notif-list')), /حضور.*انصراف/);
  assert.deepEqual(plain(h.writes), [['companies/c1/notifications/admin', { 'n2/read': true }]], 'only unread shown ones are marked read (a write, not a read)');
});

test('empty employee messages and notifications show a plain empty text, not a spinner', async () => {
  const h = managerHarness((n, d) => (n === 'managerList' && ['messages', 'notifications'].includes(d.kind) ? { order: [], items: {}, next: null } : defaultServer(n, d)));
  await h.ctx.pageLoaders.messages(); await h.ctx.pageLoaders['admin-notifs']();
  assert.match(h.texts(h.el('sent-messages-list')), /لا توجد رسائل مرسلة/);
  assert.match(h.texts(h.el('admin-notif-list')), /لا توجد إشعارات/);
});

// ---- core.js: 20 s spinner guard on all pages, state box, write limit ----
class El {
  constructor(tag, cls = '') { this.tag = tag; this.className = cls; this.children = []; this.style = {}; this.listeners = {}; this.textContent = ''; this.parentElement = null; this.isConnected = true; this.offsetParent = {}; this.classList = { contains: c => this.className.split(' ').includes(c), remove: c => { this.className = this.className.split(' ').filter(x => x !== c).join(' '); } }; }
  get childNodes() { return this.children; } get nodeType() { return 1; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  after(c) { const p = this.parentElement, i = p.children.indexOf(this); c.parentElement = p; p.children.splice(i + 1, 0, c); }
  remove() { const p = this.parentElement; if (p) p.children = p.children.filter(c => c !== this); this.parentElement = null; }
  addEventListener(t, f) { this.listeners[t] = f; }
  closest(sel) { const want = sel.replace('.', ''); for (let n = this; n; n = n.parentElement) if (n.classList.contains(want)) return n; return null; }
  querySelector(sel) { return sel === 'button' ? this.all().find(n => n.tag === 'button') : null; }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  text() { return this.all().map(n => n.textContent).join(' | '); }
}
function coreHarness() {
  const root = new El('body'), timers = [], reloads = [];
  const ctx = { console, Promise, Date, Error, Object, Number, String, Set, Map, WeakMap, Math, JSON,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    document: { createElement: tag => new El(tag), querySelectorAll: () => root.all().filter(n => /(^| )(spinner-sm|spinner|spinner-lg|lo-spinner)( |$)/.test(n.className)), getElementById: () => null } };
  ctx.window = ctx; ctx.location = { reload: () => reloads.push(1) };
  vm.runInNewContext(read('core.js'), ctx);
  return { Basma: ctx.Basma, ctx, root, timers, reloads };
}

test('spinner guard: a list spinner still visible after 20 s becomes an Arabic error with a retry button', () => {
  const h = coreHarness(), box = h.root.appendChild(new El('div')), spin = box.appendChild(new El('div', 'spinner-sm')), words = box.appendChild(new El('div'));
  words.textContent = 'جاري التحميل...';
  assert.equal(h.Basma.sweepSpinners(1000), 0);
  assert.equal(h.Basma.sweepSpinners(20999), 0, 'not before 20 s');
  assert.equal(h.Basma.sweepSpinners(21001), 1);
  assert.equal(spin.style.display, 'none'); assert.equal(words.style.display, 'none');
  assert.match(box.text(), /تأخر التحميل أكثر من 20 ثانية.*basma\/timeout.*إعادة المحاولة/);
  let refreshed = 0; h.ctx.refreshCurrentPage = () => refreshed++;
  box.all().find(n => n.tag === 'button').listeners.click();
  assert.equal(refreshed, 1); assert.equal(spin.style.display, '', 'the spinner is back while the page reloads');
  delete h.ctx.refreshCurrentPage;
  const other = h.root.appendChild(new El('div')); other.appendChild(new El('div', 'spinner'));
  h.Basma.sweepSpinners(0); h.Basma.sweepSpinners(25000); other.all().find(n => n.tag === 'button').listeners.click();
  assert.equal(h.reloads.length, 1, 'no page refresh function: reload');
  box.remove(); other.remove();
  const hidden = h.root.appendChild(new El('div', 'spinner-sm')); hidden.offsetParent = null;
  h.Basma.sweepSpinners(0); assert.equal(h.Basma.sweepSpinners(60000), 0, 'spinners on hidden pages are not counted');
});

test('spinner guard: the full-screen overlay gets a message, close button, and spins again on the next use', () => {
  const h = coreHarness(), overlay = h.root.appendChild(new El('div', 'loading-overlay active')), spin = overlay.appendChild(new El('div', 'spinner-lg')), label = overlay.appendChild(new El('div'));
  label.textContent = 'جاري التحميل...';
  h.Basma.sweepSpinners(0); assert.equal(h.Basma.sweepSpinners(20001), 1);
  assert.match(overlay.text(), /قد تكتمل العملية لاحقًا.*إغلاق/);
  overlay.classList.remove('active'); h.Basma.sweepSpinners(20002);
  assert.equal(spin.style.display, ''); assert.equal(label.style.display, ''); assert.doesNotMatch(overlay.text(), /إغلاق/);
});

test('write limit: direct writes reject after 20 s with an Arabic message; reads and listeners are untouched', async () => {
  const h = coreHarness(), raw = { ref: path => { const r = { path, set: () => new Promise(() => {}), update: async () => 'saved', once: () => `read:${path}`, push: (...a) => (a.length ? new Promise(() => {}) : { key: 'k1' }), child: p => ({ ...r, path: `${path}/${p}` }), off: () => 'off' }; return r; }, goOffline: () => 'offline' };
  const db = h.Basma.limitWrites(raw);
  assert.equal(db.ref('a').once('value'), 'read:a'); assert.equal(db.ref('a').off(), 'off'); assert.equal(db.goOffline(), 'offline');
  assert.equal(db.ref('a').push().key, 'k1', 'push() without a value still returns the new reference');
  assert.equal(await db.ref('a').update({}), 'saved');
  const pending = db.ref('a').child('b').set(1), timer = h.timers.at(-1);
  assert.equal(timer.ms, 20000); timer.fn();
  await assert.rejects(pending, e => e.code === 'basma/write-timeout' && /لم يُؤكَّد الحفظ خلال 20 ثانية/.test(e.message));
});

test('disabling an employee redraws the page the manager is on (the list does not keep the old row)', async () => {
  const order = [], ctx = { window: {}, document: { getElementById: () => null }, currentPage: 'emps',
    Basma: { call: async name => { order.push(name); return { ok: true }; } }, closeConfirm() {}, closeEmpModal() {}, showToast: (m, t) => order.push(`toast:${t}`),
    loadAllData: async () => { order.push('loadAllData'); }, pageLoaders: { emps: async () => { order.push('emps page'); } } };
  ctx.window = ctx;
  try { vm.runInNewContext(read('manager.js'), ctx); } catch {}
  await ctx.doDeleteEmp('e9');
  assert.deepEqual(order, ['disableEmployee', 'loadAllData', 'emps page', 'toast:success']);
  order.length = 0; ctx.currentPage = 'dash'; await ctx.doDeleteEmp('e9');
  assert.deepEqual(order, ['disableEmployee', 'loadAllData', 'toast:success'], 'dashboard is already refreshed once');
});

test('employees page: a pending fingerprint device is listed; approving calls managerDevice and redraws the list', async () => {
  let pending = true;
  const h = managerHarness((n, d) => {
    if (n === 'managerList' && d.kind === 'devices') return pending ? { order: ['e1'], items: { e1: { status: 'pending', label: 'Android · Chrome', registeredAt: 1 } } } : { order: [], items: {} };
    if (n === 'managerDevice') { pending = false; return { ok: true }; }
    return defaultServer(n, d);
  });
  h.el('page-emps').appendChild(h.el('emp-grid')); h.el('emp-grid').parentElement = h.el('page-emps'); // fake DOM: real browsers have parentElement
  h.el('page-emps').insertBefore = (node, ref) => { node.parent = h.el('page-emps'); h.el('page-emps').children.unshift(node); };
  await h.ctx.pageLoaders.emps(); await settle(20);
  const box = h.el('pending-devices-section');
  assert.match(h.texts(box), /أجهزة بانتظار الاعتماد \(1\).*أحمد.*Android · Chrome/);
  h.button(box, 'اعتماد الجهاز').listeners.click(); await settle(30);
  assert.deepEqual(h.list('managerDevice'), [{ action: 'approve', employeeId: 'e1' }]);
  assert.equal(box.children.length, 0, 'list redrawn: nothing pending');
  assert.ok(h.timeouts.some(([label, ms]) => label === 'managerDevice' && ms === 20000));
});

// v5.19 (owner, 24 Nov 2026): overlapping windows. New saves are stopped before any call; existing overlaps only warn.
test('schedule windows: an overlapping save sends nothing; an existing overlapping branch shows «أوقات متداخلة»', async () => {
  const overlapBranches = { ...branches, order: ['w1', 'w2', 'w3'], items: { ...branches.items, w3: { name: 'المتداخل', active: true, schedule: { checkIn: { from: '20:00', to: '21:56' }, checkOut: { from: '21:35', to: '22:35' } } } } };
  const h = managerHarness((n, d) => (n === 'managerList' && d.kind === 'warehouses' ? overlapBranches : defaultServer(n, d)));
  await h.ctx.pageLoaders.warehouses(); await settle(20);
  const cards = h.el('warehouses-list').children;
  assert.match(h.texts(cards[2]), /أوقات متداخلة/, 'existing overlap is flagged, not changed');
  assert.doesNotMatch(h.texts(cards[0]), /أوقات متداخلة/);
  h.ctx.whSchedCurrentId = 'w1';
  for (const [id, v] of [['wh-ci-from', '20:00'], ['wh-ci-to', '21:56'], ['wh-co-from', '21:35'], ['wh-co-to', '22:35']]) h.el(id).value = v;
  await h.ctx.saveWhSchedule(); await settle(20);
  assert.equal(h.list('managerBranch').length, 0, 'nothing sent');
  assert.deepEqual(h.toasts.at(-1), ['error', 'أوقات متداخلة: وقت الانصراف يجب أن يبدأ عند نهاية وقت الحضور أو بعده']);
  h.el('wh-co-from').value = '21:56'; await h.ctx.saveWhSchedule(); await settle(20);
  assert.equal(h.list('managerBranch').length, 1, 'check-out starting exactly when check-in ends is accepted');
});

// v6.6 (owner, 27 Nov 2026): the dashboard is drawn from the phone's saved copy BEFORE sign-in finishes (no session yet).
test('the dashboard draws from a saved copy with no session and no server call, without an error', async () => {
  const h = managerHarness(defaultServer);
  const home = { date: '2026-11-27', info: { nameAr: 'شركة', timeZone: 'UTC' }, employees: { e1: { name: 'أحمد', status: 'approved', role: 'محاسب', warehouseId: 'w1', warehouseName: 'الفرع' } }, warehouses: { w1: { name: 'الفرع', active: true } }, settings: {}, records: {}, leaves: {}, excuses: {} };
  h.ctx.DB = undefined; // before the session: no database adapter, no profile
  for (const id of ['pr-wh', 'pr-emp']) h.el(id).options = []; // a real <select> has an options list (the fake page does not)
  const before = h.calls.length;
  h.ctx.renderDashboard(home, { offline: true }); await settle(20);
  assert.match(h.texts(h.el('dash-tbody')), /أحمد/, 'drawn from the saved copy');
  assert.equal(h.calls.length, before, 'no server call');
  assert.equal(h.toasts.filter(t => t[0] === 'error').length, 0, 'no error');
});
