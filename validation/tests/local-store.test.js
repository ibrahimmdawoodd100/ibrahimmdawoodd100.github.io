'use strict';
// v6.0 local storage on the manager's device: signed sync, encryption at rest, logout keeps data but removes the key,
// tamper refusal, encrypted backup export/import. Uses the real Web Crypto of Node 22 and a fake server that signs
// exactly like functions/index.js (Ed25519 over "cid\ncollection\nid\nstable(value)").
const test = require('node:test'), assert = require('node:assert/strict');
const { generateKeyPairSync, sign, randomBytes } = require('node:crypto');
const L = require('../public/assets/local-store.js');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
function server({ cid = 'c1', today = '2026-12-20', data = {} } = {}) {
  const storeKey = randomBytes(32).toString('base64'), calls = [];
  const signed = (col, id, d) => ({ d, s: sign(null, Buffer.from(`${cid}\n${col}\n${id}\n${L.stable(d)}`), privateKey).toString('base64') });
  const field = { records: 'dateKey', leaves: 'date', excuses: 'date' };
  const keys = { companyId: cid, publicKey: PUB, storeKey, keepDays: 45, purgeStart: '2026-12-10', cutoff: '2026-11-05', today };
  const page = (col, from) => { const f = from === 'mailbox' ? '2026-11-03' : from; const rows = Object.entries(data[col] || {}).filter(([, v]) => col === 'payroll' || !f || v[field[col]] >= f); return { items: Object.fromEntries(rows.map(([id, v]) => [id, signed(col, id, v)])), next: null }; };
  const call = async (name, req) => {
    calls.push(req);
    if (req.kind === 'syncKeys') return keys;
    if (req.kind === 'syncAll') return { keys, pages: Object.fromEntries(['records', 'leaves', 'excuses', 'payroll'].map(c => [c, page(c, req.from?.[c])])) };
    return page(req.collection, req.from);
  };
  return { call, calls, signed, storeKey };
}
const data = {
  records: { r1: { empId: 'e1', type: 'in', dateKey: '2026-10-01', timestamp: '2026-10-01T08:00:00Z' }, r2: { empId: 'e1', type: 'in', dateKey: '2026-12-19', timestamp: '2026-12-19T08:00:00Z' } },
  leaves: { l1: { empId: 'e1', date: '2026-12-22', status: 'pending', leaveType: 'paid' } }, excuses: {}, payroll: { '2026-10': { month: '2026-10', rows: [{ employeeId: 'e1', net: 900 }] } }
};

test('first sync pulls everything still on the server, verifies it, stores it ENCRYPTED, and reads back by date', async () => {
  const backend = L.memoryBackend(), srv = server({ data }), local = L.create({ call: srv.call, backend });
  const out = await local.sync();
  assert.equal(out.stored, 4); assert.deepEqual(out.rejected, []);
  assert.equal(srv.calls.length, 1, 'one call per open'); assert.equal(srv.calls[0].from.records, null, 'first sync: from the beginning'); assert.equal(srv.calls[0].ack, null);
  const raw = [...backend.stores.items.values()];
  assert.ok(raw.every(r => r.ct && r.iv && r.verified === true)); const flat = JSON.stringify(raw); for (const word of ['empId', 'timestamp', 'leaveType', 'net']) assert.ok(!flat.includes(word), `no plain ${word} at rest`); // only the date stays plain (for date ranges)
  assert.deepEqual(Object.keys(await local.range('records', '2026-12-01', '2026-12-31')), ['r2']);
  assert.equal((await local.range('payroll', '2026-10-01', '2026-10-01'))['2026-10'].rows[0].net, 900, 'closed-month payroll kept on the device');
  const stats = await local.stats(); assert.equal(stats.counts.records, 2); assert.equal(stats.syncedTo, '2026-12-20');
});

test('next sync is incremental: records from the last pulled date minus 1 day; leaves/excuses for the 45-day mailbox', async () => {
  const backend = L.memoryBackend(), srv = server({ data }), local = L.create({ call: srv.call, backend });
  await local.sync(); srv.calls.length = 0; await local.sync();
  assert.equal(srv.calls.length, 1); assert.equal(srv.calls[0].from.records, '2026-12-19'); assert.equal(srv.calls[0].from.leaves, 'mailbox');
  assert.equal(srv.calls[0].ack.syncedTo, '2026-12-20', 'the last pull is acknowledged in the same call');
});

test('a changed or unsigned item from the server is refused (no attendance editing)', async () => {
  const backend = L.memoryBackend(), srv = server({ data }), tampered = async (name, req) => {
    const res = await srv.call(name, req);
    if (req.kind === 'syncAll') { const it = res.pages.records.items; it.r2 = { ...it.r2, d: { ...it.r2.d, type: 'out' } }; it.r9 = { d: { dateKey: '2026-12-19' } }; }
    return res;
  };
  const out = await L.create({ call: tampered, backend }).sync();
  assert.deepEqual(out.rejected.sort(), ['records/r2', 'records/r9']);
});

test('logout removes the key but keeps the data; it opens again after the manager signs in', async () => {
  const backend = L.memoryBackend(), srv = server({ data }), local = L.create({ call: srv.call, backend });
  await local.sync(); await local.lock();
  assert.equal(backend.stores.keys.size, 0); assert.equal(backend.stores.items.size, 4, 'data kept');
  await assert.rejects(local.range('records', '2026-01-01', '2026-12-31'), /مقفلة/);
  await local.unlock(); assert.equal(Object.keys(await local.range('records', '2026-01-01', '2026-12-31')).length, 2);
});

test('encrypted backup: export, then import into a new phone; wrong password, other company and forged items refused', async () => {
  const srv = server({ data }), a = L.create({ call: srv.call, backend: L.memoryBackend() });
  await a.sync();
  await assert.rejects(a.exportBackup('short'), /8 أحرف/);
  const file = await a.exportBackup('كلمة-سر-قوية');
  assert.equal(file.format, 'basma-backup-v1'); assert.equal(file.count, 4); assert.ok(!JSON.stringify(file).includes('2026-10-01'), 'backup content is encrypted');
  assert.ok((await a.meta()).lastBackupAt, 'backup time remembered');
  const b = L.create({ call: srv.call, backend: L.memoryBackend() }); await b.unlock();
  await assert.rejects(b.importBackup(file, 'خطأ-خطأ-خطأ'), /كلمة السر غير صحيحة/);
  const res = await b.importBackup(file, 'كلمة-سر-قوية'); assert.equal(res.imported, 4); assert.deepEqual(res.rejected, []);
  assert.equal((await b.range('records', '2026-10-01', '2026-10-01')).r1.type, 'in');
  const other = L.create({ call: server({ cid: 'c2', data }).call, backend: L.memoryBackend() }); await other.unlock();
  await assert.rejects(other.importBackup(file, 'كلمة-سر-قوية'), /لشركة أخرى/);
  // A forged backup (valid encryption, changed record) is refused item by item.
  const forgedSrc = L.create({ call: async (n, r) => { const x = await srv.call(n, r); if (r.kind === 'syncAll') x.pages.records.items.r1.d.type = 'out'; return x; }, backend: L.memoryBackend(), subtle: { ...globalThis.crypto.subtle, importKey: (...args) => (args[2]?.name === 'Ed25519' ? Promise.reject(Error('no')) : globalThis.crypto.subtle.importKey(...args)), encrypt: (...a) => globalThis.crypto.subtle.encrypt(...a), decrypt: (...a) => globalThis.crypto.subtle.decrypt(...a), deriveKey: (...a) => globalThis.crypto.subtle.deriveKey(...a), verify: (...a) => globalThis.crypto.subtle.verify(...a) } });
  await forgedSrc.sync(); const forged = await forgedSrc.exportBackup('كلمة-سر-قوية');
  const c = L.create({ call: srv.call, backend: L.memoryBackend() }); await c.unlock();
  const r2 = await c.importBackup(forged, 'كلمة-سر-قوية'); assert.deepEqual(r2.rejected, ['records/r1']); assert.equal(r2.imported, 3);
});

test('a collection with more than one page is completed with follow-up page calls from the same date', async () => {
  const srv = server({ data }), paged = async (name, req) => {
    const res = await srv.call(name, req);
    if (req.kind === 'syncAll') { const { r2, ...first } = res.pages.records.items; res.pages.records = { items: first, next: { date: '2026-10-01', key: 'r1' } }; }
    if (req.kind === 'sync') return { items: { r2: (await srv.call(name, { kind: 'syncAll', from: {} })).pages.records.items.r2 }, next: null };
    return res;
  };
  const local = L.create({ call: paged, backend: L.memoryBackend() });
  assert.equal((await local.sync()).stored, 4); assert.equal(srv.calls.filter(c => c.kind === 'sync').length, 1, 'one follow-up page call');
  assert.deepEqual(Object.keys(await local.range('records', '2026-01-01', '2026-12-31')).sort(), ['r1', 'r2']);
});
