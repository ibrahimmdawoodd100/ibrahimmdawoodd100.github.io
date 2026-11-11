'use strict';
// Minimal DOM fixture for running the real page scripts in node:vm (not a browser).
function createDom(ids = []) {
  const byId = new Map();
  class Node {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.value = ''; this.textContent = ''; this.className = ''; this.disabled = false; this.parent = null; this.classList = { add() {}, remove() {} }; }
    set innerHTML(_) { throw Error('scripts under test must not write raw HTML'); }
    appendChild(child) { child.parent = this; this.children.push(child); if (child.id) byId.set(child.id, child); return child; }
    append(...children) { children.forEach(c => this.appendChild(c)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    focus() {} select() {} setAttribute() {}
  }
  const body = new Node('body');
  for (const id of ids) { const n = new Node(); n.id = id; byId.set(id, n); }
  const document = { getElementById: id => byId.get(id) || null, createElement: tag => new Node(tag), body, execCommand: () => false };
  const all = (node = body, out = []) => { out.push(node); node.children.forEach(c => all(c, out)); return out; };
  const button = label => all().find(n => n.tag === 'button' && n.textContent === label);
  const inputs = () => all().filter(n => n.tag === 'input');
  const texts = () => all().map(n => `${n.textContent} ${n.value}`).join('\n');
  return { Node, body, byId, document, all, button, inputs, texts };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
const plain = value => JSON.parse(JSON.stringify(value));
module.exports = { createDom, tick, settle, plain };
