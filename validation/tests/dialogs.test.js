'use strict';
// Shared in-page dialogs, core.js change-password, and static page checks.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { createDom, settle, plain } = require('./fake-dom');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const forbidden = () => { throw Error('native dialog used'); };

function loadDialogs(extra = {}) {
  const dom = createDom();
  const log = { toasts: [], clipboard: [] };
  const ctx = { window: {}, document: dom.document, navigator: { clipboard: { writeText: async t => { log.clipboard.push(t); } } }, showToast: (m, t) => log.toasts.push({ m, t }), alert: forbidden, confirm: forbidden, prompt: forbidden, ...extra };
  vm.runInNewContext(read('public/assets/dialogs.js'), ctx);
  return { ...dom, ctx, log, D: ctx.window.BasmaDialogs };
}
const click = async (dom, label) => { const b = dom.button(label); assert.ok(b, `button "${label}"`); b.listeners.click(); await settle(); };

test('form converts Arabic digits, keeps passwords exactly, and clears fields on close', async () => {
  const d = loadDialogs();
  const result = d.D.form('t', [{ id: 'n', label: 'n', value: '' }, { id: 'p', label: 'p', type: 'password' }]);
  const [n, p] = d.inputs(); n.value = ' ١٢٣ '; p.value = ' ٣Ab ';
  await click(d, 'موافق');
  assert.deepEqual(plain(await result), { n: '123', p: ' ٣Ab ' });
  assert.equal(n.value, ''); assert.equal(p.value, '');
  assert.equal(d.inputs().length, 0);
});

test('form cancel resolves null', async () => {
  const d = loadDialogs();
  const result = d.D.form('t', [{ id: 'n', label: 'n' }]);
  await click(d, 'إلغاء');
  assert.equal(await result, null);
});

test('confirm resolves true or false from in-page buttons', async () => {
  const d = loadDialogs();
  const yes = d.D.confirm('t', 'm', 'نعم'); await click(d, 'نعم'); assert.equal(await yes, true);
  const no = d.D.confirm('t', 'm', 'نعم'); await click(d, 'إلغاء'); assert.equal(await no, false);
});

test('credentials box copies, then removes and clears both values on close', async () => {
  const d = loadDialogs();
  const done = d.D.credentials('t', { username: 'u_1', password: 'P-1' });
  const fields = d.inputs();
  assert.deepEqual(fields.map(f => f.value), ['u_1', 'P-1']);
  assert.ok(fields.every(f => f.readOnly));
  await click(d, 'نسخ كلمة المرور'); assert.deepEqual(d.log.clipboard, ['P-1']);
  await click(d, 'تم، حفظتها'); await done;
  assert.ok(fields.every(f => f.value === ''));
  assert.equal(d.inputs().length, 0);
});

test('copy falls back with a visible hint when the clipboard is refused', async () => {
  const d = loadDialogs({ navigator: { clipboard: { writeText: async () => { throw Error('denied'); } } } });
  const ok = await d.D.copy('x', { focus() {}, select() {} });
  assert.equal(ok, false);
  assert.ok(d.log.toasts.some(t => t.t === 'info'));
});

function loadCore(dialogs) {
  const window = { BasmaDialogs: dialogs };
  const ctx = { window, console, alert: forbidden, prompt: forbidden, confirm: forbidden, document: createDom().document, URL };
  vm.runInNewContext(read('public/assets/core.js'), ctx);
  return window.Basma;
}

test('change password uses the in-page form and refuses mismatched passwords without calling the server', async () => {
  const notices = [];
  const dialogs = { form: async (title, fields) => { assert.deepEqual(plain(fields.map(f => f.type)), ['password', 'password']); return { password: 'a-long-password-1', again: 'different' }; }, notice: async (t, m) => notices.push(m) };
  const Basma = loadCore(dialogs);
  await Basma.changePassword();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /غير متطابقتين/);
});

test('change password cancel does nothing', async () => {
  const Basma = loadCore({ form: async () => null, notice: async () => { throw Error('no notice expected'); } });
  await Basma.changePassword();
});

test('change password reports a server error in-page instead of alert()', async () => {
  const notices = [];
  const Basma = loadCore({ form: async () => ({ password: 'same-password-123', again: 'same-password-123' }), notice: async (t, m) => notices.push(m) });
  await Basma.changePassword();
  assert.equal(notices.length, 1, 'the failure (no session in this fixture) is shown in-page');
});

test('every page loads dialogs.js right after core.js', () => {
  for (const page of ['public/seller.html', 'public/manager/index.html', 'public/employee/index.html']) {
    const s = read(page);
    const core = s.indexOf('<script src="/manager/assets/core.js"></script>'), dialogs = s.indexOf('<script src="/manager/assets/dialogs.js"></script>');
    assert.ok(core > 0 && dialogs > core, page);
  }
});

test('no native alert/confirm/prompt is reachable from the page scripts', () => {
  const native = file => [...read(file).matchAll(/(?:([\w$]+)\.)?\b(prompt|alert|confirm)\s*\(/g)].filter(m => !['BasmaDialogs', 'dialogs'].includes(m[1]) && !/function (confirm)\s*\(/.test(m.input.slice(Math.max(0, m.index - 9), m.index + m[0].length))).map(m => m[0]);
  for (const file of fs.readdirSync(path.join(root, 'public/assets')).filter(f => f.endsWith('.js'))) assert.deepEqual(native('public/assets/' + file), [], file);
  assert.deepEqual(native('public/seller.html'), []);
  assert.deepEqual(native('public/employee/index.html'), []);
  // The manager page's old inline functions still contain native calls; each one must be replaced by manager.js.
  const manager = read('public/manager/index.html'), overrides = read('public/assets/manager.js');
  const owners = new Set();
  for (const m of manager.matchAll(/\b(prompt|alert|confirm)\s*\(/g)) {
    const before = manager.slice(0, m.index), fn = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].at(-1)?.[1];
    owners.add(fn);
  }
  assert.deepEqual([...owners].sort(), ['clearAdminNotifs', 'clearEmpSchedule', 'editWH', 'fallbackCopy']);
  for (const fn of owners) assert.match(overrides, new RegExp(`^${fn} = `, 'm'), `${fn} is replaced in manager.js`);
});

test('the diagnostics page exists wherever it is linked, and has no inline script', () => {
  const linked = ['public/seller.html', ...fs.readdirSync(path.join(root, 'public/assets')).map(f => 'public/assets/' + f)].some(f => read(f).includes('/manager/diagnostics.html'));
  assert.equal(linked, true);
  const page = read('public/manager/diagnostics.html');
  for (const m of page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) { assert.match(m[1], /src=/); assert.equal(m[2].trim(), ''); }
  for (const m of page.matchAll(/(?:src|href)="(\/manager\/assets\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(root, 'public/assets', m[1].slice(16))), m[1]);
});

test('credentials box: password masked with an eye toggle, copy buttons copy the REAL values, never closes by itself', async () => {
  const d = loadDialogs();
  const done = d.D.credentials('t', { username: 'u_real', password: 'P-real-1' });
  const [user, pass] = d.inputs();
  assert.equal(user.type, 'text'); assert.equal(pass.type, 'password');
  await click(d, '👁 إظهار'); assert.equal(pass.type, 'text');
  await click(d, '🙈 إخفاء'); assert.equal(pass.type, 'password');
  await click(d, 'نسخ اسم المستخدم'); await click(d, 'نسخ كلمة المرور'); await click(d, 'نسخ الاثنين معًا');
  assert.deepEqual(plain(d.log.clipboard), ['u_real', 'P-real-1', 'اسم المستخدم: u_real\nكلمة المرور: P-real-1']);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(d.inputs().length, 2, 'still open: only «تم، حفظتها» closes it');
  await click(d, 'تم، حفظتها'); await done;
  assert.equal(user.value, ''); assert.equal(pass.value, ''); assert.equal(d.inputs().length, 0);
});
