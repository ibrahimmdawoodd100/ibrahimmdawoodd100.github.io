'use strict';
// Runs the GENERATED public/{manager,employee}/sw.js with a fake service-worker global.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const plain = v => JSON.parse(JSON.stringify(v));
function load(page) {
  const handlers = {}, stores = new Map([['basma-shell-' + page + '-old', new Map()], ['basma-manager-v1', new Map()], ['golden-cart-v3', new Map()]]), fetched = [];
  class Req { constructor(url, init = {}) { this.url = new URL(url, 'https://ibrahimmdawoodd100.github.io').href; this.cache = init.cache; this.method = init.method || 'GET'; this.mode = init.mode || 'cors'; } }
  // Per-cache put/match (v5.16 install reuses unchanged files by their content hash).
  class Headers { constructor(init) { this.m = new Map(init instanceof Headers ? init.m : Object.entries(init || {})); } get(k) { return this.m.get(k) ?? null; } set(k, v) { this.m.set(k, v); } }
  class Response { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.statusText = init.statusText ?? 'OK'; this.headers = init.headers || new Headers(); this.ok = this.status < 400; } async blob() { return this.body; } }
  const caches = {
    open: async name => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name); return {
      put: async (url, response) => { m.set(url, { marker: 'cached:' + url, hash: response.headers.get('x-basma-hash') }); },
      match: async url => { const v = m.get(url); return v ? { headers: new Headers({ 'x-basma-hash': v.hash }) } : undefined; }
    }; },
    keys: async () => [...stores.keys()], delete: async name => stores.delete(name),
    match: async (key, { cacheName }) => stores.get(cacheName)?.get(key)?.marker || undefined
  };
  const self = { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} }, location: { origin: 'https://ibrahimmdawoodd100.github.io' } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', page, 'sw.js'), 'utf8'), { self, caches, Request: Req, URL, Headers, Response, console,
    fetch: async r => { if (r.cache) fetched.push([new URL(r.url).pathname, r.cache]); return r.cache ? new Response('network:' + new URL(r.url).pathname) : 'network:' + new URL(r.url).pathname; } });
  const SHELL = vm.runInNewContext(fs.readFileSync(path.join(root, 'public', page, 'sw.js'), 'utf8').replace(/async function previous[\s\S]*$/, '') + ';SHELL', { self, caches, Request: Req, URL });
  const FILES = vm.runInNewContext(fs.readFileSync(path.join(root, 'public', page, 'sw.js'), 'utf8').replace(/async function previous[\s\S]*$/, '') + ';FILES', { self, caches, Request: Req, URL });
  const run = async (type, extra = {}) => { let wait; handlers[type]({ waitUntil: p => { wait = p; }, ...extra }); await wait; };
  const fetchEvent = async (url, init = {}) => { let responded = null; handlers.fetch({ request: new Req(url, init), respondWith: p => { responded = p; } }); return responded ? await responded : 'NOT INTERCEPTED'; };
  return { stores, fetched, run, fetchEvent, SHELL, FILES };
}
for (const page of ['manager', 'employee']) {
  test(`${page} service worker: install caches exactly the shell (fresh from network), activate deletes only old Basma caches`, async () => {
    const h = load(page);
    await h.run('install');
    assert.ok(h.SHELL.includes(`/${page}/`) && h.SHELL.includes('/manager/assets/core.js') && h.SHELL.includes('/manager/assets/config.js'));
    assert.deepEqual(plain(h.fetched.map(f => f[0]).sort()), plain([...h.SHELL].sort()));
    assert.ok(h.fetched.every(f => f[1] === 'reload'), 'install bypasses the HTTP cache');
    await h.run('activate');
    const names = [...h.stores.keys()];
    assert.equal(names.filter(n => n.startsWith('basma-')).length, 1, 'only the current Basma cache is left');
    assert.ok(names.includes('golden-cart-v3'), 'never touches another app\'s cache');
  });
  test(`${page} service worker: shell from cache first; data, POST, other origins and non-shell files untouched`, async () => {
    const h = load(page); await h.run('install'); await h.run('activate');
    assert.equal(await h.fetchEvent(`https://ibrahimmdawoodd100.github.io/${page}/`, { mode: 'navigate' }), `cached:/${page}/`);
    assert.equal(await h.fetchEvent(`https://ibrahimmdawoodd100.github.io/${page}/index.html?v=2`), `cached:/${page}/`);
    assert.equal(await h.fetchEvent('https://ibrahimmdawoodd100.github.io/manager/assets/core.js?v=9'), 'cached:/manager/assets/core.js');
    assert.equal(await h.fetchEvent('https://us-central1-signature-7706e.cloudfunctions.net/managerHome', { method: 'POST' }), 'NOT INTERCEPTED');
    assert.equal(await h.fetchEvent('https://signature-7706e-default-rtdb.firebaseio.com/.lp?start=t'), 'NOT INTERCEPTED');
    assert.equal(await h.fetchEvent('https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js'), 'NOT INTERCEPTED');
    assert.equal(await h.fetchEvent('https://ibrahimmdawoodd100.github.io/manager/diagnostics.html'), 'NOT INTERCEPTED');
    assert.equal(await h.fetchEvent('https://ibrahimmdawoodd100.github.io/.well-known/assetlinks.json'), 'NOT INTERCEPTED');
    assert.equal(await h.fetchEvent('https://ibrahimmdawoodd100.github.io/manager/assets/core.js', { method: 'POST' }), 'NOT INTERCEPTED');
  });
}
test('cache miss falls back to the network', async () => {
  const h = load('manager');
  assert.equal(await h.fetchEvent('https://ibrahimmdawoodd100.github.io/manager/assets/core.js'), 'network:/manager/assets/core.js');
});
test('only the manager and employee pages register a service worker, each in its own scope; never the seller (site root)', () => {
  const src = fs.readFileSync(path.join(root, 'public/assets/core.js'), 'utf8');
  const registered = [];
  for (const role of ['seller', 'manager', 'employee']) {
    const navigator = { serviceWorker: { register: (url, opts) => { registered.push([role, url, opts.scope]); return Promise.resolve(); } } };
    const window = { BASMA_CONFIG: { firebase: {}, appCheckSiteKey: 'k', region: 'r' } };
    const app = { auth: () => ({ setPersistence: async () => {}, onAuthStateChanged: fn => { queueMicrotask(fn); return () => {}; } }), appCheck: () => ({ activate() {} }) };
    const firebase = { apps: [], initializeApp: () => app, appCheck: { ReCaptchaEnterpriseProvider: class {} }, auth: { Auth: { Persistence: { SESSION: 's', LOCAL: 'l' } } } };
    vm.runInNewContext(src, { window, navigator, firebase, console, setTimeout, clearTimeout, queueMicrotask, document: {}, location: {} });
    window.Basma.init(role);
  }
  assert.deepEqual(registered, [['manager', '/manager/sw.js', '/manager/'], ['employee', '/employee/sw.js', '/employee/']]);
  assert.equal(fs.existsSync(path.join(root, 'public/sw.js')), false);
});

test('a new release downloads only CHANGED shell files; unchanged ones are copied from the previous cache', async () => {
  const h = load('manager'), old = h.stores.get('basma-shell-manager-old');
  const changed = '/manager/assets/core.js';
  for (const url of h.SHELL) old.set(url, { marker: 'old:' + url, hash: url === changed ? 'stale-hash' : h.FILES[url] });
  await h.run('install');
  assert.deepEqual(plain(h.fetched), [[changed, 'reload']], 'only the changed file came from the network');
  const fresh = [...h.stores.keys()].find(n => n.startsWith('basma-shell-manager-') && !n.endsWith('-old'));
  assert.equal(h.stores.get(fresh).size, h.SHELL.length, 'the new cache is complete');
});
