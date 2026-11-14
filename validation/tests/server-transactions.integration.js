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
const CURRENT = process.env.BASMA_SERVER_FILE || path.join(__dirname, '../functions/index.js');
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
  const context = { exports: {}, require: name => { if (!modules[name]) throw Error('unexpected module ' + name); return modules[name]; }, Buffer, console: process.env.BASMA_DEBUG_SERVER ? console : { error() {}, log() {} }, Date, URL, setTimeout, clearTimeout, structuredClone };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { exports: context.exports, invoke: (name, uid, data = {}, version = 1) => context.exports[name]({ auth: { uid, token: { version, auth_time: Date.now() / 1000 } }, app: { alreadyConsumed: false }, data }) };
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
  },
  'managerHome: a manager of company A receives A only, never company B data': async (file, tag) => {
    const day = new Date().toISOString().slice(0, 10), A = `cHomeA${tag}`, B = `cHomeB${tag}`;
    for (const [cid, who] of [[A, 'أ'], [B, 'ب']]) {
      await seedCompany(cid);
      await seed.ref(`companies/${cid}/info/nameAr`).set(`شركة ${who}`);
      await seed.ref(`companies/${cid}/employees`).set({ [`e_${cid}`]: { name: `موظف ${who}`, empId: '1', role: 'r', warehouseId: 'w1', status: 'approved', credId: 'secret-cred', deviceFingerprint: 'fp' } });
      await seed.ref(`companies/${cid}/records/r_${cid}`).set({ empId: `e_${cid}`, type: 'in', timestamp: `${day}T08:00:00Z`, dateKey: day, lat: 0, lng: 0, locStatus: 'approved', warehouseId: 'w1' });
      await seed.ref(`companies/${cid}/records/old_${cid}`).set({ empId: `e_${cid}`, type: 'in', timestamp: '2020-01-01T08:00:00Z', dateKey: '2020-01-01', lat: 0, lng: 0, locStatus: 'approved', warehouseId: 'w1' });
      await seed.ref(`companies/${cid}/leaves/l_${cid}`).set({ empId: `e_${cid}`, date: day, status: 'approved', leaveType: 'paid' });
      await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1 });
    }
    // A forged companyId in the request must be ignored: the company comes from the server-side access record.
    const home = await loadServer(file).invoke('managerHome', `mgr_${A}`, { companyId: B });
    assert.equal(home.companyId, A); assert.equal(home.info.nameAr, 'شركة أ'); assert.equal(home.date, day);
    assert.deepEqual(Object.keys(home.employees), [`e_${A}`]);
    assert.deepEqual(Object.keys(home.records), [`r_${A}`], "today's records only");
    assert.deepEqual(Object.keys(home.leaves), [`l_${A}`]);
    const text = JSON.stringify(home);
    assert.equal(text.includes(B), false, 'nothing from company B'); assert.equal(text.includes('شركة ب'), false);
    assert.equal(text.includes('secret-cred') || text.includes('deviceFingerprint'), false, 'no credential fields');
    await assert.rejects(loadServer(file).invoke('managerHome', 'seller'), e => e.code === 'permission-denied');
    await seed.ref(`access/emp_${A}`).set({ role: 'employee', companyId: A, employeeId: `e_${A}`, enabled: true, version: 1 });
    await assert.rejects(loadServer(file).invoke('managerHome', `emp_${A}`), e => e.code === 'permission-denied');
  }
};

test.before(async () => {
  for (const v of ['FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) if (!process.env[v]) throw Error(`${v} missing: run under firebase emulators:exec --only database,auth`);
  // Load the project's REAL rules into this emulator namespace: the admin SDK is not bound by them, but the
  // server's queries need their .indexOn entries exactly as in production ("Index not defined" otherwise).
  const rules = fs.readFileSync(path.join(__dirname, '../database.rules.json'), 'utf8');
  const loaded = await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/.settings/rules.json?ns=${new URL(DB_URL).hostname.split('.')[0]}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
  assert.equal(loaded.ok, true, 'project rules loaded into the emulator namespace');
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

// Full flow on the current code: no_checkin excuse → manager approves → employee checks out → «انصرف (بعذر)».
test('EXCUSED CHECKOUT — no_checkin excuse approved, then check-out is recorded as «انصرف (بعذر)»', async () => {
  const cid = 'cExcOut', emp = 'emp_exc_out', mgr = 'mgr_exc_out';
  await seedCompany(cid);
  await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', credId: 'cred-1', name: 'E', warehouseId: 'w1', warehouseName: 'Branch' });
  await seed.ref(`access/${emp}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
  await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1 });
  const proof = (id, intent) => seed.ref(`proofs/${emp}/${id}`).set({ intent, version: 1, expiresAt: Date.now() + 60000 });
  const out = id => loadServer(CURRENT).invoke('recordAttendance', emp, { type: 'out', proof: id, location: { lat: 0, lng: 0 } });
  // 1) Before any excuse, check-out without check-in is refused.
  await proof('x0', 'out');
  await assert.rejects(out('x0'), e => /سجّل الحضور أو احصل على موافقة العذر/.test(e.message));
  // 2) Employee sends the excuse; the manager approves it (each on a cold instance).
  assert.equal((await loadServer(CURRENT).invoke('submitRequest', emp, { kind: 'excuse', type: 'no_checkin', reason: 'نسيت تسجيل الحضور' })).ok, true);
  const [excuseId, excuse] = Object.entries(await get(`companies/${cid}/excuses`))[0];
  assert.equal(excuse.status, 'pending');
  assert.equal((await loadServer(CURRENT).invoke('reviewRequest', mgr, { collection: 'excuses', id: excuseId, status: 'approved' })).ok, true);
  assert.equal(await get(`companies/${cid}/excuses/${excuseId}/status`), 'approved');
  const date = excuse.date, ledgerPath = `attendanceLedger/${cid}/e1/${date}`;
  assert.equal((await get(ledgerPath)).events.excused.excuseType, 'no_checkin');
  // 3) The real projection trigger writes what the employee page reads: «حاضر (بعذر)».
  const project = () => loadServer(CURRENT).exports.projectAttendance({ params: { cid, eid: 'e1', date } });
  await project();
  const before = await get(`companies/${cid}/today/e1`);
  assert.equal(before.checkInExcused, true);
  assert.equal(before.statusLabel, 'حاضر (بعذر)');
  // 4) Employee checks out with a valid fingerprint proof.
  await proof('x1', 'out');
  const result = await out('x1');
  assert.equal(result.ok, true);
  const events = (await get(ledgerPath)).events;
  assert.deepEqual(Object.keys(events).sort(), ['excused', 'out']);
  // 5) A second check-out is refused.
  await proof('x2', 'out');
  await assert.rejects(out('x2'), e => e.code === 'already-exists');
  // 6) The status shown to the employee (today projection) and in the manager report.
  await project();
  const after = await get(`companies/${cid}/today/e1`);
  assert.equal(after.attendanceStatus, 'excused_out');
  assert.equal(after.statusLabel, 'انصرف (بعذر)');
  assert.ok(after.checkOut);
  const report = require('../public/assets/report-model.js').summary(events);
  assert.equal(report.statusLabel, 'انصرف (بعذر)');
});

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

// ---- Notifications written by the server (the rules forbid clients from writing notification text) ----
async function notifyCompany(cid) {
  await seedCompany(cid);
  await seed.ref(`companies/${cid}/employees`).set({ e1: { status: 'approved', name: 'E1' }, e2: { status: 'approved', name: 'E2' }, e3: { status: 'disabled', name: 'Off' } });
  await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1 });
  await seed.ref(`access/emp_${cid}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
  return { mgr: `mgr_${cid}`, emp: `emp_${cid}` };
}
const notes = async (cid, eid) => Object.values((await get(`companies/${cid}/notifications/${eid}`)) || {});
test('sendNotification: private message reaches one employee and is listed in sent messages', async () => {
  const cid = 'cNoteP', { mgr } = await notifyCompany(cid);
  const r = await loadServer(CURRENT).invoke('sendNotification', mgr, { kind: 'private_msg', employeeId: 'e1', message: 'سطر أول\r\nسطر ثانٍ' });
  assert.deepEqual({ ...r }, { ok: true, count: 1 });
  const [n] = await notes(cid, 'e1');
  assert.deepEqual({ type: n.type, message: n.message, read: n.read }, { type: 'private_msg', message: 'سطر أول\nسطر ثانٍ', read: false });
  assert.equal((await notes(cid, 'e2')).length, 0);
  const sent = Object.values(await get(`companies/${cid}/private_messages`));
  assert.equal(sent.length, 1); assert.equal(sent[0].empName, 'E1');
});
test('sendNotification: broadcast reaches every APPROVED employee only', async () => {
  const cid = 'cNoteB', { mgr } = await notifyCompany(cid);
  const r = await loadServer(CURRENT).invoke('sendNotification', mgr, { kind: 'broadcast', message: 'تعميم' });
  assert.equal(r.count, 2);
  assert.equal((await notes(cid, 'e1'))[0].type, 'broadcast');
  assert.equal((await notes(cid, 'e2')).length, 1);
  assert.equal((await notes(cid, 'e3')).length, 0, 'disabled employee is skipped');
  assert.equal(await get(`companies/${cid}/private_messages`), null);
});
test('sendNotification: refuses employees, unknown/disabled targets, other companies and unsafe text', async () => {
  const cid = 'cNoteX', { mgr, emp } = await notifyCompany(cid);
  const call = (uid, data) => loadServer(CURRENT).invoke('sendNotification', uid, data);
  await assert.rejects(call(emp, { kind: 'broadcast', message: 'x' }), e => e.code === 'permission-denied');
  await assert.rejects(call(mgr, { kind: 'mission', employeeId: 'e3', message: 'x' }), e => e.code === 'not-found');
  await assert.rejects(call(mgr, { kind: 'mission', employeeId: 'nobody', message: 'x' }), e => e.code === 'not-found');
  await assert.rejects(call(mgr, { kind: 'private_msg', employeeId: 'e1', message: '<script>' }), e => e.code === 'invalid-argument');
  await assert.rejects(call(mgr, { kind: 'private_msg', employeeId: 'e1', message: 'x'.repeat(1001) }), e => e.code === 'invalid-argument');
  await assert.rejects(call(mgr, { kind: 'admin', message: 'x' }), e => e.code === 'invalid-argument');
  const other = await notifyCompany('cNoteY');
  await assert.rejects(call(other.mgr, { kind: 'mission', employeeId: 'e9', message: 'x' }), e => e.code === 'not-found');
  assert.equal((await notes(cid, 'e1')).length, 0, 'nothing was written');
});
test('seller notifications: a new company and an upcoming expiry each create exactly one note', async () => {
  await seed.ref('seller/notifications').remove();
  const created = await newCompany(CURRENT, 'note');
  let list = Object.values(await get('seller/notifications'));
  assert.equal(list.length, 1); assert.equal(list[0].type, 'new_company'); assert.match(list[0].message, /شركة note/);
  await seed.ref('seller/notifications').remove();
  const soon = Date.now() + 3 * 86400000, far = Date.now() + 30 * 86400000;
  await seed.ref('companyDirectory').set({ cSoon: { nameAr: 'قريبة', status: 'active', expiresAt: soon }, cFar: { nameAr: 'بعيدة', status: 'active', expiresAt: far }, cOff: { nameAr: 'معلقة', status: 'suspended', expiresAt: soon }, cOld: { nameAr: 'منتهية', status: 'active', expiresAt: Date.now() - 1000 } });
  await loadServer(CURRENT).exports.cleanupSecurityState();
  await loadServer(CURRENT).exports.cleanupSecurityState(); // a second daily run must not duplicate
  list = Object.entries(await get('seller/notifications'));
  assert.deepEqual(list.map(([k]) => k), [`expiry_cSoon_${soon}`]);
  assert.equal(list[0][1].type, 'expiry'); assert.match(list[0][1].message, /قريبة/);
  void created;
});
