'use strict';
// Runs the REAL server code against the LOCAL Realtime Database + Auth emulators (firebase emulators:exec --only database,auth).
// Every loadServer() is a new firebase-admin app = an empty local cache, like a cold Cloud Functions instance.
// Real: database, Auth (incl. real password sign-in), transactions, policy.js and all server logic.
// Wrapped only: the onCall/trigger plumbing (handlers called directly) and the WebAuthn signature check.
// Each scenario runs on the ORIGINAL backup (must FAIL) and on the fixed code (must PASS).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const fromFunctions = require('node:module').createRequire(require.resolve('../functions/package.json'));
const { initializeApp, deleteApp } = fromFunctions('firebase-admin/app');
const { getDatabase } = fromFunctions('firebase-admin/database');
const { getAuth } = fromFunctions('firebase-admin/auth');

const DB_URL = 'https://demo-basma-srv-default-rtdb.firebaseio.com';
const CURRENT = path.join(__dirname, '../functions/index.js');
const ORIGINAL = path.join(process.env.HOME || '', 'basma-v5-original-backup/functions/index.js');
const HAVE_ORIGINAL = fs.existsSync(ORIGINAL);
let serial = 0;
const apps = [];
function adminApp() { const app = initializeApp({ projectId: 'demo-basma', databaseURL: DB_URL }, `srv-${++serial}`); apps.push(app); return app; }

class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
function loadServer(file) {
  const app = adminApp();
  const webauthn = {
    async generateRegistrationOptions() { return { challenge: `challenge-${++serial}`, user: { id: 'dQ' } }; },
    async generateAuthenticationOptions() { return { challenge: `challenge-${++serial}` }; },
    async verifyRegistrationResponse() { return { verified: true, registrationInfo: { credential: { id: 'cred-1', publicKey: Buffer.from('key'), counter: 0, transports: [] }, credentialDeviceType: 'singleDevice', credentialBackedUp: false } }; },
    async verifyAuthenticationResponse(o) { return { verified: true, authenticationInfo: { newCounter: o.credential.counter + 1 } }; }
  };
  const modules = {
    'node:crypto': require('node:crypto'),
    'firebase-admin/app': { initializeApp() {} },
    'firebase-admin/database': { getDatabase: () => getDatabase(app) },
    'firebase-admin/auth': { getAuth: () => getAuth(app) },
    'firebase-admin/storage': { getStorage: () => ({}) },
    'firebase-functions/v2/https': { onCall: (options, fn) => { fn.options = options; return fn; }, HttpsError },
    'firebase-functions/v2/database': { onValueWritten: (options, fn) => fn },
    'firebase-functions/v2/scheduler': { onSchedule: (options, fn) => fn },
    'firebase-functions/params': { defineString: name => ({ value: () => name === 'WEBAUTHN_RP_ID' ? 'basma.example.org' : 'https://basma.example.org' }) },
    '@simplewebauthn/server': webauthn,
    './policy': fromFunctions('./policy.js')
  };
  const context = { exports: {}, require: name => { if (!modules[name]) throw Error('unexpected module ' + name); return modules[name]; }, Buffer, console: { error() {}, log() {} }, Date, URL, setTimeout, clearTimeout, structuredClone };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { invoke: (name, uid, data = {}, version = 1) => context.exports[name]({ auth: { uid, token: { version, auth_time: Date.now() / 1000 } }, app: { alreadyConsumed: false }, data }) };
}
let seed, auth;
const get = async p => (await seed.ref(p).get()).val();
const settings = { checkIn: { from: '00:00', to: '23:59' }, checkOut: { from: '00:00', to: '23:59' } };
async function seedCompany(cid) {
  await seed.ref(`companies/${cid}`).set({ info: { status: 'active', expiresAt: Date.now() + 86400000, timeZone: 'UTC', maxEmployees: 10, nameAr: 'شركة' }, settings: { ...settings, weekendDays: [9] }, warehouses: { w1: { active: true, name: 'Branch' } } });
}
// Real password sign-in against the Auth emulator (local only).
async function signIn(email, password) {
  const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  return res.ok;
}
async function locksFor(...keys) { const all = (await get('operationLocks')) || {}; return keys.filter(k => all[k]); }
async function newCompany(file, tag) {
  return loadServer(file).invoke('createCompany', 'seller', { nameAr: `شركة ${tag}`, nameEn: `Co ${tag}`, maxEmployees: 5, expiresAt: Date.now() + 86400000, timeZone: 'UTC', settings });
}

// ---------------- scenarios (throw on any unmet expectation) ----------------
const scenarios = {
  'createCompany → resetManager returns a new password, the old one stops working, no lock left': async (file, tag) => {
    const created = await newCompany(file, tag);
    const email = `${created.username}@basma.app`;
    assert.equal(await signIn(email, created.password), true, 'initial password works');
    const reset = await loadServer(file).invoke('resetManager', 'seller', { companyId: created.companyId });
    assert.equal(reset.username, created.username);
    assert.notEqual(reset.password, created.password);
    assert.equal(await signIn(email, created.password), false, 'old password rejected');
    assert.equal(await signIn(email, reset.password), true, 'new password works');
    const uid = await get(`accountLinks/${created.companyId}/manager`);
    assert.deepEqual(await locksFor(uid), [], 'operationLocks empty after success');
  },
  'withLock leaves no lock after an ERROR inside the locked section': async (file, tag) => {
    const created = await newCompany(file, tag);
    const managerUid = await get(`accountLinks/${created.companyId}/manager`);
    await assert.rejects(loadServer(file).invoke('employeeAccount', managerUid, { employeeId: 'ghost' }), e => e.code === 'not-found');
    assert.deepEqual(await locksFor(`${created.companyId}_ghost`), [], 'operationLocks empty after error');
  },
  'a WebAuthn challenge is consumed exactly once with two concurrent finish calls': async (file, tag) => {
    const cid = `cBio${tag}`, uid = `emp_bio_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'pending_activation', name: 'E', warehouseId: 'w1', warehouseName: 'Branch' });
    await seed.ref(`access/${uid}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    const start = await loadServer(file).invoke('beginWebAuthn', uid, { mode: 'register' });
    const finish = () => loadServer(file).invoke('finishWebAuthn', uid, { challengeId: start.challengeId, response: { valid: true } });
    const results = await Promise.allSettled([finish(), finish()]);
    const summary = results.map(r => r.status === 'fulfilled' ? 'ok' : r.reason.message).join(' | ');
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, `exactly one succeeds (got: ${summary})`);
    assert.equal((await get(`challenges/${uid}/${start.challengeId}`)).used, true);
    assert.equal((await get(`credentials/${uid}`)).id, 'cred-1');
    await assert.rejects(finish(), e => e.code === 'permission-denied', 'replay rejected');
    assert.deepEqual(await locksFor(uid), []);
  },
  'recordAttendance records one check-in and rejects a duplicate': async (file, tag) => {
    const cid = `cAtt${tag}`, uid = `emp_att_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', credId: 'cred-1', name: 'E', warehouseId: 'w1', warehouseName: 'Branch' });
    await seed.ref(`access/${uid}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    const proof = id => seed.ref(`proofs/${uid}/${id}`).set({ intent: 'in', version: 1, expiresAt: Date.now() + 60000 });
    await proof('p1');
    const first = await loadServer(file).invoke('recordAttendance', uid, { type: 'in', proof: 'p1', location: { lat: 0, lng: 0 } });
    assert.equal(first.ok, true);
    await proof('p2');
    await assert.rejects(loadServer(file).invoke('recordAttendance', uid, { type: 'in', proof: 'p2', location: { lat: 0, lng: 0 } }), e => e.code === 'already-exists');
    assert.deepEqual(Object.keys((await get(`attendanceLedger/${cid}/e1/${first.date}`)).events), ['in']);
  },
  'renewSubscription extends the expiry on a cold instance': async (file, tag) => {
    const created = await newCompany(file, tag);
    const before = (await get(`companies/${created.companyId}/info`)).expiresAt;
    const result = await loadServer(file).invoke('renewSubscription', 'seller', { companyId: created.companyId, days: 30, requestId: `renew-${tag}` });
    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.expiresAt - (Math.max(Date.now(), before) + 30 * 86400000)) < 120000, 'about 30 days later');
    assert.equal((await get(`companies/${created.companyId}/info`)).expiresAt, result.expiresAt);
  },
  'changePassword works: new password accepted, old rejected, no lock left': async (file, tag) => {
    const created = await newCompany(file, tag);
    const uid = await get(`accountLinks/${created.companyId}/manager`), email = `${created.username}@basma.app`;
    const next = `New-Password-${tag}-123456`;
    const result = await loadServer(file).invoke('changePassword', uid, { password: next });
    assert.equal(result.ok, true);
    assert.equal(await signIn(email, created.password), false);
    assert.equal(await signIn(email, next), true);
    assert.equal((await get(`access/${uid}`)).version, 2);
    assert.deepEqual(await locksFor(uid), []);
  }
};

test.before(async () => {
  for (const v of ['FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) if (!process.env[v]) throw Error(`${v} missing: run under firebase emulators:exec --only database,auth`);
  const app = adminApp(); seed = getDatabase(app); auth = getAuth(app);
  await seed.ref().set({ access: { seller: { role: 'seller', enabled: true, version: 1 } } });
});
test.after(async () => { for (const app of apps) await deleteApp(app); });

let n = 0;
for (const [name, run] of Object.entries(scenarios)) {
  const id = ++n;
  test(`ORIGINAL FAILS — ${name}`, { skip: !HAVE_ORIGINAL && 'original backup not found' }, async t => {
    await assert.rejects(run(ORIGINAL, `o${id}`), error => { const line = `original #${id} (${name.slice(0, 40)}…) → ${String(error.code || '')} ${String(error.message).split('\n')[0].slice(0, 120)}`; t.diagnostic(line); fs.appendFileSync(path.join(require('node:os').tmpdir(), 'basma-original-failures.txt'), line + '\n'); return true; });
  });
  test(`FIXED PASSES — ${name}`, async () => { await run(CURRENT, `f${id}`); });
}

test('FIXED — a link to an account without access is refused before rotation, no lock left', async () => {
  await seedCompany('cGhost');
  await seed.ref('accountLinks/cGhost/manager').set('uid-without-access');
  await assert.rejects(loadServer(CURRENT).invoke('resetManager', 'seller', { companyId: 'cGhost' }), e => e.message === 'ربط حساب غير صالح');
  await assert.rejects(loadServer(CURRENT).invoke('resetManager', 'seller', { companyId: 'noSuchCompany' }), e => e.code === 'not-found');
  assert.deepEqual(await locksFor('uid-without-access'), []);
});

test('FIXED — two concurrent check-ins with two valid proofs: exactly one recorded', async () => {
  await seedCompany('cAttC');
  await seed.ref('companies/cAttC/employees/e2').set({ status: 'approved', credId: 'cred-1', name: 'E', warehouseId: 'w1', warehouseName: 'Branch' });
  await seed.ref('access/emp_c').set({ role: 'employee', companyId: 'cAttC', employeeId: 'e2', enabled: true, version: 1 });
  for (const p of ['q1', 'q2']) await seed.ref(`proofs/emp_c/${p}`).set({ intent: 'in', version: 1, expiresAt: Date.now() + 60000 });
  const results = await Promise.allSettled(['q1', 'q2'].map(p => loadServer(CURRENT).invoke('recordAttendance', 'emp_c', { type: 'in', proof: p, location: { lat: 0, lng: 0 } })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const date = results.find(r => r.status === 'fulfilled').value.date;
  assert.deepEqual(Object.keys((await get(`attendanceLedger/cAttC/e2/${date}`)).events), ['in']);
});
