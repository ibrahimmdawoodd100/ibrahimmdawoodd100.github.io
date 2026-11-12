'use strict';
// Reproduction on the LOCAL Database Emulator (never a live project), using the server's own firebase-admin.
// Question: do the transaction handlers in functions/index.js abort when their first call sees `null`
// (empty local cache on a fresh server instance), even though the data exists on the server?
const test = require('node:test'), assert = require('node:assert/strict');
const fromFunctions = require('node:module').createRequire(require.resolve('../functions/package.json'));
const { initializeApp, deleteApp } = fromFunctions('firebase-admin/app');
const { getDatabase } = fromFunctions('firebase-admin/database');

const URL = 'https://demo-basma-tx-default-rtdb.firebaseio.com';
let serial = 0;
const apps = [];
// A brand-new app = an empty local cache, like a cold Cloud Functions instance.
function freshDb() { const app = initializeApp({ projectId: 'demo-basma', databaseURL: URL }, `tx-${++serial}`); apps.push(app); return getDatabase(app); }
// Exact handler bodies from functions/index.js (rotateAccount and withLock), copied verbatim.
const legacyRotate = current => current ? { ...current, enabled: false, version: current.version + 1 } : undefined;
const legacyRelease = owner => value => value?.owner === owner ? null : undefined;
// Proposed fixed versions.
const fixedRotate = current => current === null ? null : { ...current, enabled: false, version: current.version + 1 };
const fixedRelease = owner => value => value === null ? null : value.owner === owner ? null : undefined;
const watch = fn => { const seen = []; return { seen, handler: v => { seen.push(v === null ? null : structuredClone(v)); return fn(v); } }; };

test.before(() => { if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) throw Error('Database emulator required.'); });
test.after(async () => { for (const app of apps) await deleteApp(app); });
test.beforeEach(async () => { await freshDb().ref().set({ access: { u1: { role: 'manager', companyId: 'c1', enabled: true, version: 1 } } }); });

test('REPRODUCTION: the current rotateAccount handler aborts on a fresh instance although access/u1 exists', async () => {
  const w = watch(legacyRotate);
  const result = await freshDb().ref('access/u1').transaction(w.handler);
  console.log('legacy rotate: first value seen =', JSON.stringify(w.seen[0]), '| calls =', w.seen.length, '| committed =', result.committed);
  assert.equal(w.seen[0], null, 'first call sees the empty cache, not the server value');
  assert.equal(result.committed, false, 'aborted → the server answers «الحساب غير موجود» (not-found) for an existing account');
  const after = (await freshDb().ref('access/u1').get()).val();
  assert.equal(after.version, 1, 'nothing was changed');
});

test('FIX: the proposed rotateAccount handler commits with the real server value', async () => {
  const w = watch(fixedRotate);
  const result = await freshDb().ref('access/u1').transaction(w.handler);
  assert.equal(result.committed, true);
  assert.equal(result.snapshot.exists(), true);
  assert.deepEqual(result.snapshot.val(), { role: 'manager', companyId: 'c1', enabled: false, version: 2 });
  assert.ok(w.seen.length >= 2 && w.seen[0] === null && w.seen.at(-1).version === 1, 'retried with the server value');
});

test('FIX: a truly missing account still fails cleanly (committed but no data → not-found)', async () => {
  const result = await freshDb().ref('access/missing').transaction(fixedRotate);
  assert.equal(result.committed, true);
  assert.equal(result.snapshot.exists(), false, 'the server code must check exists() and answer not-found');
});

async function acquire(db, owner) {
  return db.ref('operationLocks/u1').transaction(value => !value || value.expiresAt <= Date.now() ? { owner, expiresAt: Date.now() + 60000 } : undefined);
}

test('REPRODUCTION: the current lock release can leave the lock behind', async () => {
  const db = freshDb(), owner = 'owner-1';
  assert.equal((await acquire(db, owner)).committed, true);
  const releaseDb = freshDb(); // worst case: release sees an empty cache
  const w = watch(legacyRelease(owner));
  const result = await releaseDb.ref('operationLocks/u1').transaction(w.handler);
  const left = (await freshDb().ref('operationLocks/u1').get()).val();
  console.log('legacy release: first value seen =', JSON.stringify(w.seen[0]), '| committed =', result.committed, '| lock left =', left !== null);
  assert.equal(result.committed, false);
  assert.notEqual(left, null, 'lock stays up to 60 s → next request gets «توجد عملية أخرى على الحساب» (aborted)');
  const next = await acquire(freshDb(), 'owner-2');
  assert.equal(next.committed, false, 'a second reset within 60 s is refused');
});

test('FIX: the proposed lock release always removes its own lock', async () => {
  const owner = 'owner-1';
  assert.equal((await acquire(freshDb(), owner)).committed, true);
  const result = await freshDb().ref('operationLocks/u1').transaction(fixedRelease(owner));
  assert.equal(result.committed, true);
  assert.equal((await freshDb().ref('operationLocks/u1').get()).val(), null);
  assert.equal((await acquire(freshDb(), 'owner-2')).committed, true, 'the next request is accepted');
});

test('FIX: the proposed release never removes someone else\'s lock', async () => {
  assert.equal((await acquire(freshDb(), 'owner-A')).committed, true);
  const result = await freshDb().ref('operationLocks/u1').transaction(fixedRelease('owner-B'));
  assert.equal(result.committed, false);
  assert.equal((await freshDb().ref('operationLocks/u1').get()).val().owner, 'owner-A');
});

// ---- The REAL helpers from functions/index.js (extracted from the source, not copied by hand) ----
const serverSource = require('node:fs').readFileSync(require.resolve('../functions/index.js'), 'utf8');
const extract = name => { const start = serverSource.indexOf(`async function ${name}(`); assert.ok(start >= 0, name); const end = serverSource.indexOf('\n}\n', start); return serverSource.slice(start, end + 2); };
const helpers = new Function(`${extract('serverTransaction')}\nreturn { serverTransaction };`)();

test('REAL serverTransaction(): the unchanged rotate handler now commits on a fresh instance', async () => {
  const result = await helpers.serverTransaction(freshDb().ref('access/u1'), legacyRotate);
  assert.equal(result.committed, true);
  assert.equal(result.snapshot.val().version, 2);
  assert.equal(result.snapshot.val().enabled, false);
});

test('REAL serverTransaction(): a missing record still aborts, and the handler sees null once for its message', async () => {
  const w = watch(current => { if (!current) return; return current; });
  const result = await helpers.serverTransaction(freshDb().ref('access/nobody'), w.handler);
  assert.equal(result.committed, false);
  assert.deepEqual(w.seen, [null]);
  assert.equal((await freshDb().ref('access/nobody').get()).val(), null, 'nothing written');
});

test('REAL serverTransaction(): lock release on a fresh instance removes the lock', async () => {
  assert.equal((await acquire(freshDb(), 'owner-1')).committed, true);
  const result = await helpers.serverTransaction(freshDb().ref('operationLocks/u1'), legacyRelease('owner-1'));
  assert.equal(result.committed, true);
  assert.equal((await freshDb().ref('operationLocks/u1').get()).val(), null);
});

// Attendance ledger: null is valid (first check-in), but departure needs the stored check-in.
const departure = state => { if (!state?.events?.in) return; return { ...state, events: { ...state.events, departure: { at: 2 } } }; };
test('REPRODUCTION: a plain ledger transaction refuses departure on a fresh instance although check-in exists', async () => {
  await freshDb().ref('attendanceLedger/c1/e1/2026-11-12').set({ events: { in: { at: 1 } } });
  const result = await freshDb().ref('attendanceLedger/c1/e1/2026-11-12').transaction(departure);
  assert.equal(result.committed, false, '→ «المغادرة تتطلب حضورًا نشطًا» for a real, active check-in');
});

test('REAL serverTransaction(): the same departure commits with the server value', async () => {
  await freshDb().ref('attendanceLedger/c1/e1/2026-11-12').set({ events: { in: { at: 1 } } });
  const result = await helpers.serverTransaction(freshDb().ref('attendanceLedger/c1/e1/2026-11-12'), departure);
  assert.equal(result.committed, true);
  assert.deepEqual(Object.keys(result.snapshot.val().events).sort(), ['departure', 'in']);
});

test('REAL serverTransaction(): an empty ledger still allows the first check-in', async () => {
  const checkIn = state => state?.events?.in ? undefined : { events: { ...state?.events, in: { at: 1 } } };
  const result = await helpers.serverTransaction(freshDb().ref('attendanceLedger/c1/e2/2026-11-12'), checkIn);
  assert.equal(result.committed, true);
  assert.equal((await freshDb().ref('attendanceLedger/c1/e2/2026-11-12/events/in/at').get()).val(), 1);
});
