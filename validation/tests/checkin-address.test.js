'use strict';
// v6.8 (owner, 27 Nov 2026): readable check-in address, looked up on the employee's phone after the check-in.
// The sample answers are the REAL Nominatim answers for Baghdad (Karrada) and Al-Mahmudiyah from 27 Nov 2026.
const test = require('node:test'), assert = require('node:assert/strict');
function fresh() { const m = new Map(); globalThis.localStorage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; delete require.cache[require.resolve('../public/assets/checkin-address.js')]; return require('../public/assets/checkin-address.js'); }
const KARRADA = { address: { road: '901-27', neighbourhood: 'محلة 901', city_district: 'قضاء الرصافة', city: 'بغداد', state: 'محافظة بغداد' } };
const MAHMUDIYAH = { address: { road: 'طريق حلة - بغداد', neighbourhood: 'محلة السراي', town: 'بلدية المحمودية', state: 'محافظة بغداد' } };
const config = { provider: 'nominatim', url: 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat={lat}&lon={lng}&accept-language={lang}', lang: 'ar', credit: '© OpenStreetMap', timeoutMs: 3000, minIntervalMs: 1500, cacheMeters: 100 };

test('short Arabic text from real Nominatim answers: street only as "near", neighbourhood and district, <= 100 characters', () => {
  const A = fresh();
  assert.equal(A.shortText('nominatim', KARRADA), 'قرب 901-27، محلة 901، قضاء الرصافة، بغداد');
  assert.equal(A.shortText('nominatim', MAHMUDIYAH), 'قرب طريق حلة - بغداد، محلة السراي، بلدية المحمودية');
  assert.ok(A.shortText('nominatim', { address: { road: 'x'.repeat(200) } }).length <= 100);
  assert.equal(A.shortText('nominatim', { address: { road: '<b>' } }), 'قرب b', 'no markup');
});

test('one request per check-in; the same place (within 100 m) again = phone cache, NO request', async () => {
  const A = fresh(), calls = [];
  const fetchFn = async url => { calls.push(url); return { ok: true, json: async () => KARRADA }; };
  const first = await A.lookup(config, { lat: 33.30412, lng: 44.42171 }, { fetchFn, wait: async () => {} });
  assert.equal(first.source, 'service'); assert.equal(calls.length, 1);
  assert.match(calls[0], /lat=33\.3041&lon=44\.4217&accept-language=ar/, 'only the point (rounded, ~11 m) and the language are sent');
  const again = await A.lookup(config, { lat: 33.3046, lng: 44.4219 }, { fetchFn, wait: async () => {} }); // ~60 m away
  assert.equal(again.source, 'cache'); assert.equal(calls.length, 1, 'no second request');
  await A.lookup(config, { lat: 33.3100, lng: 44.4217 }, { fetchFn, wait: async () => {} }); // ~650 m away
  assert.equal(calls.length, 2, 'a different place is looked up');
});

test('slow, blocked or failing service: null (the page shows the distance from the branch), never an error', async () => {
  const A = fresh();
  assert.equal(await A.lookup(config, { lat: 33.3, lng: 44.4 }, { fetchFn: async () => { throw new TypeError('blocked'); }, wait: async () => {} }), null);
  assert.equal(await A.lookup(config, { lat: 33.31, lng: 44.4 }, { fetchFn: async () => ({ ok: false, status: 429 }), wait: async () => {} }), null);
  const slow = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t = Date.now(); assert.equal(await A.lookup({ ...config, timeoutMs: 200 }, { lat: 33.32, lng: 44.4 }, { fetchFn: slow, wait: async () => {} }), null);
  assert.ok(Date.now() - t < 1500, 'gives up after the timeout');
});

test('requests from one phone are spaced (at least minIntervalMs)', async () => {
  const A = fresh(), waits = []; let clock = 10_000;
  const fetchFn = async () => ({ ok: true, json: async () => KARRADA });
  await A.lookup(config, { lat: 33.3, lng: 44.4 }, { fetchFn, now: () => clock, wait: async ms => waits.push(ms) });
  clock += 200; await A.lookup(config, { lat: 33.4, lng: 44.4 }, { fetchFn, now: () => clock, wait: async ms => waits.push(ms) });
  assert.deepEqual(waits, [1300]);
});

test('manager view: the address if saved, else "near <branch>, <distance> m"; always a map link to the exact point', () => {
  const A = fresh(), branch = { name: 'الفرع الرئيسي', geoZone: { lat: 33.3041, lng: 44.4217, radius: 300 } };
  const withText = A.place({ lat: 33.3041, lng: 44.4217, address: { text: 'قرب 901-27، محلة 901، قضاء الرصافة، بغداد', lang: 'ar' } }, branch);
  assert.equal(withText.text, 'قرب 901-27، محلة 901، قضاء الرصافة، بغداد'); assert.equal(withText.credit, '© OpenStreetMap');
  assert.equal(withText.href, 'https://www.openstreetmap.org/?mlat=33.3041&mlon=44.4217#map=18/33.3041/44.4217');
  const without = A.place({ lat: 33.3050, lng: 44.4217 }, branch);
  assert.equal(without.text, 'قرب الفرع الرئيسي، 100 م'); assert.equal(without.credit, '');
  assert.ok(without.href);
});
