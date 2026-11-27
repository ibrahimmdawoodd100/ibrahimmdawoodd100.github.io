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
// Optional fixed server clock for date rules (closed months, grace days): the REAL server code runs as if it were `now`.
function fakeDate(nowMs) { return class extends Date { constructor(...a) { if (a.length) super(...a); else super(nowMs); } static now() { return nowMs; } }; }
function loadServer(file, { now } = {}) {
  const app = adminApp();
  const webauthn = {
    async generateRegistrationOptions() { return { challenge: `challenge-${++serial}`, user: { id: 'dQ' } }; },
    async generateAuthenticationOptions() { return { challenge: `challenge-${++serial}` }; },
    // The credential id comes from the browser response when given (a real authenticator's own id), else 'cred-1'.
    async verifyRegistrationResponse(o) { return { verified: true, registrationInfo: { credential: { id: o?.response?.id || 'cred-1', publicKey: Buffer.from('key'), counter: 0, transports: [] }, credentialDeviceType: 'singleDevice', credentialBackedUp: false } }; },
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
    './policy': fromFunctions('./policy.js'),
    './report-model': fromFunctions('./report-model.js')
  };
  const context = { exports: {}, require: name => { if (!modules[name]) throw Error('unexpected module ' + name); return modules[name]; }, Buffer, console: process.env.BASMA_DEBUG_SERVER ? console : { error() {}, log() {} }, Date: now ? fakeDate(now) : Date, URL, setTimeout, clearTimeout, structuredClone };
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
  'devices: a new fingerprint needs the manager\'s approval; another employee\'s credential and a pending device are refused server-side': async (file, tag) => {
    const cid = `cDev${tag}`, A = `devA_${tag}`, B = `devB_${tag}`, mgr = `devM_${tag}`;
    await seedCompany(cid);
    await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
    for (const [uid, eid] of [[A, 'eA'], [B, 'eB']]) {
      await seed.ref(`companies/${cid}/employees/${eid}`).set({ status: 'pending_activation', name: eid, warehouseId: 'w1', warehouseName: 'Branch' });
      await seed.ref(`access/${uid}`).set({ role: 'employee', companyId: cid, employeeId: eid, enabled: true, version: 1 });
    }
    const call = async (name, uid, data) => JSON.parse(JSON.stringify(await loadServer(file).invoke(name, uid, data)));
    const register = async (uid, credId, deviceLabel) => { const start = await call('beginWebAuthn', uid, { mode: 'register' }); return call('finishWebAuthn', uid, { challengeId: start.challengeId, response: { id: credId, rawId: credId }, deviceLabel }); };
    const authenticate = async (uid, credId, intent = 'in') => { const start = await call('beginWebAuthn', uid, { mode: 'authenticate', intent }); return call('finishWebAuthn', uid, { challengeId: start.challengeId, response: { id: credId, rawId: credId } }); };
    const checkIn = (uid, proof) => call('recordAttendance', uid, { type: 'in', proof, location: { lat: 0, lng: 0 } });
    const versionBefore = (await get(`scheduleVersions/${cid}`)) || 0;
    // 1. A registers a fingerprint: device PENDING, manager notified, log written, version bumped.
    assert.equal((await register(A, 'credA', 'Android · Chrome')).deviceStatus, 'pending');
    assert.equal((await get(`deviceApprovals/${cid}/eA`)).status, 'pending');
    const note = Object.values((await get(`companies/${cid}/notifications/admin`)) || {}).find(n => n.type === 'device_new');
    assert.match(note.message, /eA.*Android · Chrome.*بانتظار اعتمادك/);
    assert.deepEqual(Object.values(await get(`deviceLog/${cid}/eA`)).map(e => e.event), ['registered']);
    assert.ok((await get(`scheduleVersions/${cid}`)) > versionBefore, 'open pages are told to refresh');
    // 2. Pending device: no proof, and a forged proof cannot record attendance either.
    await assert.rejects(authenticate(A, 'credA'), e => e.code === 'failed-precondition' && e.details?.reason === 'device-pending');
    await seed.ref(`proofs/${A}/forged`).set({ intent: 'in', version: 1, expiresAt: Date.now() + 60000 });
    await assert.rejects(checkIn(A, 'forged'), e => e.code === 'failed-precondition' && e.details?.reason === 'device-pending');
    assert.equal(await get(`attendanceLedger/${cid}/eA`), null, 'nothing recorded');
    const home = await call('employeeHome', A);
    assert.equal(home.device.status, 'pending'); assert.ok(home.scheduleVersion > 0);
    assert.deepEqual((await call('managerList', mgr, { kind: 'devices' })).order, ['eA']);
    // 3. Only the manager of THIS company approves; then A records attendance.
    await assert.rejects(call('managerDevice', A, { action: 'approve', employeeId: 'eA' }), e => e.code === 'permission-denied');
    await assert.rejects(call('managerDevice', mgr, { action: 'approve', employeeId: 'eB' }), e => e.code === 'not-found', 'no pending device for B yet');
    await call('managerDevice', mgr, { action: 'approve', employeeId: 'eA' });
    assert.equal((await get(`deviceApprovals/${cid}/eA`)).status, 'approved');
    assert.ok(Object.values(await get(`companies/${cid}/notifications/eA`)).some(n => n.type === 'device_ok'));
    assert.equal((await checkIn(A, (await authenticate(A, 'credA')).proof)).ok, true);
    // 4. Account switch on the same phone: B registers its OWN credential (pending) and cannot use A's credential.
    assert.equal((await register(B, 'credB')).deviceStatus, 'pending');
    await call('managerDevice', mgr, { action: 'approve', employeeId: 'eB' });
    await assert.rejects(authenticate(B, 'credA'), e => e.code === 'permission-denied' && /ليست مسجلة لحسابك/.test(e.message), 'A\'s fingerprint is refused for B');
    await assert.rejects(checkIn(B, 'forged'), e => e.code === 'permission-denied', 'A\'s proof is not B\'s');
    // 5. Re-registering needs a manager reset (one device per employee); a rejected device is removed.
    await assert.rejects(register(A, 'credA2'), e => /إعادة تعيين البصمة/.test(e.message));
    await call('managerDevice', mgr, { action: 'reject', employeeId: 'eB' });
    assert.equal(await get(`credentials/${B}`), null); assert.equal((await get(`companies/${cid}/employees/eB`)).status, 'pending_activation');
    assert.deepEqual(Object.values(await get(`deviceLog/${cid}/eB`)).map(e => e.event), ['registered', 'approved', 'rejected']);
  },
  'cost guards: one-call payroll, month versions change on every month write, hourly cap per login': async (file, tag) => {
    const cid = `cCost${tag}`, mgr = `costM_${tag}`, emp = `costE_${tag}`;
    await seedCompany(cid);
    await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
    await seed.ref(`access/${emp}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', name: 'E', empId: 'N1', warehouseId: 'w1', warehouseName: 'Branch', credId: 'cred-1', deviceFingerprint: 'secret-device' });
    await seed.ref(`privatePayroll/${cid}`).set({ e1: { salary: 900, deductionPercent: 50, iban: 'secret-iban' } });
    const call = async (name, uid, data) => JSON.parse(JSON.stringify(await loadServer(file).invoke(name, uid, data)));
    assert.deepEqual(await call('managerList', mgr, { kind: 'payrollAll' }), { items: { e1: { salary: 900, deductionPercent: 50 } } }, 'all salaries, only the two fields');
    const month = new Date().toISOString().slice(0, 7), versions = async () => (await call('managerList', mgr, { kind: 'monthVersions', months: [month] })).versions[month];
    assert.equal(await versions(), 0);
    // (v5.17: excuses are for lateness only; a leave request is the month write here.)
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10), leaveMonth = tomorrow.slice(0, 7);
    await call('submitRequest', emp, { kind: 'leave', leaveType: 'paid', date: tomorrow, reason: 'سفر' });
    const v1 = (await call('managerList', mgr, { kind: 'monthVersions', months: [leaveMonth] })).versions[leaveMonth]; assert.ok(v1 > 0, 'a new request changes its month');
    const today = new Date().toISOString().slice(0, 10);
    await seed.ref(`companies/${cid}/leaves/L1`).set({ empId: 'e1', date: today, status: 'pending', leaveType: 'paid', createdAt: Date.now() });
    await new Promise(r => setTimeout(r, 5));
    await call('reviewRequest', mgr, { collection: 'leaves', id: 'L1', status: 'rejected' });
    const v2 = await versions(); assert.ok(v2 > 0, 'a decision changes its month');
    await seed.ref(`attendanceLedger/${cid}/e1/${today}`).set({ revision: 1, events: { in: { empId: 'e1', type: 'in', timestamp: new Date().toISOString(), dateKey: today, actor: emp } } }); // as recordAttendance writes it
    await new Promise(r => setTimeout(r, 5));
    await loadServer(file).exports.projectAttendance({ params: { cid, eid: 'e1', date: today } });
    assert.ok((await versions()) > v2, 'a projected attendance record changes its month');
    for (const bad of [[], ['2026-13'], Array(13).fill(month)]) await assert.rejects(call('managerList', mgr, { kind: 'monthVersions', months: bad }), e => e.code === 'invalid-argument');
    const home = await call('employeeHome', emp);
    assert.equal(home.employee.deviceFingerprint, undefined, 'employeeHome sends only the fields the page uses');
    // Hourly cap: a login that already made 600 calls this hour is refused (90/minute still applies).
    await seed.ref(`rateLimits/${emp}`).set({ bucket: Math.floor(Date.now() / 60000), count: 1, hour: Math.floor(Date.now() / 3600000), hourCount: 600, expiresAt: Date.now() + 3600000 });
    await assert.rejects(call('employeeList', emp, { kind: 'version' }), e => e.code === 'resource-exhausted');
  },
  'business rules (owner, 22 Nov 2026): leave notice, lateness, work days, leave day, no night windows, branch delete, seat freed, no manual edits, closed month + grace, frozen payroll': async (file, tag) => {
    const cid = `cBiz${tag}`, mgr = `bizM_${tag}`, emp = `bizE_${tag}`;
    await seedCompany(cid);
    await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
    await seed.ref(`access/${emp}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`credentials/${emp}`).set({ id: 'cred-1', publicKey: 'a2V5', counter: 0, transports: [] });
    await seed.ref(`companies/${cid}/info/expiresAt`).set(Date.parse('2027-06-01T00:00:00Z'));
    await seed.ref(`companies/${cid}/employees`).set({ e1: { status: 'approved', name: 'E1', empId: 'N1', credId: 'cred-1', warehouseId: 'w1', warehouseName: 'Branch', createdAt: Date.parse('2026-11-01T00:00:00Z') },
      e2: { status: 'approved', name: 'E2', empId: 'N2', warehouseId: 'w1', warehouseName: 'Branch', createdAt: Date.parse('2026-11-01T00:00:00Z') } });
    await seed.ref(`employeeIndex/${cid}`).set({ count: 2, ids: { h1: 'e1', h2: 'e2' } });
    await seed.ref(`privatePayroll/${cid}`).set({ e1: { salary: 2200, deductionPercent: 100 } });
    const at = iso => loadServer(file, { now: Date.parse(iso) });
    const call = async (iso, name, uid, data) => JSON.parse(JSON.stringify(await at(iso).invoke(name, uid, data)));
    const W = { from: '00:00', to: '23:59' }, WI = { from: '00:00', to: '11:59' }, WO = { from: '12:00', to: '23:59' }; // v5.19: check-out after check-in
    // Leave notice: full AND timed leave at least 1 day before; the manager is notified.
    await assert.rejects(call('2026-12-15T09:00:00Z', 'submitRequest', emp, { kind: 'leave', leaveType: 'partial', date: '2026-12-15', fromTime: '10:00', toTime: '11:00', reason: 'x' }), e => /قبل يومها/.test(e.message));
    await assert.rejects(call('2026-12-15T09:00:00Z', 'submitRequest', emp, { kind: 'leave', leaveType: 'paid', date: '2026-12-15', reason: 'x' }), e => /قبل يومها/.test(e.message));
    await call('2026-12-15T09:00:00Z', 'submitRequest', emp, { kind: 'leave', leaveType: 'paid', date: '2026-12-16', reason: 'سفر' });
    assert.ok(Object.values(await get(`companies/${cid}/notifications/admin`)).some(n => n.type === 'leave_new'), 'manager notified of the new leave');
    // No window may cross midnight (company, branch, employee).
    await assert.rejects(call('2026-12-15T09:00:00Z', 'managerSettings', mgr, { action: 'timeWindows', checkIn: { from: '22:00', to: '02:00' }, checkOut: W }), e => /منتصف الليل/.test(e.message));
    await assert.rejects(call('2026-12-15T09:00:00Z', 'managerBranch', mgr, { action: 'schedule', id: 'w1', schedule: { checkIn: W, checkOut: { from: '23:00', to: '06:00' } } }), e => /منتصف الليل/.test(e.message));
    // Start time (company) and work days (employee override Mon-Fri).
    await call('2026-12-15T09:00:00Z', 'managerSettings', mgr, { action: 'timeWindows', checkIn: WI, checkOut: WO, startTime: '08:00' });
    await call('2026-12-15T09:00:00Z', 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e1', schedule: { checkIn: WI, checkOut: WO, workDays: [1, 2, 3, 4, 5] } });
    assert.deepEqual(await get(`companies/${cid}/employees/e1/workDays`), [1, 2, 3, 4, 5]);
    await assert.rejects(call('2026-12-15T09:00:00Z', 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e1', schedule: { checkIn: WI, checkOut: WO, workDays: [7] } }), e => e.code === 'invalid-argument');
    const proof = id => seed.ref(`proofs/${emp}/${id}`).set({ intent: 'in', version: 1, expiresAt: Date.parse('2027-06-01T00:00:00Z') });
    await proof('sun'); await assert.rejects(call('2026-12-13T09:30:00Z', 'recordAttendance', emp, { type: 'in', proof: 'sun', location: { lat: 0, lng: 0 } }), e => /ليس يوم عمل/.test(e.message), 'Sunday is not his work day');
    await proof('mon'); await call('2026-12-14T09:30:00Z', 'recordAttendance', emp, { type: 'in', proof: 'mon', location: { lat: 0, lng: 0 } });
    assert.equal((await get(`attendanceLedger/${cid}/e1/2026-12-14`)).events.in.delayMins, 90, 'late = minutes after the start time 08:00 (display only)');
    await at('2026-12-14T09:31:00Z').exports.projectAttendance({ params: { cid, eid: 'e1', date: '2026-12-14' } });
    // An approved full-day leave blocks check-in on that day (server, not only the page).
    const leaveId = Object.keys(await get(`companies/${cid}/leaves`))[0];
    await call('2026-12-15T10:00:00Z', 'reviewRequest', mgr, { collection: 'leaves', id: leaveId, status: 'approved' });
    await proof('leave'); await assert.rejects(call('2026-12-16T09:00:00Z', 'recordAttendance', emp, { type: 'in', proof: 'leave', location: { lat: 0, lng: 0 } }), e => /إجازة معتمدة/.test(e.message));
    // No manual attendance editing at all.
    await assert.rejects(call('2026-12-15T10:00:00Z', 'manualAttendance', mgr, { employeeId: 'e1', status: 'present', reason: 'x' }), e => /غير متاح/.test(e.message));
    // A branch with employees cannot be deleted; an empty one can.
    await assert.rejects(call('2026-12-15T10:00:00Z', 'managerBranch', mgr, { action: 'delete', id: 'w1' }), e => /انقلهم/.test(e.message));
    const { id: empty } = await call('2026-12-15T10:00:00Z', 'managerBranch', mgr, { action: 'add', name: 'فارغ' });
    await call('2026-12-15T10:00:00Z', 'managerBranch', mgr, { action: 'delete', id: empty });
    // Disabling frees the plan seat and records the date (for mid-month pay).
    await call('2026-12-15T10:00:00Z', 'disableEmployee', mgr, { employeeId: 'e2' });
    assert.equal((await get(`employeeIndex/${cid}`)).count, 1); assert.equal((await get(`companies/${cid}/employees/e2`)).disabledAt, Date.parse('2026-12-15T10:00:00Z'));
    // Closed months: no holiday for a past month; leave decisions only for on-time requests during 5 grace days.
    await assert.rejects(call('2026-12-15T10:00:00Z', 'managerSettings', mgr, { action: 'holidayAdd', date: '2026-11-20', name: 'x' }), e => /الشهر مغلق/.test(e.message));
    await call('2026-12-15T10:00:00Z', 'managerSettings', mgr, { action: 'holidayAdd', date: '2026-12-25', name: 'عيد' });
    await seed.ref(`companies/${cid}/leaves/onTime`).set({ empId: 'e1', date: '2026-12-28', status: 'pending', leaveType: 'paid', createdAt: Date.parse('2026-12-01T08:00:00Z') });
    await seed.ref(`companies/${cid}/leaves/late`).set({ empId: 'e1', date: '2026-12-29', status: 'pending', leaveType: 'paid', createdAt: Date.parse('2026-12-29T08:00:00Z') });
    await seed.ref(`companies/${cid}/leaves/afterGrace`).set({ empId: 'e1', date: '2026-12-30', status: 'pending', leaveType: 'paid', createdAt: Date.parse('2026-12-01T08:00:00Z') });
    await call('2027-01-03T10:00:00Z', 'reviewRequest', mgr, { collection: 'leaves', id: 'onTime', status: 'approved' });
    await assert.rejects(call('2027-01-03T10:00:00Z', 'reviewRequest', mgr, { collection: 'leaves', id: 'late', status: 'approved' }), e => /الشهر مغلق/.test(e.message), 'not submitted on time');
    await assert.rejects(call('2027-01-08T10:00:00Z', 'reviewRequest', mgr, { collection: 'leaves', id: 'afterGrace', status: 'approved' }), e => /الشهر مغلق/.test(e.message), 'after the 5 grace days');
    // Payroll: November = old rules (pages), December = new rules on the server; frozen after the grace, never recalculated.
    await assert.rejects(call('2026-12-20T10:00:00Z', 'managerList', mgr, { kind: 'payrollMonth', month: '2026-11' }), e => e.details?.reason === 'v1-month');
    const open = await call('2026-12-20T10:00:00Z', 'managerList', mgr, { kind: 'payrollMonth', month: '2026-12' });
    assert.equal(open.frozen, false); assert.equal(open.rows[0].workingDays, 22, 'Mon-Fri of December minus the 25th: whole month, not days so far');
    const final = await call('2027-01-10T10:00:00Z', 'managerList', mgr, { kind: 'payrollMonth', month: '2026-12' });
    assert.equal(final.frozen, true); assert.equal(final.rows[0].absentDays, 19); assert.equal(final.rows[0].deduction, 1900); assert.equal(final.rows[0].net, 300);
    await seed.ref(`privatePayroll/${cid}/e1/salary`).set(9999);
    assert.equal((await call('2027-02-10T10:00:00Z', 'managerList', mgr, { kind: 'payrollMonth', month: '2026-12' })).rows[0].net, 300, 'a frozen month is never recalculated');
  },
  'work location + permanent transfer (owner, 23 Nov 2026): special map point for one employee, reset on removal/transfer, history kept, log, fingerprint still valid': async (file, tag) => {
    const cid = `cLoc${tag}`, mgr = `locM_${tag}`, emp = `locE_${tag}`, other = `locO_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/info/expiresAt`).set(Date.parse('2027-06-01T00:00:00Z'));
    await seed.ref(`companies/${cid}/warehouses`).set({ w1: { active: true, name: 'الفرع الأول', geoZone: { lat: 24, lng: 46, radius: 200, enabled: true } }, w2: { active: true, name: 'الفرع الثاني', geoZone: { lat: 21, lng: 39, radius: 300, enabled: true } } });
    await seed.ref(`companies/${cid}/employees`).set({ e1: { status: 'approved', name: 'E1', credId: 'cred-1', warehouseId: 'w1', warehouseName: 'الفرع الأول', createdAt: Date.parse('2026-11-01T00:00:00Z') },
      e2: { status: 'approved', name: 'E2', credId: 'cred-2', warehouseId: 'w1', warehouseName: 'الفرع الأول', createdAt: Date.parse('2026-11-01T00:00:00Z') } });
    for (const [uid, eid, cred] of [[emp, 'e1', 'cred-1'], [other, 'e2', 'cred-2']]) {
      await seed.ref(`access/${uid}`).set({ role: 'employee', companyId: cid, employeeId: eid, enabled: true, version: 1 });
      await seed.ref(`credentials/${uid}`).set({ id: cred, publicKey: 'a2V5', counter: 0, transports: [] });
    }
    await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
    const at = iso => loadServer(file, { now: Date.parse(iso) });
    const call = async (iso, name, uid, data) => JSON.parse(JSON.stringify(await at(iso).invoke(name, uid, data)));
    const W = { from: '00:00', to: '23:59' }, WI = { from: '00:00', to: '11:59' }, WO = { from: '12:00', to: '23:59' }, FAR = { lat: 25, lng: 47 }, BRANCH = { lat: 24, lng: 46 };
    let n = 0;
    const checkIn = async (iso, uid, where) => { const id = `p${++n}`; await seed.ref(`proofs/${uid}/${id}`).set({ intent: 'in', version: 1, expiresAt: Date.parse('2027-06-01T00:00:00Z') }); return call(iso, 'recordAttendance', uid, { type: 'in', proof: id, location: { ...where, accuracy: 10 } }); };
    // 1) Special work location for e1 only (a map point far from his branch).
    await call('2026-12-01T08:00:00Z', 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e1', schedule: { checkIn: WI, checkOut: WO, workDays: [0, 1, 2, 3, 4, 5, 6], location: { ...FAR, radius: 250 } } });
    assert.deepEqual(await get(`companies/${cid}/employees/e1/geoZone`), { ...FAR, radius: 250, enabled: true });
    await assert.rejects(call('2026-12-01T08:00:00Z', 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e1', schedule: { checkIn: WI, checkOut: WO, location: { lat: 999, lng: 0, radius: 10 } } }), e => e.code === 'invalid-argument');
    await assert.rejects(checkIn('2026-12-02T08:00:00Z', emp, BRANCH), 'e1 at his branch is now OUTSIDE his work location');
    assert.equal((await checkIn('2026-12-03T08:00:00Z', emp, FAR)).ok, true, 'e1 at the special point is accepted');
    assert.equal((await checkIn('2026-12-03T08:00:00Z', other, BRANCH)).ok, true, 'e2 (no special location) is unchanged');
    await assert.rejects(checkIn('2026-12-04T08:00:00Z', other, FAR), 'e2 cannot use e1\'s point');
    // 2) Editing the schedule from an older page (no location field) keeps the location; "branch" returns him.
    await call('2026-12-05T08:00:00Z', 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e1', schedule: { checkIn: WI, checkOut: WO, workDays: [0, 1, 2, 3, 4, 5, 6] } });
    assert.equal((await get(`companies/${cid}/employees/e1/geoZone`)).radius, 250);
    await call('2026-12-05T08:00:00Z', 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e1', schedule: null });
    assert.equal(await get(`companies/${cid}/employees/e1/geoZone`), null, 'removing the special schedule returns him to his branch location');
    assert.equal((await checkIn('2026-12-06T08:00:00Z', emp, BRANCH)).ok, true);
    // 3) Permanent transfer: special times/days kept, special location reset, history untouched, fingerprint still valid.
    await call('2026-12-07T08:00:00Z', 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e1', schedule: { checkIn: WI, checkOut: WO, startTime: '07:00', workDays: [0, 1, 2, 3, 4, 5, 6], location: { ...FAR, radius: 250 } } });
    const recordsBefore = JSON.stringify(await get(`companies/${cid}/records`)), ledgerBefore = JSON.stringify(await get(`attendanceLedger/${cid}/e1`));
    await assert.rejects(call('2026-12-08T08:00:00Z', 'transferEmployee', mgr, { employeeId: 'e1', warehouseId: 'w1' }), e => /أصلًا/.test(e.message), 'same branch');
    await call('2026-12-08T08:00:00Z', 'transferEmployee', mgr, { employeeId: 'e1', warehouseId: 'w2' });
    const moved = await get(`companies/${cid}/employees/e1`);
    assert.equal(moved.warehouseId, 'w2'); assert.equal(moved.warehouseName, 'الفرع الثاني'); assert.equal(moved.geoZone, undefined, 'special location reset to the new branch');
    assert.equal(moved.schedule.startTime, '07:00', 'special times kept'); assert.deepEqual(moved.workDays, [0, 1, 2, 3, 4, 5, 6], 'special work days kept');
    assert.equal(moved.credId, 'cred-1'); assert.ok(await get(`credentials/${emp}`), 'fingerprint binding untouched');
    assert.equal(JSON.stringify(await get(`companies/${cid}/records`)), recordsBefore, 'old records keep the old branch');
    assert.equal(JSON.stringify(await get(`attendanceLedger/${cid}/e1`)), ledgerBefore, 'ledger history untouched');
    await assert.rejects(checkIn('2026-12-09T08:00:00Z', emp, BRANCH), 'the old branch location no longer works');
    const ok = await checkIn('2026-12-10T08:00:00Z', emp, { lat: 21, lng: 39 });
    assert.equal(ok.ok, true, 'same fingerprint works at the new branch');
    assert.equal((await get(`attendanceLedger/${cid}/e1/2026-12-10`)).events.in.warehouseName, 'الفرع الثاني');
    assert.equal((await get(`attendanceLedger/${cid}/e1/2026-12-03`)).events.in.warehouseName, 'الفرع الأول');
    // Back to the old branch with the same screen (permanent until changed again).
    await call('2026-12-11T08:00:00Z', 'transferEmployee', mgr, { employeeId: 'e1', warehouseId: 'w1' });
    assert.equal(Object.keys((await get(`companies/${cid}/employees/e1/branchHistory`)) || {}).length, 2);
    // 4) Log: who, when, from, to — for transfers and location changes; manager reads it.
    const log = Object.values((await call('2026-12-11T09:00:00Z', 'managerList', mgr, { kind: 'employeeLog', employeeId: 'e1' })).items);
    assert.deepEqual(log.map(x => x.type), ['location', 'location', 'location', 'transfer', 'transfer']);
    const t = log[3]; assert.equal(t.actor, mgr); assert.equal(t.from, 'w1'); assert.equal(t.fromName, 'الفرع الأول'); assert.equal(t.to, 'w2'); assert.equal(t.toName, 'الفرع الثاني'); assert.equal(t.locationReset, true); assert.equal(t.at, Date.parse('2026-12-08T08:00:00Z'));
    assert.deepEqual(log[0].to, { ...FAR, radius: 250 });
    // 5) A disabled employee cannot be transferred.
    await call('2026-12-12T08:00:00Z', 'disableEmployee', mgr, { employeeId: 'e2' });
    await assert.rejects(call('2026-12-12T08:00:00Z', 'transferEmployee', mgr, { employeeId: 'e2', warehouseId: 'w2' }), e => /معطّل/.test(e.message));
  },
  'schedule windows (owner, 24 Nov 2026): check-out starts at/after check-in ends for NEW saves, existing overlaps keep working, 10-minute minimum before check-out': async (file, tag) => {
    const cid = `cWin${tag}`, mgr = `winM_${tag}`, emp = `winE_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/info/expiresAt`).set(Date.parse('2027-06-01T00:00:00Z'));
    await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
    await seed.ref(`access/${emp}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`credentials/${emp}`).set({ id: 'cred-1', publicKey: 'a2V5', counter: 0, transports: [] });
    // An EXISTING overlapping special schedule (as found live: in 20:00-21:56 / out 21:35-22:35), saved before the rule.
    const legacy = { checkIn: { from: '20:00', to: '21:56' }, checkOut: { from: '21:35', to: '22:35' } };
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', name: 'E1', credId: 'cred-1', warehouseId: 'w1', warehouseName: 'Branch', createdAt: Date.parse('2026-11-01T00:00:00Z'), schedule: legacy });
    const call = async (iso, name, uid, data) => JSON.parse(JSON.stringify(await loadServer(file, { now: Date.parse(iso) }).invoke(name, uid, data)));
    const T = '2026-12-14T08:00:00Z';
    // 1) Normal same-day pair is accepted everywhere (check-out may start exactly when check-in ends).
    const good = { checkIn: { from: '08:00', to: '09:00' }, checkOut: { from: '09:00', to: '17:00' } };
    await call(T, 'managerSettings', mgr, { action: 'timeWindows', ...good });
    await call(T, 'managerBranch', mgr, { action: 'schedule', id: 'w1', schedule: good });
    await call(T, 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e2x', schedule: good }).catch(() => {}); // unknown employee: not the point here
    // 2) Overlap is refused on the server, with a clear Arabic message, for company, branch and employee saves.
    const overlap = { checkIn: { from: '20:00', to: '21:56' }, checkOut: { from: '21:35', to: '22:35' } };
    const refused = e => e.code === 'invalid-argument' && /أوقات متداخلة/.test(e.message);
    await assert.rejects(call(T, 'managerSettings', mgr, { action: 'timeWindows', ...overlap }), refused, 'company');
    await assert.rejects(call(T, 'managerBranch', mgr, { action: 'schedule', id: 'w1', schedule: overlap }), refused, 'branch');
    await assert.rejects(call(T, 'managerSettings', mgr, { action: 'employeeSchedule', employeeId: 'e1', schedule: overlap }), refused, 'employee');
    // 3) A NEW overnight pair (check-out earlier on the clock) is refused too (decision 8: same day only).
    await assert.rejects(call(T, 'managerBranch', mgr, { action: 'schedule', id: 'w1', schedule: { checkIn: { from: '22:00', to: '23:00' }, checkOut: { from: '06:00', to: '07:00' } } }), refused, 'new overnight');
    assert.deepEqual(await get(`companies/${cid}/employees/e1/schedule`), legacy, 'the existing overlapping schedule is NOT changed');
    // 4) The existing overlapping schedule still works: check-in at 21:40, check-out at 21:55 (both windows open).
    const proof = async (id, intent) => seed.ref(`proofs/${emp}/${id}`).set({ intent, version: 1, expiresAt: Date.parse('2027-06-01T00:00:00Z') });
    const rec = (iso, type, id) => call(iso, 'recordAttendance', emp, { type, proof: id, location: { lat: 0, lng: 0 } });
    await proof('in1', 'in'); assert.equal((await rec('2026-12-14T21:40:00Z', 'in', 'in1')).ok, true);
    // 5) 10-minute guard: check-out at +5 min is refused and the fingerprint proof is NOT used up.
    await proof('out1', 'out');
    await assert.rejects(rec('2026-12-14T21:45:00Z', 'out', 'out1'), e => /10 دقائق/.test(e.message) && /بقي 5 دقيقة/.test(e.message));
    assert.equal((await get(`proofs/${emp}/out1`)).used, undefined, 'proof kept for the next try');
    assert.equal((await rec('2026-12-14T21:50:00Z', 'out', 'out1')).ok, true, 'exactly 10 minutes later the same proof works');
    assert.ok((await get(`attendanceLedger/${cid}/e1/2026-12-14`)).events.out);
  },
  'local storage (owner, 24 Nov 2026): signed incremental sync of own company only, then every record older than 45 days is removed (not before 2027-01-10), settings/accounts kept': async (file, tag) => {
    const { createPublicKey, verify } = require('node:crypto');
    const cid = `cSync${tag}`, other = `cSyncO${tag}`, mgr = `syncM_${tag}`, mgrO = `syncMO_${tag}`;
    await seedCompany(cid); await seedCompany(other);
    for (const [uid, c] of [[mgr, cid], [mgrO, other]]) await seed.ref(`access/${uid}`).set({ role: 'manager', companyId: c, enabled: true, version: 1, retentionConsent: 1 });
    for (const c of [cid, other]) await seed.ref(`companies/${c}/info/expiresAt`).set(Date.parse('2027-12-01T00:00:00Z'));
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', name: 'E1', warehouseId: 'w1', warehouseName: 'Branch' });
    const records = {};
    for (let i = 0; i < 2003; i++) records[`r${String(i).padStart(4, '0')}`] = { empId: 'e1', type: 'in', dateKey: i < 3 ? '2026-10-0' + (i + 1) : '2027-01-20', timestamp: '2027-01-20T08:00:00.000Z', warehouseId: 'w1', warehouseName: 'Branch', secretField: 'never-synced' };
    await seed.ref(`companies/${cid}/records`).set(records);
    await seed.ref(`companies/${cid}/leaves`).set({ lOld: { empId: 'e1', date: '2026-10-05', status: 'approved', leaveType: 'paid' }, lNew: { empId: 'e1', date: '2027-01-25', status: 'pending', leaveType: 'paid' } });
    await seed.ref(`companies/${cid}/excuses`).set({ xOld: { empId: 'e1', date: '2026-10-02', status: 'approved', type: 'late' } });
    await seed.ref(`attendanceLedger/${cid}/e1`).set({ '2026-10-01': { events: { in: { type: 'in' } } }, '2027-01-20': { events: { in: { type: 'in' } } } });
    await seed.ref(`companies/${cid}/partialLeaveRecords/e1/2026-10-01`).set({ returnAt: 'x' });
    await seed.ref(`fullDayLeaveIndex/${cid}/e1`).set({ '2026-10-05': true, '2027-01-25': true });
    await seed.ref(`payrollSnapshots/${cid}`).set({ '2026-10': { month: '2026-10', rows: [] }, '2026-12': { month: '2026-12', rows: [] } });
    await seed.ref('companyDirectory').update({ [cid]: { timeZone: 'UTC', status: 'active' }, [other]: { timeZone: 'UTC', status: 'active' } });
    const call = async (iso, name, uid, data) => JSON.parse(JSON.stringify(await loadServer(file, { now: Date.parse(iso) }).invoke(name, uid, data)));
    // 1) Keys: stable per company, different per company; the private signing key is never returned.
    const k1 = await call('2026-12-01T08:00:00Z', 'managerList', mgr, { kind: 'syncKeys' }), k2 = await call('2026-12-01T08:00:00Z', 'managerList', mgr, { kind: 'syncKeys' });
    const kO = await call('2026-12-01T08:00:00Z', 'managerList', mgrO, { kind: 'syncKeys' });
    assert.equal(k1.storeKey, k2.storeKey); assert.notEqual(k1.storeKey, kO.storeKey); assert.equal(k1.publicKey, kO.publicKey);
    assert.equal(k1.companyId, cid); assert.equal(JSON.stringify(k1).includes('PRIVATE'), false);
    const pub = createPublicKey({ key: Buffer.from(k1.publicKey, 'base64'), format: 'der', type: 'spki' });
    const stable = v => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);
    const ok = (c, col, id, it) => verify(null, Buffer.from(`${c}\n${col}\n${id}\n${stable(it.d)}`), pub, Buffer.from(it.s, 'base64'));
    // 2) Signed pages, oldest first, with a cursor; only listed record fields; own company only.
    const all = {}; let next = null, pages = 0;
    do { const pg = await call('2026-12-01T08:00:00Z', 'managerList', mgr, { kind: 'sync', collection: 'records', from: null, after: next }); Object.assign(all, pg.items); next = pg.next; pages++; } while (next);
    assert.equal(pages, 2); assert.equal(Object.keys(all).length, 2003);
    for (const [id, it] of Object.entries(all)) assert.ok(ok(cid, 'records', id, it), `signature ${id}`);
    assert.equal(all.r0000.d.secretField, undefined, 'only record fields are synced');
    assert.equal(ok(cid, 'records', 'r0000', { ...all.r0000, d: { ...all.r0000.d, type: 'out' } }), false, 'a tampered record fails the check');
    assert.equal(ok(other, 'records', 'r0000', all.r0000), false, 'a record cannot be moved to another company');
    assert.deepEqual(Object.keys((await call('2026-12-01T08:00:00Z', 'managerList', mgrO, { kind: 'sync', collection: 'records', from: null })).items), [], 'other company sees nothing');
    const inc = await call('2026-12-01T08:00:00Z', 'managerList', mgr, { kind: 'sync', collection: 'records', from: '2027-01-01' });
    assert.equal(Object.keys(inc.items).length, 2000, 'incremental from a date'); assert.equal(inc.next, null, 'exactly one full page left');
    const pay = await call('2026-12-01T08:00:00Z', 'managerList', mgr, { kind: 'sync', collection: 'payroll' });
    assert.deepEqual(Object.keys(pay.items).sort(), ['2026-10', '2026-12']); assert.ok(ok(cid, 'payroll', '2026-10', pay.items['2026-10']));
    await assert.rejects(call('2026-12-01T08:00:00Z', 'managerList', mgr, { kind: 'sync', collection: 'privatePayroll' }), e => e.code === 'invalid-argument');
    // One call per open: keys + first page of every collection + ack of the previous pull.
    // v6.1: no cursor = FULL sync (first time on a phone); incremental syncs are tested in the v6.1 scenario.
    const one = await call('2026-12-01T08:00:00Z', 'managerList', mgr, { kind: 'syncAll', lastBackupAt: Date.parse('2026-12-01T07:00:00Z') });
    assert.equal(one.full, true); assert.equal(one.keys.storeKey, k1.storeKey); assert.equal(Object.keys(one.pages.records.items).length, 2000); assert.ok(one.pages.records.next);
    assert.deepEqual(Object.keys(one.pages.leaves.items).sort(), ['lNew', 'lOld']); assert.deepEqual(Object.keys(one.pages.payroll.items).sort(), ['2026-10', '2026-12']);
    assert.equal((await get(`companies/${cid}/syncState/${mgr}`)).lastBackupAt, Date.parse('2026-12-01T07:00:00Z'), 'per manager login, informational only');
    // 3) Before 2027-01-10 (owner postponed the start) nothing is removed, even far past 45 days.
    await loadServer(file, { now: Date.parse('2027-01-09T03:00:00Z') }).exports.cleanupSecurityState();
    assert.equal(Object.keys(await get(`companies/${cid}/records`)).length, 2003);
    // 4) From 2027-01-10: everything dated before (today - 45 days) is removed; recent data and the company setup stay.
    await loadServer(file, { now: Date.parse('2027-01-30T03:00:00Z') }).exports.cleanupSecurityState(); // cutoff 2026-12-16
    const left = await get(`companies/${cid}/records`);
    assert.equal(Object.keys(left).length, 2000); assert.equal(left.r0000, undefined);
    assert.deepEqual(Object.keys(await get(`companies/${cid}/leaves`)), ['lNew']); assert.equal(await get(`companies/${cid}/excuses`), null);
    assert.deepEqual(Object.keys(await get(`attendanceLedger/${cid}/e1`)), ['2027-01-20']);
    assert.equal(await get(`companies/${cid}/partialLeaveRecords/e1/2026-10-01`), null);
    assert.deepEqual(await get(`fullDayLeaveIndex/${cid}/e1`), { '2027-01-25': true });
    assert.deepEqual(Object.keys(await get(`payrollSnapshots/${cid}`)), ['2026-12'], 'old payroll snapshots are removed too (owner s2 = B)');
    for (const kept of ['info', 'settings', 'warehouses', 'employees']) assert.ok(await get(`companies/${cid}/${kept}`), `${kept} kept`);
    assert.ok(await get(`access/${mgr}`), 'accounts kept');
    // 5) A month whose records are gone is never recalculated on the server.
    await assert.rejects(call('2027-02-20T08:00:00Z', 'managerList', mgr, { kind: 'payrollMonth', month: '2026-12' }), e => e.details?.reason === 'device-only');
  },
  'v6.1/v6.2 (owner, 25 Nov 2026): no consent gate, incremental sync of ONLY new/changed items, closed-month pay statement saved before deletion, change list purged': async (file, tag) => {
    const cid = `cInc${tag}`, mgr = `incM_${tag}`, emp = `incE_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/info/expiresAt`).set(Date.parse('2027-12-01T00:00:00Z'));
    await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1 }); // NO consent yet
    await seed.ref(`access/${emp}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`credentials/${emp}`).set({ id: 'cred-1', publicKey: 'a2V5', counter: 0, transports: [] });
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', name: 'E1', credId: 'cred-1', warehouseId: 'w1', warehouseName: 'Branch', createdAt: Date.parse('2026-11-01T00:00:00Z') });
    await seed.ref(`privatePayroll/${cid}/e1`).set({ salary: 3000, deductionPercent: 100 });
    await seed.ref(`companies/${cid}/records/old1`).set({ empId: 'e1', type: 'in', dateKey: '2026-12-01', timestamp: '2026-12-01T08:00:00.000Z' });
    await seed.ref('companyDirectory').update({ [cid]: { timeZone: 'UTC', status: 'active' } });
    const call = async (iso, name, uid, data) => JSON.parse(JSON.stringify(await loadServer(file, iso ? { now: Date.parse(iso) } : {}).invoke(name, uid, data)));
    // 1) v6.2 (owner): NO consent gate. A manager who never accepted anything uses the app normally; old consent records do not block.
    await seed.ref(`companies/${cid}/consents/old`).set({ uid: 'old', at: 1, version: 1 });
    assert.ok(await call(null, 'managerHome', mgr, {}), 'company data without any consent');
    assert.ok(await call(null, 'managerRecords', mgr, { from: '2026-12-01', to: '2026-12-01' }));
    // 2) Full sync once; then an incremental sync sends ONLY what changed since the cursor.
    const full = await call(null, 'managerList', mgr, { kind: 'syncAll' });
    assert.equal(full.full, true); assert.deepEqual(Object.keys(full.pages.records.items), ['old1']);
    // v6.4: ONE opening call: with the phone's cursor, managerHome also carries the incremental sync (signed, same keys).
    const boot = await call(null, 'managerHome', mgr, { sync: { cursor: full.cursor } });
    assert.ok(boot.employees && boot.sync, 'home + sync together'); assert.equal(boot.sync.full, false); assert.equal(boot.sync.keys.storeKey, full.keys.storeKey);
    assert.equal((await call(null, 'managerHome', mgr, {})).sync, undefined, 'no cursor (first open): no sync inside, the page syncs in the background');
    const quiet = await call(null, 'managerList', mgr, { kind: 'syncAll', cursor: full.cursor });
    assert.equal(quiet.full, false); for (const col of ['records', 'leaves', 'excuses', 'payroll']) assert.deepEqual(Object.keys(quiet.pages[col].items), [], `nothing new: ${col}`);
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    await call(null, 'submitRequest', emp, { kind: 'leave', leaveType: 'paid', date: tomorrow, reason: 'سفر' });
    const leaveId = Object.keys(await get(`companies/${cid}/leaves`))[0];
    await call(null, 'reviewRequest', mgr, { collection: 'leaves', id: leaveId, status: 'approved' });
    await seed.ref(`attendanceLedger/${cid}/e1/2026-12-02/events/in`).set({ type: 'in', empId: 'e1', actor: emp, timestamp: '2026-12-02T08:00:00.000Z', dateKey: '2026-12-02' });
    await loadServer(file).exports.projectAttendance({ params: { cid, eid: 'e1', date: '2026-12-02' } });
    await seed.ref(`companies/${cid}/records/sneaky`).set({ empId: 'e1', type: 'in', dateKey: '2026-12-03' }); // written outside the server code: not in the change list
    const inc = await call(null, 'managerList', mgr, { kind: 'syncAll', cursor: { at: quiet.cursor.at } });
    assert.deepEqual(Object.keys(inc.pages.records.items), ['2026-12-02_e1_in'], 'only the new record');
    assert.deepEqual(Object.keys(inc.pages.leaves.items), [leaveId], 'the leave once, in its latest state');
    assert.equal(inc.pages.leaves.items[leaveId].d.status, 'approved');
    assert.ok(inc.cursor.at >= quiet.cursor.at && inc.cursor.key);
    const again = await call(null, 'managerList', mgr, { kind: 'syncAll', cursor: { at: inc.cursor.at + 121000 } });
    assert.deepEqual(Object.keys(again.pages.records.items), [], 'after the cursor: nothing again');
    // 3) A closed month past its grace: the pay statement is made and sent on the next sync, before any deletion.
    assert.equal(await get(`payrollSnapshots/${cid}/2026-12`), null);
    const jan = await call('2027-01-07T08:00:00Z', 'managerList', mgr, { kind: 'syncAll', cursor: { at: Date.parse('2027-01-07T07:00:00Z') } });
    assert.ok(await get(`payrollSnapshots/${cid}/2026-12`), 'saved on the server first');
    assert.deepEqual(Object.keys(jan.pages.payroll.items), ['2026-12'], 'and sent to the phone in the same sync');
    assert.equal(jan.pages.payroll.items['2026-12'].d.rows[0].employeeId, 'e1');
    // 4) The change list is deleted by age like everything else.
    await seed.ref(`changeLog/${cid}/-AAAAAAAoldentry000000`).set({ col: 'records', id: 'x', at: 1 });
    await loadServer(file, { now: Date.parse('2027-03-01T03:00:00Z') }).exports.cleanupSecurityState();
    assert.equal(await get(`changeLog/${cid}/-AAAAAAAoldentry000000`), null);
  },
  'rolling retention (owner, 25 Nov 2026): from 2027-01-10 each daily run deletes exactly the day that turned 46 days old; the server keeps the last 45 days': async (file, tag) => {
    const cid = `cRoll${tag}`;
    await seedCompany(cid);
    await seed.ref('companyDirectory').update({ [cid]: { timeZone: 'UTC', status: 'active' } });
    const day = (base, n) => new Date(Date.parse(`${base}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
    const records = {}, leaves = {}; // one record and one leave for EVERY day from 2026-12-01 to 2027-02-28
    for (let i = 0; day('2026-12-01', i) <= '2027-02-28'; i++) { const d = day('2026-12-01', i); records[`r${d}`] = { empId: 'e1', type: 'in', dateKey: d, timestamp: `${d}T08:00:00.000Z` }; leaves[`l${d}`] = { empId: 'e1', date: d, status: 'approved', leaveType: 'paid' }; }
    await seed.ref(`companies/${cid}/records`).set(records); await seed.ref(`companies/${cid}/leaves`).set(leaves);
    const run = iso => loadServer(file, { now: Date.parse(iso) }).exports.cleanupSecurityState();
    const dates = async col => Object.values((await get(`companies/${cid}/${col}`)) || {}).map(v => v.dateKey || v.date).sort();
    // Before the start date nothing is deleted, even data far older than 45 days.
    await run('2027-01-09T03:00:00Z'); assert.equal((await dates('records'))[0], '2026-12-01');
    // Day after day from 2027-02-10 (after the first run's catch-up): exactly ONE day per run, always 45 days back.
    await run('2027-02-09T03:00:00Z');
    for (const today of ['2027-02-10', '2027-02-11', '2027-02-12']) {
      const before = await dates('records');
      await run(`${today}T03:00:00Z`);
      const after = await dates('records'), gone = before.filter(d => !after.includes(d));
      assert.deepEqual(gone, [day(today, -46)], `${today}: only the day that is now 46 days old`);
      assert.equal(after[0], day(today, -45), `${today}: the oldest kept day is exactly 45 days old`);
      assert.deepEqual((await dates('leaves')).filter(d => d <= today)[0], day(today, -45));
    }
  },
  'check-in address (owner, 27 Nov 2026): the phone saves ONE short address on its own check-in, once; the manager sees it with the point': async (file, tag) => {
    const cid = `cAddr${tag}`, emp = `addrE_${tag}`, other = `addrO_${tag}`, mgr = `addrM_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/info/expiresAt`).set(Date.parse('2027-12-01T00:00:00Z'));
    for (const [uid, eid] of [[emp, 'e1'], [other, 'e2']]) { await seed.ref(`access/${uid}`).set({ role: 'employee', companyId: cid, employeeId: eid, enabled: true, version: 1 }); await seed.ref(`credentials/${uid}`).set({ id: `cred-${eid}`, publicKey: 'a2V5', counter: 0, transports: [] }); }
    await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
    await seed.ref(`companies/${cid}/employees`).set({ e1: { status: 'approved', name: 'E1', credId: 'cred-e1', warehouseId: 'w1', warehouseName: 'Branch' }, e2: { status: 'approved', name: 'E2', credId: 'cred-e2', warehouseId: 'w1', warehouseName: 'Branch' } });
    const call = async (name, uid, data) => JSON.parse(JSON.stringify(await loadServer(file).invoke(name, uid, data)));
    const home = await call('employeeHome', emp, {});
    assert.equal(home.geocoder.provider, 'nominatim'); assert.match(home.geocoder.url, /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/); assert.equal(home.geocoder.credit, '© OpenStreetMap');
    const text = 'قرب 901-27، محلة 901، قضاء الرصافة، بغداد';
    await assert.rejects(call('employeeList', emp, { kind: 'setAddress', type: 'in', date: home.date, text, lang: 'ar' }), e => e.code === 'not-found', 'no check-in yet');
    await seed.ref(`proofs/${emp}/p1`).set({ intent: 'in', version: 1, expiresAt: Date.now() + 60000 });
    const checkIn = await call('recordAttendance', emp, { type: 'in', proof: 'p1', location: { lat: 33.3041, lng: 44.4217, accuracy: 100 } });
    await loadServer(file).exports.projectAttendance({ params: { cid, eid: 'e1', date: checkIn.date } });
    await assert.rejects(call('employeeList', emp, { kind: 'setAddress', type: 'in', date: checkIn.date, text: 'x'.repeat(101), lang: 'ar' }), e => e.code === 'invalid-argument', 'max 100 characters');
    await assert.rejects(call('employeeList', emp, { kind: 'setAddress', type: 'in', date: checkIn.date, text, lang: 'fr' }), e => e.code === 'invalid-argument');
    await assert.rejects(call('employeeList', other, { kind: 'setAddress', type: 'in', date: checkIn.date, text, lang: 'ar' }), e => e.code === 'not-found', "another employee cannot write on this check-in (only on his own)");
    assert.equal((await call('employeeList', emp, { kind: 'setAddress', type: 'in', date: checkIn.date, text, lang: 'ar' })).ok, true);
    assert.deepEqual(await get(`attendanceLedger/${cid}/e1/${checkIn.date}/events/in/address`), { text, lang: 'ar' });
    assert.deepEqual(await get(`companies/${cid}/records/${checkIn.date}_e1_in/address`), { text, lang: 'ar' });
    assert.equal((await call('employeeList', emp, { kind: 'setAddress', type: 'in', date: checkIn.date, text: 'تغيير', lang: 'ar' })).kept, true, 'saved once; never overwritten');
    assert.equal((await get(`companies/${cid}/records/${checkIn.date}_e1_in/address`)).text, text);
    // The manager receives the address AND the exact point (for the map link).
    const day = await call('managerRecords', mgr, { from: checkIn.date, to: checkIn.date });
    const rec = day.records[`${checkIn.date}_e1_in`];
    assert.equal(rec.address.text, text); assert.equal(rec.lat, 33.3041); assert.equal(rec.lng, 44.4217); assert.equal(rec.accuracy, 100);
    // The changed record reaches the manager's phone through the incremental sync.
    const notes = Object.values((await get(`changeLog/${cid}`)) || {}).filter(n => n.id === `${checkIn.date}_e1_in`);
    assert.ok(notes.length >= 2, 'noted when created and when the address was added');
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
  'recordAttendance returns the new day summary, identical to what the projection trigger writes': async (file, tag) => {
    const cid = `cAttT${tag}`, uid = `emp_attT_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', credId: 'cred-1', name: 'E', warehouseId: 'w1', warehouseName: 'Branch' });
    await seed.ref(`access/${uid}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`credentials/${uid}`).set({ id: 'cred-1', publicKey: 'a2V5', counter: 0, transports: [] }); // the employee's own credential (registered before v5.15: no device entry = approved)
    const proof = id => seed.ref(`proofs/${uid}/${id}`).set({ intent: id.slice(0, -1), version: 1, expiresAt: Date.parse('2027-06-01T00:00:00Z') });
    await seed.ref(`companies/${cid}/info/expiresAt`).set(Date.parse('2027-06-01T00:00:00Z'));
    // v5.19: a check-out needs 10 minutes after the check-in, so the server clock is fixed and moves 11 minutes.
    const T0 = Date.parse('2026-12-14T10:00:00Z'), atIn = () => loadServer(file, { now: T0 }), atOut = () => loadServer(file, { now: T0 + 11 * 60000 });
    await proof('in1');
    const first = JSON.parse(JSON.stringify(await atIn().invoke('recordAttendance', uid, { type: 'in', proof: 'in1', location: { lat: 0, lng: 0 } })));
    assert.ok(first.today, 'the answer carries the day summary (the page shows it at once)');
    assert.equal(first.today.checkIn, first.timestamp); assert.equal(first.today.ledgerRevision, 1);
    await loadServer(file).exports.projectAttendance({ params: { cid, eid: 'e1', date: first.date } });
    assert.deepEqual(first.today, await get(`companies/${cid}/today/e1`), 'same values as the projection');
    await proof('out1');
    const second = JSON.parse(JSON.stringify(await atOut().invoke('recordAttendance', uid, { type: 'out', proof: 'out1', location: { lat: 0, lng: 0 } })));
    // «سجلاتي» before the projection trigger ran: today's events already appear, once each.
    const history = JSON.parse(JSON.stringify(await atOut().invoke('employeeList', uid, { kind: 'history' })));
    const types = history.order.map(k => history.items[k].type).sort();
    assert.deepEqual(types, ['in', 'out'], 'check-in (projected) and check-out (not yet projected), no duplicates');
    assert.equal(second.today.checkOut, second.timestamp); assert.equal(second.today.checkIn, first.timestamp); assert.equal(second.today.ledgerRevision, 2);
    await loadServer(file).exports.projectAttendance({ params: { cid, eid: 'e1', date: second.date } });
    assert.deepEqual(second.today, await get(`companies/${cid}/today/e1`));
  },
  'recordAttendance records one check-in and rejects a duplicate': async (file, tag) => {
    const cid = `cAtt${tag}`, uid = `emp_att_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', credId: 'cred-1', name: 'E', warehouseId: 'w1', warehouseName: 'Branch' });
    await seed.ref(`access/${uid}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`credentials/${uid}`).set({ id: 'cred-1', publicKey: 'a2V5', counter: 0, transports: [] }); // the employee's own credential (registered before v5.15: no device entry = approved)
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
      await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
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
    assert.deepEqual({ ...home.profile }, { role: 'manager', companyId: A, employeeId: null, name: 'شركة أ', timeZone: 'UTC' }, 'profile fields: one call opens the page');
  },
  'warm-up: {warm:true} starts the check-in functions with NO side effect, after the same access checks': async (file, tag) => {
    const cid = `cWarm${tag}`, uid = `emp_warm_${tag}`;
    await seedCompany(cid);
    await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', credId: 'cred-1', name: 'E', warehouseId: 'w1', warehouseName: 'Branch' });
    await seed.ref(`access/${uid}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`credentials/${uid}`).set({ id: 'cred-1', publicKey: 'a2V5', counter: 0, transports: [] }); // the employee's own credential (registered before v5.15: no device entry = approved)
    for (const name of ['beginWebAuthn', 'finishWebAuthn', 'recordAttendance']) assert.deepEqual({ ...await loadServer(file).invoke(name, uid, { warm: true }) }, { warm: true }, name);
    for (const p of [`challenges/${uid}`, `proofs/${uid}`, `attendanceLedger/${cid}`, `operationLocks/${uid}`]) assert.equal(await get(p), null, `nothing written at ${p}`);
    await assert.rejects(loadServer(file).invoke('recordAttendance', 'seller', { warm: true }), e => e.code === 'permission-denied', 'role still checked');
    await seed.ref(`access/${uid}/enabled`).set(false);
    await assert.rejects(loadServer(file).invoke('beginWebAuthn', uid, { warm: true }), e => e.code === 'permission-denied', 'disabled account still refused');
    await seed.ref(`access/${uid}/enabled`).set(true);
    const home = await loadServer(file).invoke('employeeHome', uid);
    assert.deepEqual({ ...home.profile }, { role: 'employee', companyId: cid, employeeId: 'e1', name: 'شركة', timeZone: 'UTC' });
  },
  'managerRecords: own company only, chosen range only, compact fields, 31-day limit, month + pending requests': async (file, tag) => {
    const A = `cRecA${tag}`, B = `cRecB${tag}`;
    for (const cid of [A, B]) {
      await seedCompany(cid);
      await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
      await seed.ref(`companies/${cid}/records`).set({
        [`in_${cid}`]: { empId: 'e1', type: 'in', timestamp: '2026-10-05T08:00:00Z', dateKey: '2026-10-05', lat: 33.3, lng: 44.4, actor: 'uid-secret', locStatus: 'approved', warehouseId: 'w1', warehouseName: 'Branch', delayMins: 3 },
        [`old_${cid}`]: { empId: 'e1', type: 'in', timestamp: '2026-08-01T08:00:00Z', dateKey: '2026-08-01', lat: 0, lng: 0, locStatus: 'approved', warehouseId: 'w1' } });
      await seed.ref(`companies/${cid}/leaves`).set({ [`oct_${cid}`]: { empId: 'e1', date: '2026-10-05', status: 'approved' }, [`pend_${cid}`]: { empId: 'e1', date: '2026-07-01', status: 'pending' }, [`done_${cid}`]: { empId: 'e1', date: '2026-07-02', status: 'rejected' } });
    }
    const range = await loadServer(file).invoke('managerRecords', `mgr_${A}`, { from: '2026-10-01', to: '2026-10-31', companyId: B });
    assert.deepEqual(Object.keys(range.records), [`in_${A}`], 'range only, company A only');
    // v6.8 (owner): the manager now receives the exact point (map link next to each check-in); still no actor or other internals.
    assert.deepEqual(Object.keys(range.records[`in_${A}`]).sort(), ['dateKey', 'delayMins', 'empId', 'lat', 'lng', 'locStatus', 'timestamp', 'type', 'warehouseId', 'warehouseName'], 'compact: the point for the map link, no actor');
    assert.equal(range.records[`in_${A}`].actor, undefined, 'never the actor');
    assert.deepEqual(Object.keys(range.leaves), [`oct_${A}`]);
    assert.equal(JSON.stringify(range).includes(B), false, 'nothing from company B');
    await assert.rejects(loadServer(file).invoke('managerRecords', `mgr_${A}`, { from: '2026-09-01', to: '2026-10-31' }), e => e.code === 'invalid-argument', 'more than 31 days refused');
    await assert.rejects(loadServer(file).invoke('managerRecords', `mgr_${A}`, { from: '2026-02-30', to: '2026-03-01' }), e => e.code === 'invalid-argument', 'invalid date refused');
    const requests = await loadServer(file).invoke('managerRecords', `mgr_${A}`, { kind: 'requests', collection: 'leaves', month: '2026-10' });
    assert.deepEqual(Object.keys(requests.items).sort(), [`oct_${A}`, `pend_${A}`].sort(), 'month + older pending, not resolved history');
    await assert.rejects(loadServer(file).invoke('managerRecords', `mgr_${A}`, { kind: 'requests', collection: 'records', month: '2026-10' }), e => e.code === 'invalid-argument');
    await seed.ref(`access/emp_${A}`).set({ role: 'employee', companyId: A, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`companies/${A}/employees/e1`).set({ status: 'approved', name: 'E', warehouseId: 'w1' });
    await assert.rejects(loadServer(file).invoke('managerRecords', `emp_${A}`, { from: '2026-10-01', to: '2026-10-02' }), e => e.code === 'permission-denied');
  },
  'managerList: own company only, compact fields, key pages (employees forward, messages newest first), branch counts': async (file, tag) => {
    const A = `cLstA${tag}`, B = `cLstB${tag}`;
    for (const cid of [A, B]) {
      await seedCompany(cid);
      await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
      const staff = {};
      for (let i = 0; i < 205; i++) staff[`e${String(i).padStart(3, '0')}`] = { name: `موظف ${i}`, empId: `N${i}`, status: i < 3 ? 'approved' : 'pending_activation', warehouseId: 'w1', credId: 'secret-cred', deviceFingerprint: 'secret-device' };
      await seed.ref(`companies/${cid}/employees`).set(staff);
      const messages = {}; for (let i = 0; i < 52; i++) messages[`m${String(i).padStart(3, '0')}`] = { empId: 'e000', message: `رسالة ${i}`, read: false, createdAt: i, actor: 'uid-secret' };
      await seed.ref(`companies/${cid}/private_messages`).set(messages);
      await seed.ref(`companies/${cid}/warehouses/w2`).set({ name: `فرع ${cid}`, active: true, pin: 'secret-pin' });
    }
    const call = async data => JSON.parse(JSON.stringify(await loadServer(file).invoke('managerList', `mgr_${A}`, data)));
    const first = await call({ kind: 'employees', companyId: B });
    assert.equal(first.order.length, 200); assert.equal(first.next, 'e199');
    const second = await call({ kind: 'employees', cursor: first.next });
    assert.deepEqual(second.order, ['e200', 'e201', 'e202', 'e203', 'e204']); assert.equal(second.next, null);
    assert.deepEqual(Object.keys(first.items.e000).sort(), ['empId', 'name', 'status', 'warehouseId'], 'no credential or device fields');
    const branches = await call({ kind: 'warehouses' });
    assert.deepEqual(branches.order, ['w1', 'w2']); assert.deepEqual(branches.counts, { w1: 3 });
    assert.equal(JSON.stringify(branches).includes('secret-pin'), false); assert.equal(JSON.stringify(branches).includes(B), false, 'nothing from company B');
    const newest = await call({ kind: 'messages' });
    assert.equal(newest.order[0], 'm051'); assert.equal(newest.order.length, 50); assert.equal(newest.next, 'm002');
    const older = await call({ kind: 'messages', cursor: newest.next });
    assert.deepEqual(older.order, ['m001', 'm000']); assert.equal(older.next, null);
    assert.equal(JSON.stringify(newest).includes('uid-secret'), false);
    assert.deepEqual((await call({ kind: 'settings' })).settings.checkIn, settings.checkIn);
    await seed.ref(`companies/${A}/today/e000`).set({ dateKey: '2026-11-17', checkIn: 'in-A' });
    await seed.ref(`companies/${B}/today/e000`).set({ dateKey: '2026-11-17', checkIn: 'in-B' });
    assert.equal((await call({ kind: 'employeeToday', employeeId: 'e000', companyId: B })).value.checkIn, 'in-A', 'own company only');
    await assert.rejects(call({ kind: 'employeeToday', employeeId: '../x' }), e => e.code === 'invalid-argument');
    for (const bad of [{ kind: 'records' }, { kind: '../access' }, { kind: 'employees', cursor: '../x' }]) await assert.rejects(call(bad), e => e.code === 'invalid-argument');
    await seed.ref(`access/emp_${A}`).set({ role: 'employee', companyId: A, employeeId: 'e000', enabled: true, version: 1 });
    await seed.ref(`companies/${A}/employees/e000/status`).set('approved');
    await assert.rejects(loadServer(file).invoke('managerList', `emp_${A}`, { kind: 'employees' }), e => e.code === 'permission-denied');
  },
  'employeeList: own today/missions/leaves/excuses/history/notifications only; notifications update = read flags only': async (file, tag) => {
    const cid = `cEmpL${tag}`;
    await seedCompany(cid);
    for (const eid of ['e1', 'e2']) {
      await seed.ref(`companies/${cid}/employees/${eid}`).set({ status: 'approved', name: eid, empId: eid, warehouseId: 'w1' });
      await seed.ref(`access/u_${eid}_${cid}`).set({ role: 'employee', companyId: cid, employeeId: eid, enabled: true, version: 1 });
    }
    await seed.ref(`companies/${cid}/today`).set({ e1: { dateKey: '2026-11-17', checkIn: 'x' }, e2: { dateKey: '2026-11-17', checkIn: 'secret-e2' } });
    for (const c of ['missions', 'leaves', 'excuses', 'records']) await seed.ref(`companies/${cid}/${c}`).set({ [`${c}1`]: { empId: 'e1', date: '2026-11-17', status: 'pending', dateKey: '2026-11-17' }, [`${c}2`]: { empId: 'e2', date: '2026-11-17', status: 'pending', dateKey: '2026-11-17', note: 'secret-e2' } });
    await seed.ref(`companies/${cid}/notifications`).set({ e1: { n1: { message: 'a', read: false }, n2: { message: 'b', read: false }, junk: 'x' }, e2: { n9: { message: 'secret-e2', read: false } } });
    const call = async data => JSON.parse(JSON.stringify(await loadServer(file).invoke('employeeList', `u_e1_${cid}`, data)));
    assert.equal((await call({ kind: 'today', employeeId: 'e2' })).value.checkIn, 'x', 'own today, the requested employeeId is ignored');
    for (const [kind, key] of [['missions', 'missions1'], ['leaves', 'leaves1'], ['excuses', 'excuses1'], ['history', 'records1']]) assert.deepEqual((await call({ kind })).order, [key], kind);
    const notes = await call({ kind: 'notifications' });
    assert.deepEqual(notes.order, ['junk', 'n1', 'n2']); assert.equal(JSON.stringify(notes).includes('secret-e2'), false);
    assert.deepEqual(await call({ kind: 'notificationsUpdate', updates: { 'n1/read': true, junk: null, 'n9/read': true } }), { updated: 2 });
    assert.deepEqual(await get(`companies/${cid}/notifications/e1`), { n1: { message: 'a', read: true }, n2: { message: 'b', read: false } }, 'n9 (not mine) ignored');
    assert.equal((await get(`companies/${cid}/notifications/e2/n9`)).read, false);
    assert.deepEqual(await call({ kind: 'notificationsUpdate', updates: { n2: null } }), { updated: 0 }, 'a real notification is never deleted by the employee');
    assert.ok(await get(`companies/${cid}/notifications/e1/n2`));
    for (const updates of [{ 'n2/message': 'x' }, { 'n2/read': 'yes' }, { '../x/read': true }]) await assert.rejects(call({ kind: 'notificationsUpdate', updates }), e => e.code === 'invalid-argument', JSON.stringify(updates));
    assert.equal((await call({ kind: 'status' })).value, 'active');
    await assert.rejects(call({ kind: 'records' }), e => e.code === 'invalid-argument');
    await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
    await assert.rejects(loadServer(file).invoke('employeeList', `mgr_${cid}`, { kind: 'today' }), e => e.code === 'permission-denied');
  },
  'managerSettings: time windows, holidays, zones, schedules, missions, activity notifications — own company, strict checks': async (file, tag) => {
    const A = `cSetA${tag}`, B = `cSetB${tag}`;
    for (const cid of [A, B]) { await seedCompany(cid); await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 }); await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', name: 'أحمد', empId: 'N1', warehouseId: 'w1' }); }
    const call = async (data, uid = `mgr_${A}`) => JSON.parse(JSON.stringify(await loadServer(file).invoke('managerSettings', uid, data)));
    const w = (from, to) => ({ from, to });
    await call({ action: 'timeWindows', checkIn: w('07:30', '08:30'), checkOut: w('15:00', '16:00'), companyId: B });
    assert.deepEqual((await get(`companies/${A}/settings`)).checkIn, w('07:30', '08:30')); assert.deepEqual((await get(`companies/${B}/settings`)).checkIn, settings.checkIn, 'B unchanged');
    assert.equal((await get(`companies/${A}/settings`)).weekendDays[0], 9, 'other settings kept (update, not replace)');
    const { id: holiday } = await call({ action: 'holidayAdd', date: '2026-12-02', name: 'اليوم الوطني' });
    assert.deepEqual(await get(`companies/${A}/settings/holidays/${holiday}`), { date: '2026-12-02', name: 'اليوم الوطني', active: true });
    await call({ action: 'holidayRemove', id: holiday }); assert.equal(await get(`companies/${A}/settings/holidays/${holiday}`), null);
    await call({ action: 'geoZone', geoZone: { enabled: true, zones: [{ lat: 24.7, lng: 46.6, radius: 300.6, name: 'المقر' }] } });
    assert.deepEqual(await get(`companies/${A}/settings/geoZone`), { enabled: true, zones: [{ lat: 24.7, lng: 46.6, radius: 301, name: 'المقر' }] });
    await call({ action: 'employeeSchedule', employeeId: 'e1', schedule: { checkIn: w('09:00', '10:00'), checkOut: w('17:00', '18:00') } });
    assert.deepEqual((await get(`companies/${A}/employees/e1`)).schedule.checkIn, w('09:00', '10:00'));
    await call({ action: 'employeeSchedule', employeeId: 'e1', schedule: null }); assert.equal(await get(`companies/${A}/employees/e1/schedule`), null);
    const { id: mission } = await call({ action: 'missionAdd', mission: { empId: 'e1', location: 'العميل', description: 'تسليم', date: '2026-11-18', expectedTime: '10:00', status: 'completed', empName: 'fake' } });
    const saved = await get(`companies/${A}/missions/${mission}`);
    assert.equal(saved.status, 'assigned', 'status set by the server'); assert.equal(saved.empName, 'أحمد', 'name from the employee record'); assert.equal(saved.location, 'العميل');
    await call({ action: 'missionUpdate', id: mission, mission: { location: 'موقع جديد', empId: 'e1', empName: 'x', description: '', date: '2026-11-19', expectedTime: '' } });
    assert.equal((await get(`companies/${A}/missions/${mission}`)).location, 'موقع جديد');
    await call({ action: 'missionUpdate', id: mission, mission: { status: 'completed', completedAt: 'client-time' } });
    const done = await get(`companies/${A}/missions/${mission}`); assert.equal(done.status, 'completed'); assert.notEqual(done.completedAt, 'client-time');
    await seed.ref(`companies/${A}/notifications/admin`).set({ n1: { message: 'm', read: false }, n2: { message: 'm', read: false } });
    await call({ action: 'adminNotificationsRead', updates: { 'n1/read': true } }); assert.equal((await get(`companies/${A}/notifications/admin/n1`)).read, true);
    const refused = [{ action: 'timeWindows', checkIn: w('7:30', '08:30'), checkOut: w('15:00', '16:00') }, { action: 'holidayAdd', date: '2026-02-30', name: 'x' }, { action: 'holidayAdd', date: '2026-12-01', name: '<i>' },
      { action: 'geoZone', geoZone: { enabled: 'yes', zones: [] } }, { action: 'geoZone', geoZone: { enabled: true, zones: [{ lat: 100, lng: 0, radius: 10 }] } }, { action: 'geoZone', geoZone: { enabled: true, zones: Array(21).fill({ lat: 1, lng: 1, radius: 10 }) } },
      { action: 'missionAdd', mission: { empId: 'e1', location: '', date: '2026-11-18' } }, { action: 'missionUpdate', id: mission, mission: { status: 'assigned' } }, { action: 'missionUpdate', id: mission, mission: { actor: 'x' } },
      { action: 'adminNotificationsRead', updates: { 'n2/message': 'x' } }, { action: 'employeeSchedule', employeeId: 'e1', schedule: { checkIn: w('09:00', '25:00'), checkOut: w('17:00', '18:00') } }, { action: 'deleteCompany' }];
    for (const data of refused) await assert.rejects(call(data), e => e.code === 'invalid-argument', JSON.stringify(data));
    await assert.rejects(call({ action: 'missionAdd', mission: { empId: 'nobody', location: 'x', date: '2026-11-18' } }), e => e.code === 'not-found');
    await assert.rejects(call({ action: 'employeeSchedule', employeeId: 'nobody', schedule: null }), e => e.code === 'not-found');
    await call({ action: 'missionRemove', id: mission }); assert.equal(await get(`companies/${A}/missions/${mission}`), null);
    await call({ action: 'adminNotificationsClear' }); assert.equal(await get(`companies/${A}/notifications/admin`), null);
    await seed.ref(`access/emp_${A}`).set({ role: 'employee', companyId: A, employeeId: 'e1', enabled: true, version: 1 });
    await assert.rejects(call({ action: 'adminNotificationsClear' }, `emp_${A}`), e => e.code === 'permission-denied');
    // Badges: keys only, inside managerHome (no extra call on open) and from managerList.
    await seed.ref(`companies/${A}/leaves`).set({ l1: { empId: 'e1', date: '2026-11-17', status: 'pending' }, l2: { empId: 'e1', date: '2026-11-17', status: 'approved' } });
    await seed.ref(`companies/${A}/notifications/admin`).set({ u1: { message: 'secret-text', read: false } });
    const home = JSON.parse(JSON.stringify(await loadServer(file).invoke('managerHome', `mgr_${A}`)));
    assert.deepEqual(home.badges, { status: 'active', leaves: ['l1'], excuses: [], assigned: [], started: [], unread: ['u1'], devices: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(await loadServer(file).invoke('managerList', `mgr_${A}`, { kind: 'badges' }))), home.badges);
    assert.equal(JSON.stringify(home.badges).includes('secret-text'), false);
  },
  'sellerData: seller only; transactions and notifications; validated transaction with company name from the server': async (file, tag) => {
    const cid = `cSel${tag}`; await seedCompany(cid); await seed.ref(`companies/${cid}/info/plan`).set('pro');
    await seed.ref('seller/notifications').set({ s1: { message: 'x', read: false } });
    const call = async (data, uid = 'seller') => JSON.parse(JSON.stringify(await loadServer(file).invoke('sellerData', uid, data)));
    const { id } = await call({ kind: 'addTransaction', transaction: { companyId: cid, companyName: 'fake', plan: 'fake', amount: 150, dateStr: '2026-11-17', note: 'دفعة' } });
    const saved = await get(`seller/transactions/${id}`);
    assert.equal(saved.companyName, 'شركة'); assert.equal(saved.plan, 'pro'); assert.equal(saved.amount, 150); assert.equal(saved.date, Date.parse('2026-11-17T00:00:00Z'));
    assert.ok((await call({ kind: 'transactions' })).order.includes(id));
    assert.deepEqual(await call({ kind: 'notificationsUpdate', updates: { 's1/read': true } }), { updated: 1 });
    for (const t of [{ companyId: cid, amount: -1, dateStr: '2026-11-17' }, { companyId: cid, amount: 5, dateStr: 'x' }, { companyId: '../x', amount: 5, dateStr: '2026-11-17' }, { companyId: cid, amount: 5, dateStr: '2026-11-17', note: '<b>' }])
      await assert.rejects(call({ kind: 'addTransaction', transaction: t }), e => e.code === 'invalid-argument', JSON.stringify(t));
    await assert.rejects(call({ kind: 'addTransaction', transaction: { companyId: 'nope', amount: 5, dateStr: '2026-11-17' } }), e => e.code === 'not-found');
    await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
    await assert.rejects(call({ kind: 'transactions' }, `mgr_${cid}`), e => e.code === 'permission-denied');
  },
  'managerBranch: add, rename, hours, location, delete in own company only, with strict checks': async (file, tag) => {
    const A = `cBrA${tag}`, B = `cBrB${tag}`;
    for (const cid of [A, B]) { await seedCompany(cid); await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 }); }
    const call = (data, uid = `mgr_${A}`) => loadServer(file).invoke('managerBranch', uid, data);
    const { id } = await call({ action: 'add', name: '  فرع جديد  ', companyId: B });
    assert.deepEqual(await get(`companies/${A}/warehouses/${id}`), { name: 'فرع جديد', active: true });
    assert.equal(Object.keys(await get(`companies/${B}/warehouses`)).length, 1, 'company B unchanged');
    await call({ action: 'rename', id, name: 'الفرع الشمالي' });
    await call({ action: 'schedule', id, schedule: { checkIn: { from: '08:00', to: '09:00' }, checkOut: { from: '16:00', to: '17:30' } } });
    await call({ action: 'geoZone', id, geoZone: { lat: 24.71, lng: 46.67, radius: 250.4 } });
    assert.deepEqual(await get(`companies/${A}/warehouses/${id}`), { name: 'الفرع الشمالي', active: true, schedule: { checkIn: { from: '08:00', to: '09:00' }, checkOut: { from: '16:00', to: '17:30' } }, geoZone: { lat: 24.71, lng: 46.67, radius: 250, enabled: true } });
    await call({ action: 'schedule', id, schedule: null });
    assert.equal(await get(`companies/${A}/warehouses/${id}/schedule`), null);
    const refused = [{ action: 'add', name: '<b>x</b>' }, { action: 'add', name: '' }, { action: 'rename', id, name: 'x'.repeat(81) }, { action: 'schedule', id, schedule: { checkIn: { from: '25:00', to: '09:00' }, checkOut: { from: '16:00', to: '17:00' } } },
      { action: 'geoZone', id, geoZone: { lat: 91, lng: 0, radius: 100 } }, { action: 'geoZone', id, geoZone: { lat: 1, lng: 1, radius: 0 } }, { action: 'pin', id }, { action: 'rename', id: '../info', name: 'x' }];
    for (const data of refused) await assert.rejects(call(data), e => e.code === 'invalid-argument', JSON.stringify(data));
    await call({ action: 'delete', id: 'w1' }, `mgr_${B}`);
    assert.equal(await get(`companies/${B}/warehouses/w1`), null, 'B deletes its own w1');
    assert.ok(await get(`companies/${A}/warehouses/w1`), 'company A w1 untouched by B');
    await assert.rejects(call({ action: 'rename', id: 'nope', name: 'x' }), e => e.code === 'not-found');
    await call({ action: 'delete', id });
    assert.equal(await get(`companies/${A}/warehouses/${id}`), null);
    await seed.ref(`access/emp_${A}`).set({ role: 'employee', companyId: A, employeeId: 'e1', enabled: true, version: 1 });
    await seed.ref(`companies/${A}/employees/e1`).set({ status: 'approved', name: 'E', warehouseId: 'w1' });
    await assert.rejects(call({ action: 'add', name: 'x' }, `emp_${A}`), e => e.code === 'permission-denied');
    const audit = Object.values((await get('audit')) || {}).filter(a => a.actor === `mgr_${A}` && String(a.action).startsWith('branch.'));
    assert.deepEqual(audit.map(a => a.action), ['branch.add', 'branch.rename', 'branch.schedule', 'branch.geoZone', 'branch.schedule', 'branch.delete']);
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
// Owner decision (22 Nov 2026): an excuse exists for LATENESS only; absence cannot be excused (only an approved leave covers it).
test('EXCUSES — absence excuses are refused; a lateness excuse after a late check-in is accepted, approved, and does not touch the ledger', async () => {
  const cid = 'cExcLate', emp = 'emp_exc_late', mgr = 'mgr_exc_late';
  await seedCompany(cid);
  await seed.ref(`companies/${cid}/settings/startTime`).set('00:00'); // a start time is set, so a check-in after it is late
  await seed.ref(`companies/${cid}/employees/e1`).set({ status: 'approved', credId: 'cred-1', name: 'E', warehouseId: 'w1', warehouseName: 'Branch' });
  await seed.ref(`access/${emp}`).set({ role: 'employee', companyId: cid, employeeId: 'e1', enabled: true, version: 1 });
  await seed.ref(`credentials/${emp}`).set({ id: 'cred-1', publicKey: 'a2V5', counter: 0, transports: [] }); // the employee's own credential (registered before v5.15: no device entry = approved)
  await seed.ref(`access/${mgr}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
  const call = (name, uid, data) => loadServer(CURRENT).invoke(name, uid, data);
  for (const type of ['no_checkin', 'no_checkout', 'no_both']) await assert.rejects(call('submitRequest', emp, { kind: 'excuse', type, reason: 'x' }), e => /للتأخير فقط/.test(e.message), type);
  await assert.rejects(call('submitRequest', emp, { kind: 'excuse', type: 'late', reason: 'زحمة' }), e => /بعد تسجيل حضور متأخر/.test(e.message), 'no check-in yet');
  await seed.ref(`proofs/${emp}/p1`).set({ intent: 'in', version: 1, expiresAt: Date.now() + 60000 });
  const checkIn = await call('recordAttendance', emp, { type: 'in', proof: 'p1', location: { lat: 0, lng: 0 } });
  const ledgerPath = `attendanceLedger/${cid}/e1/${checkIn.date}`, delay = (await get(ledgerPath)).events.in.delayMins;
  assert.ok(delay > 0 || new Date().getUTCHours() * 60 + new Date().getUTCMinutes() === 0, 'late = minutes after the start time');
  if (delay > 0) {
    assert.equal((await call('submitRequest', emp, { kind: 'excuse', type: 'late', reason: 'زحمة' })).ok, true);
    const [id, excuse] = Object.entries(await get(`companies/${cid}/excuses`))[0];
    assert.equal(excuse.type, 'late'); assert.equal(excuse.delayMins, delay);
    const note = Object.values(await get(`companies/${cid}/notifications/admin`)).find(n => n.type === 'excuse_new'); assert.ok(note, 'the manager is notified');
    const before = JSON.stringify(await get(ledgerPath));
    assert.equal((await call('reviewRequest', mgr, { collection: 'excuses', id, status: 'approved' })).ok, true);
    assert.equal(JSON.stringify(await get(ledgerPath)), before, 'approval changes only the label, never the attendance ledger');
  }
  // An old-style absence excuse still pending from before cannot be approved (only rejected).
  await seed.ref(`companies/${cid}/excuses/old1`).set({ empId: 'e1', type: 'no_both', status: 'pending', date: checkIn.date, dateSource: 'server', createdAt: Date.now(), dateTimeZone: 'UTC' });
  await assert.rejects(call('reviewRequest', mgr, { collection: 'excuses', id: 'old1', status: 'approved' }), e => /لم يعد معتمدًا/.test(e.message));
  assert.equal((await call('reviewRequest', mgr, { collection: 'excuses', id: 'old1', status: 'rejected' })).ok, true);
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
  await seed.ref('credentials/emp_c').set({ id: 'cred-1', publicKey: 'a2V5', counter: 0, transports: [] }); // the employee's own credential (registered before v5.15: no device entry = approved)
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
  await seed.ref(`access/mgr_${cid}`).set({ role: 'manager', companyId: cid, enabled: true, version: 1, retentionConsent: 1 });
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
