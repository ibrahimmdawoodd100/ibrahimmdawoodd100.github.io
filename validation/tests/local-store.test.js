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
  const changes = []; let clock = 1000; // fake change list: [{at, col, id}]
  const change = (col, id, value) => { data[col] = { ...data[col], [id]: value }; changes.push({ at: ++clock, col, id }); };
  const call = async (name, req) => {
    calls.push(req);
    if (state.offline) throw Object.assign(Error('offline'), { code: 'functions/unavailable' });
    if (req.kind === 'syncKeys') return keys;
    if (req.kind === 'syncAll') {
      if (!req.cursor) return { keys, full: true, cursor: { at: clock }, pages: Object.fromEntries(['records', 'leaves', 'excuses', 'payroll'].map(c => [c, page(c, null)])) };
      const since = changes.filter(c => c.at > req.cursor.at), pages = {};
      for (const c of ['records', 'leaves', 'excuses', 'payroll']) { const ids = since.filter(x => x.col === c).map(x => x.id); pages[c] = { items: Object.fromEntries(ids.map(id => [id, signed(c, id, data[c][id])])), next: null }; }
      return { keys, full: false, more: false, cursor: { at: since.at(-1)?.at ?? req.cursor.at }, pages };
    }
    return page(req.collection, req.from);
  };
  const state = { offline: false };
  return { call, calls, signed, storeKey, change, state };
}
const data = {
  records: { r1: { empId: 'e1', type: 'in', dateKey: '2026-10-01', timestamp: '2026-10-01T08:00:00Z' }, r2: { empId: 'e1', type: 'in', dateKey: '2026-12-19', timestamp: '2026-12-19T08:00:00Z' } },
  leaves: { l1: { empId: 'e1', date: '2026-12-22', status: 'pending', leaveType: 'paid' } }, excuses: {}, payroll: { '2026-10': { month: '2026-10', rows: [{ employeeId: 'e1', net: 900 }] } }
};

test('first sync pulls everything still on the server, verifies it, stores it ENCRYPTED, and reads back by date', async () => {
  const backend = L.memoryBackend(), srv = server({ data }), local = L.create({ call: srv.call, backend });
  const out = await local.sync();
  assert.equal(out.stored, 4); assert.deepEqual(out.rejected, []);
  assert.equal(srv.calls.length, 1, 'one call per open'); assert.equal(srv.calls[0].cursor, null, 'first sync on a phone: full'); assert.equal(out.full, true);
  const raw = [...backend.stores.items.values()];
  assert.ok(raw.every(r => r.ct && r.iv && r.verified === true)); const flat = JSON.stringify(raw); for (const word of ['empId', 'timestamp', 'leaveType', 'net']) assert.ok(!flat.includes(word), `no plain ${word} at rest`); // only the date stays plain (for date ranges)
  assert.deepEqual(Object.keys(await local.range('records', '2026-12-01', '2026-12-31')), ['r2']);
  assert.equal((await local.range('payroll', '2026-10-01', '2026-10-01'))['2026-10'].rows[0].net, 900, 'closed-month payroll kept on the device');
  const stats = await local.stats(); assert.equal(stats.counts.records, 2); assert.equal(stats.syncedTo, '2026-12-20');
});

test('next syncs are incremental: only items new or changed since the last successful sync', async () => {
  const backend = L.memoryBackend(), srv = server({ data: JSON.parse(JSON.stringify(data)) }), local = L.create({ call: srv.call, backend });
  await local.sync(); srv.calls.length = 0;
  const nothing = await local.sync();
  assert.equal(srv.calls.length, 1); assert.equal(nothing.full, false); assert.equal(nothing.stored, 0, 'nothing changed = nothing downloaded');
  srv.change('records', 'r3', { empId: 'e1', type: 'out', dateKey: '2026-12-20', timestamp: '2026-12-20T16:00:00Z' });
  srv.change('leaves', 'l1', { empId: 'e1', date: '2026-12-22', status: 'approved', leaveType: 'paid' });
  const two = await local.sync();
  assert.equal(two.stored, 2, 'only the new record and the changed leave');
  assert.equal((await local.range('leaves', '2026-12-22', '2026-12-22')).l1.status, 'approved', 'the change replaced the old state');
  assert.equal((await local.stats()).counts.records, 3);
});

test('offline: the sync fails with an error, the cursor does not move, and the next open catches up', async () => {
  const backend = L.memoryBackend(), srv = server({ data: JSON.parse(JSON.stringify(data)) }), local = L.create({ call: srv.call, backend });
  await local.sync(); const before = await local.meta();
  srv.change('records', 'r4', { empId: 'e1', type: 'in', dateKey: '2026-12-21', timestamp: '2026-12-21T08:00:00Z' });
  srv.state.offline = true;
  await assert.rejects(local.sync(), /offline/);
  assert.deepEqual((await local.meta()).cursor, before.cursor, 'cursor unchanged after a failed sync');
  assert.equal(Object.keys(await local.range('records', '2026-01-01', '2026-12-31')).length, 2, 'the device copy is still readable');
  srv.state.offline = false;
  assert.equal((await local.sync()).stored, 1, 'retry on the next open gets the missed record');
});

test('two manager phones each keep their own cursor: no conflict, both get every change', async () => {
  const srv = server({ data: JSON.parse(JSON.stringify(data)) }), a = L.create({ call: srv.call, backend: L.memoryBackend() }), b = L.create({ call: srv.call, backend: L.memoryBackend() });
  await a.sync(); srv.change('records', 'r5', { empId: 'e1', type: 'in', dateKey: '2026-12-22', timestamp: '2026-12-22T08:00:00Z' });
  await b.sync(); await a.sync(); srv.change('records', 'r6', { empId: 'e1', type: 'out', dateKey: '2026-12-22', timestamp: '2026-12-22T16:00:00Z' });
  await a.sync(); await b.sync();
  for (const phone of [a, b]) assert.deepEqual(Object.keys(await phone.range('records', '2026-12-22', '2026-12-22')).sort(), ['r5', 'r6']);
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

// v6.3 (owner, 25 Nov 2026): backup WITHOUT password. Import is all-or-nothing and only adds.
test('backup export: a plain file, no password; the company ID, a count and an integrity check are inside', async () => {
  const a = L.create({ call: server({ data }).call, backend: L.memoryBackend() }); await a.sync();
  const file = await a.exportBackup();
  assert.equal(file.format, 'basma-backup-v2'); assert.equal(file.companyId, 'c1'); assert.equal(file.count, 4); assert.equal(file.items.length, 4);
  assert.equal(file.integrity.algorithm, 'SHA-256'); assert.match(file.integrity.value, /^[0-9a-f]{64}$/);
  assert.ok(file.items.every(x => typeof x.s === 'string'), 'every item keeps the server signature');
  assert.ok((await a.meta()).lastBackupAt, 'the red box can hide after the first export');
});

test('import on another phone of the SAME company: everything is added, no password needed', async () => {
  const srv = server({ data }), a = L.create({ call: srv.call, backend: L.memoryBackend() }); await a.sync();
  const file = JSON.parse(JSON.stringify(await a.exportBackup())); // through a real file (JSON text)
  const b = L.create({ call: srv.call, backend: L.memoryBackend() }); await b.unlock();
  assert.equal(b.needsPassword(file), false);
  const res = await b.importBackup(file); assert.equal(res.imported, 4); assert.equal(res.kept, 0);
  assert.equal((await b.range('records', '2026-10-01', '2026-10-01')).r1.type, 'in');
});

test('import of ANOTHER company\'s file is rejected completely: clear Arabic message, nothing added', async () => {
  const a = L.create({ call: server({ data }).call, backend: L.memoryBackend() }); await a.sync();
  const file = await a.exportBackup(); // company c1
  const bk = L.memoryBackend(), other = L.create({ call: server({ cid: 'c2', data: {} }).call, backend: bk }); await other.unlock();
  await assert.rejects(other.importBackup(file), e => /لشركة أخرى/.test(e.message) && /لم يُستورد أي شيء/.test(e.message));
  assert.equal(bk.stores.items.size, 0, 'nothing added');
  // Changing only the company ID inside the file does not help: the integrity check (and the signatures) refuse it.
  const relabeled = { ...file, companyId: 'c2' };
  await assert.rejects(other.importBackup(relabeled), e => /تالف أو معدَّل/.test(e.message));
  relabeled.integrity = { algorithm: 'SHA-256', value: require('node:crypto').createHash('sha256').update(L.stable({ format: relabeled.format, companyId: 'c2', createdAt: relabeled.createdAt, count: relabeled.count, items: relabeled.items })).digest('hex') };
  await assert.rejects(other.importBackup(relabeled), e => /غير موقَّع|معدَّل/.test(e.message), 'signatures bind every item to company c1');
  assert.equal(bk.stores.items.size, 0, 'still nothing added');
});

test('a damaged or edited file is rejected completely with a clear Arabic message; nothing added', async () => {
  const srv = server({ data }), a = L.create({ call: srv.call, backend: L.memoryBackend() }); await a.sync();
  const good = await a.exportBackup();
  const bk = L.memoryBackend(), b = L.create({ call: srv.call, backend: bk }); await b.unlock();
  const damaged = JSON.parse(JSON.stringify(good)); damaged.items.pop(); // cut short
  await assert.rejects(b.importBackup(damaged), e => /تالف أو معدَّل/.test(e.message));
  const edited = JSON.parse(JSON.stringify(good)); edited.items[0].d.type = 'out'; // a record changed by hand
  await assert.rejects(b.importBackup(edited), e => /تالف أو معدَّل/.test(e.message));
  // Even with the integrity value recomputed, the server signature on the changed record refuses the WHOLE file.
  edited.integrity.value = require('node:crypto').createHash('sha256').update(L.stable({ format: edited.format, companyId: edited.companyId, createdAt: edited.createdAt, count: edited.count, items: edited.items })).digest('hex');
  await assert.rejects(b.importBackup(edited), e => /معدَّل أو غير موقَّع/.test(e.message));
  await assert.rejects(b.importBackup({ hello: 1 }), e => /ليس نسخة احتياطية/.test(e.message));
  assert.equal(bk.stores.items.size, 0, 'nothing added by any rejected file');
});

test('an OLD password-protected backup (v1) can still be imported; only it asks for the password', async () => {
  const srv = server({ data }), a = L.create({ call: srv.call, backend: L.memoryBackend() }); await a.sync();
  const v2 = await a.exportBackup(), subtle = globalThis.crypto.subtle, enc = new TextEncoder();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, await subtle.importKey('raw', enc.encode('كلمة-سر-قديمة'), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify({ companyId: 'c1', createdAt: 1, items: v2.items })));
  const b64 = u => Buffer.from(u).toString('base64');
  const v1 = { format: 'basma-backup-v1', companyId: 'c1', createdAt: 1, count: 4, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000, salt: b64(salt) }, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  const bk = L.memoryBackend(), b = L.create({ call: srv.call, backend: bk }); await b.unlock();
  assert.equal(b.needsPassword(v1), true);
  await assert.rejects(b.importBackup(v1), e => /كلمة سر/.test(e.message));
  await assert.rejects(b.importBackup(v1, 'خطأ-خطأ-خطأ'), e => /كلمة السر غير صحيحة/.test(e.message));
  assert.equal(bk.stores.items.size, 0);
  assert.equal((await b.importBackup(v1, 'كلمة-سر-قديمة')).imported, 4);
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

test('import only ADDS: existing items on the phone are kept, nothing is wiped', async () => {
  const srv = server({ data: JSON.parse(JSON.stringify(data)) }), a = L.create({ call: srv.call, backend: L.memoryBackend() });
  await a.sync(); const file = await a.exportBackup(); // backup: leave l1 pending, 2 records
  const bk = L.memoryBackend(), b = L.create({ call: srv.call, backend: bk });
  srv.change('leaves', 'l1', { empId: 'e1', date: '2026-12-22', status: 'approved', leaveType: 'paid' });
  srv.change('records', 'r7', { empId: 'e1', type: 'in', dateKey: '2026-12-23', timestamp: '2026-12-23T08:00:00Z' });
  await b.sync(); const before = bk.stores.items.size; // phone B: newer leave + r7 (but full sync also has everything)
  bk.stores.items.delete('c1|records|r1'); // pretend B lost the oldest record
  const res = await b.importBackup(file);
  assert.equal(res.imported, 1, 'only the missing record is added'); assert.equal(res.kept, 3);
  assert.equal(bk.stores.items.size, before, 'nothing removed');
  assert.equal((await b.range('leaves', '2026-12-22', '2026-12-22')).l1.status, 'approved', 'the newer state on the phone is kept');
  assert.ok((await b.range('records', '2026-12-23', '2026-12-23')).r7, 'items that are not in the backup stay');
});
