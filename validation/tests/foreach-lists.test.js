'use strict';
// Firebase DataSnapshot.forEach STOPS when the callback returns a truthy value. `c => list.push(...)`
// returns the new length, so such loaders showed only the FIRST item. These tests keep it fixed.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const pages = ['public/seller.html', 'public/manager/index.html', 'public/employee/index.html', ...fs.readdirSync(path.join(root, 'public/assets')).map(f => 'public/assets/' + f)];
const bad = /\.forEach\(\s*\(?\s*[A-Za-z_$][\w$]*\s*\)?\s*=>\s*[A-Za-z_$][\w$.]*\.push\(/;

test('no page uses forEach(c => list.push(...)) on a database snapshot', () => {
  const hits = [];
  for (const file of pages) fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, i) => { if (bad.test(line) && !/^\s*\/\//.test(line)) hits.push(`${file}:${i + 1}`); });
  assert.deepEqual(hits, []);
});

// Same behaviour as the real SDK: stop on a truthy return.
const fakeSnap = obj => ({ forEach(action) { for (const [key, value] of Object.entries(obj)) if (action({ key, val: () => value })) return true; return false; } });
function extract(file, name) {
  const src = fs.readFileSync(path.join(root, file), 'utf8'), start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}\n', start) + 2);
}
function dom() {
  const byId = new Map();
  class Node { constructor(tag) { this.tag = tag; this.children = []; this.innerHTML = ''; this.textContent = ''; this.value = ''; this.className = ''; }
    appendChild(c) { this.children.push(c); return c; } replaceChildren(...c) { this.children = c; } }
  for (const id of ['msg-emp-select', 'sent-messages-list']) byId.set(id, new Node('div'));
  return { byId, document: { getElementById: id => byId.get(id) || null, createElement: tag => new Node(tag) } };
}

test('manager loadMessages lists ALL sent messages, newest first', async () => {
  const d = dom();
  const data = { m1: { empId: 'e1', message: 'أ', createdAt: 1 }, m2: { empId: 'e1', message: 'ب', createdAt: 3 }, m3: { empId: 'e1', message: 'ج', createdAt: 2 } };
  const ctx = { document: d.document, window: {}, COMPANY_ID: 'c1', ALL_EMPLOYEES: {}, Date, Object,
    DB: { ref: p => ({ once: async () => (p.endsWith('/employees') ? { val: () => ({ e1: { name: 'E', status: 'approved' } }) } : fakeSnap(data)) }) } };
  vm.runInNewContext(extract('public/manager/index.html', 'loadMessages') + '\nthis.run = loadMessages;', ctx);
  await ctx.run();
  const items = d.byId.get('sent-messages-list').children;
  assert.equal(items.length, 3, 'all three messages, not only the first');
  assert.deepEqual(items.map(i => /msg-body">(.)</.exec(i.innerHTML)[1]), ['ب', 'ج', 'أ']);
});

test('manager loadMessages shows a clear error instead of an endless spinner', async () => {
  const d = dom();
  const ctx = { document: d.document, window: { BasmaErrors: { message: () => 'السبب' } }, COMPANY_ID: 'c1', ALL_EMPLOYEES: {}, Date, Object,
    DB: { ref: p => ({ once: async () => { if (p.endsWith('/employees')) return { val: () => ({}) }; throw Error('denied'); } }) } };
  vm.runInNewContext(extract('public/manager/index.html', 'loadMessages') + '\nthis.run = loadMessages;', ctx);
  await ctx.run();
  const box = d.byId.get('sent-messages-list').children[0];
  assert.equal(box.textContent, 'تعذر تحميل الرسائل. السبب');
});
