'use strict';
// Real public/assets/core.js controls() against a small DOM fake: the account menu replaces the floating bottom bar.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../public/assets/core.js'), 'utf8');
function harness({ withHeader = true } = {}) {
  const listeners = {}, byId = new Map();
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attrs = {}; this.hidden = false; this.textContent = ''; this.parent = null; this.handlers = {}; }
    appendChild(c) { c.parent = this; this.children.push(c); if (c.id) byId.set(c.id, c); return c; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); byId.delete(this.id); }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, f) { this.handlers[t] = f; } contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
    querySelector(sel) { const all = (n, o = []) => { n.children.forEach(c => { o.push(c); all(c, o); }); return o; }; return sel === 'button' ? all(this).find(n => n.tag === 'button') || null : null; }
    getBoundingClientRect() { return { left: 300, right: 338, top: 10, bottom: 48 }; } get offsetWidth() { return 190; } focus() {}
    set id(v) { this._id = v; } get id() { return this._id; }
  }
  const body = new Node('body'), header = new Node('div'); if (withHeader) body.appendChild(header);
  const document = { body, getElementById: id => byId.get(id) || null, createElement: t => new Node(t), querySelector: sel => (withHeader && sel.includes('.top-header > div:last-child') ? header : null),
    addEventListener: (t, f) => { (listeners[t] ??= []).push(f); }, removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter(x => x !== f); } };
  const calls = [];
  const window = { innerWidth: 360, addEventListener() {}, removeEventListener() {}, BASMA_CONFIG: {} };
  vm.runInNewContext(source, { window, document, console, setTimeout, clearTimeout, location: { reload: () => calls.push('reload') }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, CustomEvent: class {} });
  window.dispatchEvent = () => {};
  return { Basma: window.Basma, document, body, header, byId, listeners, calls, fire: (t, e) => (listeners[t] || []).forEach(f => f(e)) };
}
const findText = (node, text) => { if (node.textContent === text) return node; for (const c of node.children) { const r = findText(c, text); if (r) return r; } return null; };

test('no floating bottom bar: one 👤 button inside the header, menu closed at first', () => {
  const h = harness(); h.Basma.controls();
  assert.equal(h.byId.get('basma-controls'), undefined, 'old fixed bar is gone');
  const button = h.byId.get('basma-account-btn');
  assert.equal(button.parent, h.header, 'inside the page header'); assert.equal(button.textContent, '👤');
  assert.notEqual(button.style.position, 'fixed');
  const menu = h.byId.get('basma-account-menu'); assert.equal(menu.hidden, true);
  assert.equal(menu.style.bottom, undefined, 'nothing anchored to the bottom');
  assert.ok(findText(menu, 'تغيير كلمة المرور') && findText(menu, 'خروج'));
  assert.match(findText(menu, 'خروج').style.color, /red/, 'logout in red');
});
test('the menu opens on tap and closes on Escape and on a tap outside', () => {
  const h = harness(); h.Basma.controls();
  const button = h.byId.get('basma-account-btn'), menu = h.byId.get('basma-account-menu');
  button.handlers.click({}); assert.equal(menu.hidden, false); assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.style.top, '56px', 'just below the header button');
  h.fire('keydown', { key: 'Escape' }); assert.equal(menu.hidden, true);
  button.handlers.click({}); assert.equal(menu.hidden, false);
  h.fire('pointerdown', { target: h.body }); assert.equal(menu.hidden, true);
  button.handlers.click({}); h.fire('pointerdown', { target: findText(menu, 'خروج') }); assert.equal(menu.hidden, false, 'a tap inside does not close');
});
test('«خروج» keeps the same logout handler; rebuilding the menu leaves one set of listeners', async () => {
  const h = harness(); h.Basma.controls(); h.Basma.controls();
  assert.equal(h.listeners.pointerdown.length, 1); assert.equal(h.listeners.keydown.length, 1);
  const menu = h.byId.get('basma-account-menu');
  h.byId.get('basma-account-btn').handlers.click({}); findText(menu, 'خروج').handlers.click({});
  await new Promise(r => setTimeout(r, 5));
  assert.equal(menu.hidden, true); assert.deepEqual(h.calls, ['reload'], 'logout ran (it ends with a reload)');
});
test('a screen without a header gets the button at the TOP, never at the bottom', () => {
  const h = harness({ withHeader: false }); h.Basma.controls();
  const button = h.byId.get('basma-account-btn');
  assert.equal(button.parent, h.body); assert.equal(button.style.position, 'fixed');
  assert.match(button.style.top, /safe-area-inset-top/); assert.equal(button.style.bottom, undefined);
});
