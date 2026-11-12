'use strict';
// Runs the real public/assets/manager.js with the shared dialogs: no native dialogs, credentials shown once.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const { createDom, settle, plain } = require('./fake-dom');
const managerSource = fs.readFileSync(require.resolve('../public/assets/manager.js'), 'utf8');
const dialogsSource = fs.readFileSync(require.resolve('../public/assets/dialogs.js'), 'utf8');
const forbidden = () => { throw Error('native dialog used'); };

function harness(calls = {}) {
  const dom = createDom(['act-link-username', 'act-link-password', 'sched-emp-sel', 'sched-ci-from', 'sched-ci-to', 'sched-co-from', 'sched-co-to']);
  const log = { calls: [], toasts: [], db: [], opened: [], console: [] };
  const ref = path => ({ remove: async () => { log.db.push(['remove', path]); }, update: async v => { log.db.push(['update', path, v]); }, once: async () => ({ val: () => null }), on() {} });
  const ctx = {
    window: { open: url => log.opened.push(url) }, document: dom.document, navigator: { clipboard: { writeText: async () => {} } },
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(k => [k, (...a) => log.console.push(a.join(' '))])),
    Basma: { call: (name, data) => { log.calls.push({ name, data }); return (calls[name] || (async () => ({ ok: true })))(data); }, db: () => ({ ref }) },
    DB: { ref }, COMPANY_ID: 'c1', ALL_EMPLOYEES: { e1: { name: 'موظف' } }, adminNotifCount: 3,
    showToast: (m, t) => log.toasts.push({ m, t }), showLoading() {}, hideLoading() {}, closeEmpModal() {}, loadWarehouses() {}, loadEmployees: async () => {}, toggleAddEmpPanel() {}, loadAllData: async () => {}, loadLeaves() {}, loadExcuses() {}, loadBadges() {},
    alert: forbidden, confirm: forbidden, prompt: forbidden
  };
  vm.runInNewContext(dialogsSource, ctx); ctx.BasmaDialogs = ctx.window.BasmaDialogs;
  // Define every legacy global that manager.js reassigns (they live in the page's inline script).
  for (let i = 0; i < 80; i++) {
    try { vm.runInNewContext(managerSource, ctx); break; }
    catch (e) { const m = /^(\w+) is not defined$/.exec(e.message); if (!(e instanceof ReferenceError || e.name === 'ReferenceError') || !m) throw e; ctx[m[1]] = () => {}; }
  }
  const click = async label => { const b = dom.button(label); assert.ok(b, `button "${label}"`); b.listeners.click(); await settle(); };
  return { ...dom, ctx, log, click };
}

test('new employee credentials appear once in the in-page box, not in the old modal or a URL', async () => {
  const h = harness();
  const done = h.ctx.showActLinkModal('تم إضافة الموظف', 'سلّم بيانات الدخول عبر قناة خاصة.', 'emp_42', 'Emp-Pass-42', 'موظف');
  assert.deepEqual(h.inputs().map(i => i.value), ['emp_42', 'Emp-Pass-42']);
  assert.equal(h.byId.get('act-link-password').textContent, '');
  assert.equal(h.byId.get('act-link-username').textContent, '');
  const fields = h.inputs();
  await h.click('تم، حفظتها'); await done;
  assert.ok(fields.every(f => f.value === ''));
  assert.equal(h.log.opened.length, 0, 'no WhatsApp URL with a password');
  assert.equal(JSON.stringify([h.log.console, h.texts()]).includes('Emp-Pass-42'), false);
});

test('reset employee account asks in-page; cancel makes no call', async () => {
  const h = harness();
  const done = h.ctx.resetEmployeeBio('e1'); await settle();
  await h.click('إلغاء'); await done;
  assert.equal(h.log.calls.length, 0);
});

test('reset employee account confirmed: calls the server once, then shows the new login in the box', async () => {
  const h = harness({ employeeAccount: async () => ({ username: 'emp_1', password: 'New-Pass-1' }) });
  const done = h.ctx.resetEmployeeBio('e1'); await settle();
  await h.click('إعادة التعيين'); await settle();
  assert.deepEqual(plain(h.log.calls), [{ name: 'employeeAccount', data: { employeeId: 'e1', resetBio: true } }]);
  assert.deepEqual(h.inputs().map(i => i.value), ['emp_1', 'New-Pass-1']);
  await h.click('تم، حفظتها'); await done;
});

test('manual attendance reason uses the in-page form', async () => {
  const h = harness();
  const done = h.ctx.overrideAttendance('e1', 'present'); await settle();
  h.inputs()[0].value = 'نسي البصمة';
  await h.click('موافق'); await done; await settle();
  assert.deepEqual(plain(h.log.calls), [{ name: 'manualAttendance', data: { employeeId: 'e1', status: 'present', reason: 'نسي البصمة' } }]);
});

test('manual attendance with an empty reason sends nothing', async () => {
  const h = harness();
  const done = h.ctx.overrideAttendance('e1', 'present'); await settle();
  await h.click('موافق'); await done;
  assert.equal(h.log.calls.length, 0);
});

test('deleting notifications and removing a schedule ask in-page first', async () => {
  const h = harness();
  let done = h.ctx.clearAdminNotifs(); await settle(); await h.click('إلغاء'); await done;
  assert.equal(h.log.db.length, 0);
  done = h.ctx.clearAdminNotifs(); await settle(); await h.click('حذف'); await done;
  assert.deepEqual(h.log.db, [['remove', 'companies/c1/notifications/admin']]);
  h.byId.get('sched-emp-sel').value = 'e1';
  done = h.ctx.clearEmpSchedule(); await settle(); await h.click('إزالة'); await done;
  assert.deepEqual(h.log.db.at(-1), ['remove', 'companies/c1/employees/e1/schedule']);
});

test('renaming a branch uses the in-page form', async () => {
  const h = harness();
  const done = h.ctx.editWH('w1', 'قديم'); await settle();
  assert.equal(h.inputs()[0].value, 'قديم');
  h.inputs()[0].value = 'جديد'; await h.click('موافق'); await done;
  assert.deepEqual(plain(h.log.db.at(-1)), ['update', 'companies/c1/warehouses/w1', { name: 'جديد' }]);
});

test('copy fallback shows the text in-page instead of prompt()', async () => {
  const h = harness();
  const done = h.ctx.fallbackCopy('https://example.invalid/x'); await settle();
  assert.equal(h.inputs()[0].value, 'https://example.invalid/x');
  await h.click('حسنًا'); await done;
});
