'use strict';
// v6.10 (owner bug, 27 Nov 2026, real phone): on a weekly holiday, 4488 m OUTSIDE the branch, the location box showed only
// "الموقع محدد؛ دقة GPS نحو 14 متر" and NOTHING under it. Cause: the address ran only after a saved check-in.
// Each state below runs the REAL employee-views.js (getGPS + the window state from employeeHome) in node:vm:
// the address (or "near <branch>, <distance> m") must show in EVERY state where a location is shown.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const { createDom, settle } = require('./fake-dom');
const reports = require('../public/assets/report-model');
const KARRADA = { address: { road: '901-27', neighbourhood: 'محلة 901', city_district: 'قضاء الرصافة', city: 'بغداد', state: 'محافظة بغداد' } };
const GEOCODER = { provider: 'nominatim', url: 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat={lat}&lon={lng}&accept-language={lang}', lang: 'ar', credit: '© OpenStreetMap', timeoutMs: 2500, minIntervalMs: 0, cacheMeters: 100 };
const DAY = '2026-11-27', FRIDAY = 5; // 27 Nov 2026 is a Friday
const BRANCH = { lat: 33.3000, lng: 44.4000, radius: 300, enabled: true };
const INSIDE = { lat: 33.3005, lng: 44.4003, accuracy: 14 };
const OUTSIDE = { lat: 33.3000 + (4488 + 300) / 111195, lng: 44.4000, accuracy: 14 }; // 4488 m beyond the branch radius

function phone({ weekendDays = [], onLeave = false, gps = INSIDE, zone = BRANCH, geocoder = GEOCODER, service = 'ok' } = {}) {
  const store = new Map();
  globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    if (service === 'blocked') throw new TypeError('Failed to fetch');
    if (service === 'http') return { ok: false, status: 429 };
    return { ok: true, json: async () => KARRADA };
  };
  delete require.cache[require.resolve('../public/assets/checkin-address')];
  const BasmaAddress = require('../public/assets/checkin-address');
  const dom = createDom();
  dom.Node.prototype.querySelector = function () { return this.__q || (this.__q = new dom.Node()); };
  const get = id => { let n = dom.byId.get(id); if (!n) { n = new dom.Node(); n.id = id; dom.byId.set(id, n); } return n; };
  const document = { ...dom.document, getElementById: get, createTextNode: text => ({ textContent: text }), addEventListener() {} };
  const settings = { weekendDays, checkIn: { from: '00:00', to: '23:59' }, checkOut: { from: '00:00', to: '23:59' } };
  const employee = { name: 'موظف', status: 'approved', credId: 'c1', warehouseId: 'w1', warehouseName: 'الفرع الرئيسي' };
  const home = { serverTime: Date.parse(`${DAY}T12:00:00Z`), date: DAY, employee, info: { timeZone: 'UTC', nameAr: 'شركة', status: 'active' }, settings,
    warehouse: { name: 'الفرع الرئيسي', geoZone: zone }, today: {}, onLeave, device: { status: 'approved' }, geocoder,
    workDays: [0, 1, 2, 3, 4, 5, 6].filter(d => !weekendDays.includes(d)) };
  const clock = { ...require('../public/assets/attendance-clock'), controller: o => require('../public/assets/attendance-clock').controller({ ...o, timers: { setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {} } }) };
  const context = { performance: { now: () => 0 }, BasmaAddress, BasmaReports: reports, BasmaClock: clock, document,
    Basma: { call: async name => (name === 'employeeHome' ? home : { serverTime: home.serverTime }), getGPS: async () => ({ ...gps }), trace() {}, clock: () => 0 },
    DB: { ref: () => ({ orderByChild() { return this; }, equalTo() { return this; }, limitToLast() { return this; }, once: async () => ({ val: () => null }), on() {}, off() {} }) },
    SERVER_TIME_OFFSET: 0, ACTIVATION_UID: 'e1', EMP: { id: 'e1' }, COMPANY_ID: 'c1', COMPANY_INFO: { timeZone: 'UTC' }, SETTINGS: {}, WAREHOUSE_GEO_ZONE: null, WAREHOUSE_SCHEDULE: null, GEO_ZONE_OK: null,
    GPS_DATA: { lat: null, lng: null, accuracy: null }, serverNow: () => new Date(`${DAY}T12:00:00Z`), getEmpSchedule: () => settings, timeToMins: v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3)),
    getDistanceMeters: (lat, lng, toLat, toLng) => BasmaAddress.meters({ lat, lng }, { lat: toLat, lng: toLng }), setProfileStatus() {}, loadNotifPage() {}, loadNotifBadge() {},
    localStorage: globalThis.localStorage, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, Date, Intl, JSON, Math, Number, Object, Promise, String, Array, Error };
  context.window = context; // window.* assignments of the script land on the same global
  context.addEventListener = () => {}; context.dispatchEvent = () => {};
  for (const name of ['checkGeoZone', 'getGPS', 'checkHoliday', 'loadWinStatus', 'loadTodayStats', 'submitExcuse', 'loadHistory']) context[name] = () => {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/assets/employee-views.js'), 'utf8'), context);
  const box = () => { const n = get('gps-address'); return { shown: n.style.display === 'block', text: n.children.map(c => c.textContent).join('') }; };
  return { context, get, box, requests, open: async () => { await context.loadWinStatus(); await context.getGPS(); await settle(20); } };
}

const states = [
  ['inside the branch range, work day', { gps: INSIDE }],
  ['out of range (4488 m), work day', { gps: OUTSIDE }],
  ['weekly holiday (Friday), inside range', { weekendDays: [FRIDAY], gps: INSIDE }],
  ['weekly holiday (Friday) + 4488 m out of range (the owner\'s phone)', { weekendDays: [FRIDAY], gps: OUTSIDE }],
  ['leave day, out of range', { onLeave: true, gps: OUTSIDE }]
];
for (const [name, opts] of states) {
  test(`address box shows the ADDRESS in every state: ${name}`, async () => {
    const p = phone(opts); await p.open();
    assert.match(p.get('gps-text').textContent, /الموقع محدد؛ دقة GPS نحو 14 متر/);
    const b = p.box();
    assert.equal(b.shown, true, 'the address box is visible');
    assert.match(b.text, /قرب 901-27، محلة 901، قضاء الرصافة، بغداد/, `address shown (box: "${b.text}")`);
    assert.match(b.text, /\(الخريطة\)/); assert.match(b.text, /© OpenStreetMap/);
    assert.equal(p.requests.length, 1, 'exactly one request for this place');
    assert.deepEqual(BasmaLast(p), { result: 'success', reason: 'service' });
  });
}
function BasmaLast(p) { const v = p.context.BasmaAddress.lastResult(); return v && { result: v.result, reason: v.reason }; }

test('holiday + 4488 m out of range: the state really is holiday and out of range, and the box never waits for a check-in', async () => {
  const p = phone({ weekendDays: [FRIDAY], gps: OUTSIDE }); await p.open();
  assert.equal(p.context.GEO_ZONE_OK, false, 'out of range');
  assert.equal(p.get('geo-zone-alert').style.display, 'flex', 'the red out-of-range box is shown');
  assert.match(p.get('gz-text').textContent || p.get('geo-zone-alert').querySelector().textContent, /خارج النطاق بمقدار 448\d متر/);
  assert.equal(p.get('btn-checkin').disabled, true, 'check-in is NOT allowed');
  assert.match(p.box().text, /محلة 901/, 'and still the address is shown');
});

test('the box shows the loading text with the distance from the branch AT ONCE, before the service answers', async () => {
  const p = phone({ weekendDays: [FRIDAY], gps: OUTSIDE });
  let release; globalThis.fetch = () => new Promise(r => { release = () => r({ ok: true, json: async () => KARRADA }); });
  await p.context.loadWinStatus(); const gps = p.context.getGPS(); await settle(10);
  assert.match(p.box().text, /جارٍ تحديد العنوان… \(قرب الفرع الرئيسي، 4788 م\) \(الخريطة\)/, `box: "${p.box().text}"`);
  release(); await gps; await settle(10);
  assert.match(p.box().text, /محلة 901/); assert.doesNotMatch(p.box().text, /جارٍ تحديد/);
});

for (const [service, reason] of [['blocked', 'network'], ['http', 'http-429']]) {
  test(`service ${service}: holiday + out of range shows "near <branch>, <distance> m" (fallback) and the diagnostics reason`, async () => {
    const p = phone({ weekendDays: [FRIDAY], gps: OUTSIDE, service }); await p.open();
    assert.match(p.box().text, /^📍 \(قرب الفرع الرئيسي، 4788 م\) \(الخريطة\)$/, `box: "${p.box().text}"`);
    assert.deepEqual(BasmaLast(p), { result: 'fallback', reason });
  });
}

test('no address setting from the server: the fallback distance is still shown (and diagnostics say why)', async () => {
  const p = phone({ weekendDays: [FRIDAY], gps: OUTSIDE, geocoder: null }); await p.open();
  assert.match(p.box().text, /\(قرب الفرع الرئيسي، 4788 م\)/); assert.equal(p.requests.length, 0);
  assert.deepEqual(BasmaLast(p), { result: 'fallback', reason: 'no-config' });
});

test('no branch zone: the box still shows the address (and a map link)', async () => {
  const p = phone({ zone: null, gps: OUTSIDE }); await p.open();
  assert.match(p.box().text, /محلة 901/); assert.match(p.box().text, /\(الخريطة\)/);
});

test('no location (GPS refused): no address box is invented', async () => {
  const p = phone({}); p.context.Basma.getGPS = async () => { throw Object.assign(new Error('الموقع غير مسموح'), { code: 'geo' }); };
  await p.open(); assert.equal(p.box().shown, false); assert.equal(p.requests.length, 0);
});

test('a newer location wins: an old slow answer never overwrites the box', async () => {
  const p = phone({ gps: OUTSIDE }); const answers = [];
  globalThis.fetch = () => new Promise(r => answers.push(() => r({ ok: true, json: async () => KARRADA })));
  await p.context.loadWinStatus();
  const first = p.context.getGPS(); await settle(10);
  p.context.Basma.getGPS = async () => ({ ...INSIDE }); globalThis.fetch = async () => { throw new TypeError('blocked'); };
  await p.context.getGPS(); await settle(10);
  const latest = p.box().text; answers[0](); await first; await settle(10);
  assert.equal(p.box().text, latest, 'the first (older) answer did not replace the newer box');
});
