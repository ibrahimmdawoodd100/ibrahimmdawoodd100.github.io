'use strict';
// Test data for the browser E2E run — LOCAL Firebase emulators only (never production). Every id starts with e2e-.
const fs = require('node:fs'), path = require('node:path');
const req = require('node:module').createRequire(require.resolve('../functions/package.json'));
const { initializeApp } = req('firebase-admin/app'), { getAuth } = req('firebase-admin/auth'), { getDatabase } = req('firebase-admin/database');
const PASSWORD = 'e2e-Local-Only-1!';
const ACCOUNTS = { seller: 'e2e-seller', manager: 'e2e-manager', employee: 'e2e-employee', employeeA: 'e2e-employee3', employeeB: 'e2e-employee4', employeeC: 'e2e-employee5' };
// Employee record per account (A/B: account-switch test on one phone; C: approved, for the open-app update test).
const EMPLOYEE_OF = { employee: 'e2e-emp1', employeeA: 'e2e-emp3', employeeB: 'e2e-emp4', employeeC: 'e2e-emp5' };
const BRANCH = { lat: 24.7136, lng: 46.6753, radius: 300 };
async function seed() {
  const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!host || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('E2E seed runs only against the local emulators');
  // The functions' queries need the project's real indexes in each namespace (the server and the browser may use either).
  const rules = fs.readFileSync(path.join(__dirname, '../database.rules.json'), 'utf8'), namespaces = ['demo-basma-default-rtdb', 'demo-basma'];
  for (const ns of namespaces) { const r = await fetch(`http://${host}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules }); if (!r.ok) throw Error(`rules not loaded into ${ns}`); }
  const admin = initializeApp({ projectId: 'demo-basma' }, 'e2e-seed'), auth = getAuth(admin);
  const uid = {};
  for (const [role, name] of Object.entries(ACCOUNTS)) {
    const user = await auth.createUser({ uid: name, email: `${name}@basma.app`, password: PASSWORD }); await auth.setCustomUserClaims(user.uid, { version: 1 }); uid[role] = user.uid;
  }
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10), cid = 'e2e-co';
  const info = { nameAr: 'e2e شركة الاختبار', nameEn: 'e2e Test Co', status: 'active', expiresAt: now + 30 * 864e5, timeZone: 'UTC', maxEmployees: 20, plan: 'pro', logo: '🧪' };
  const data = {
    [`access/${uid.seller}`]: { role: 'seller', enabled: true, version: 1 },
    [`access/${uid.manager}`]: { role: 'manager', companyId: cid, enabled: true, version: 1 },
    ...Object.fromEntries(Object.entries(EMPLOYEE_OF).map(([role, eid]) => [`access/${uid[role]}`, { role: 'employee', companyId: cid, employeeId: eid, enabled: true, version: 1 }])),
    // C registered a fingerprint before v5.15 (no device entry = approved): it can check in at once.
    [`credentials/${uid.employeeC}`]: { id: 'e2e-cred5', publicKey: 'a2V5', counter: 0, transports: [] },
    [`accountLinks/${cid}/manager`]: uid.manager, [`companyDirectory/${cid}`]: info, [`employeeIndex/${cid}/count`]: 5,
    [`companies/${cid}`]: {
      info, settings: { checkIn: { from: '00:00', to: '23:59' }, checkOut: { from: '00:00', to: '23:59' }, weekendDays: [9] },
      warehouses: { 'e2e-w1': { name: 'e2e الفرع الرئيسي', active: true, geoZone: { ...BRANCH, enabled: true } }, 'e2e-w2': { name: 'e2e الفرع الثاني', active: true, geoZone: { ...BRANCH, radius: 400, enabled: true } } }, // v5.18: transfer target
      employees: {
        'e2e-emp1': { name: 'e2e موظف البصمة', empId: 'E2E-1', role: 'فني', warehouseId: 'e2e-w1', warehouseName: 'e2e الفرع الرئيسي', status: 'pending_activation', createdAt: now },
        'e2e-emp3': { name: 'e2e موظف أ', empId: 'E2E-3', role: 'فني', warehouseId: 'e2e-w1', warehouseName: 'e2e الفرع الرئيسي', status: 'pending_activation', createdAt: now },
        'e2e-emp4': { name: 'e2e موظف ب', empId: 'E2E-4', role: 'فني', warehouseId: 'e2e-w1', warehouseName: 'e2e الفرع الرئيسي', status: 'pending_activation', createdAt: now },
        'e2e-emp5': { name: 'e2e موظف الجدول', empId: 'E2E-5', role: 'فني', warehouseId: 'e2e-w1', warehouseName: 'e2e الفرع الرئيسي', status: 'approved', credId: 'e2e-cred5', createdAt: now },
        'e2e-emp2': { name: 'e2e موظف السجلات', empId: 'E2E-2', role: 'محاسب', warehouseId: 'e2e-w1', warehouseName: 'e2e الفرع الرئيسي', status: 'approved', credId: 'e2e-cred', createdAt: now }
      },
      records: { 'e2e-r1': { empId: 'e2e-emp2', empName: 'e2e موظف السجلات', type: 'in', timestamp: new Date(now - 36e5).toISOString(), dateKey: today, warehouseId: 'e2e-w1', warehouseName: 'e2e الفرع الرئيسي', locStatus: 'approved', delayMins: 0 } },
      today: { 'e2e-emp2': { dateKey: today, empId: 'e2e-emp2', checkIn: new Date(now - 36e5).toISOString() } },
      leaves: { 'e2e-l1': { empId: 'e2e-emp2', empName: 'e2e موظف السجلات', warehouseName: 'e2e الفرع الرئيسي', date: today, status: 'pending', leaveType: 'paid', reason: 'e2e إجازة', createdAt: now } },
      excuses: { 'e2e-x1': { empId: 'e2e-emp2', empName: 'e2e موظف السجلات', warehouseName: 'e2e الفرع الرئيسي', date: today, status: 'pending', type: 'late', delayMins: 15, reason: 'e2e عذر', createdAt: now } },
      notifications: { 'e2e-emp1': { 'e2e-n1': { type: 'broadcast', message: 'e2e إشعار للموظف', timestamp: new Date(now).toISOString(), read: false } }, admin: { 'e2e-a1': { type: 'checkin', message: 'e2e نشاط', timestamp: new Date(now).toISOString(), read: false } } }
    },
    [`privatePayroll/${cid}/e2e-emp2`]: { salary: 1000, deductionPercent: 100 }
  };
  // Cost-budget volume (v5.16): 332 more companies x 30 employees (10,000 employees in total) and, in the test company,
  // 25 more employees with attendance records for this month and the previous month (for day/month/payroll views).
  const bulk = {}, day = d => new Date(now - d * 864e5).toISOString().slice(0, 10);
  for (let c = 1; c <= 332; c++) {
    const id = `e2e-bulk-${String(c).padStart(3, '0')}`, bulkInfo = { nameAr: `e2e شركة ${c}`, status: 'active', expiresAt: now + 30 * 864e5, timeZone: 'UTC', maxEmployees: 30, plan: 'pro' };
    bulk[`companyDirectory/${id}`] = bulkInfo; bulk[`companies/${id}/info`] = bulkInfo; bulk[`employeeIndex/${id}/count`] = 30;
    bulk[`companies/${id}/employees`] = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`e${i}`, { name: `موظف ${i}`, empId: `B${c}-${i}`, warehouseId: 'w1', warehouseName: 'فرع', status: 'approved', createdAt: now }]));
  }
  const records = {};
  for (let i = 0; i < 25; i++) {
    const eid = `e2e-vol-${i}`;
    bulk[`companies/${cid}/employees/${eid}`] = { name: `e2e حجم ${i}`, empId: `V${i}`, role: 'فني', warehouseId: 'e2e-w1', warehouseName: 'e2e الفرع الرئيسي', status: 'approved', createdAt: now - 90 * 864e5 };
    bulk[`privatePayroll/${cid}/${eid}`] = { salary: 1000 + i, deductionPercent: 100 };
    for (let d = 1; d <= 45; d++) { const key = day(d); for (const type of ['in', 'out']) records[`e2e-v-${eid}-${key}-${type}`] = { empId: eid, empName: `e2e حجم ${i}`, type, timestamp: `${key}T${type === 'in' ? '08' : '16'}:00:00.000Z`, dateKey: key, warehouseId: 'e2e-w1', warehouseName: 'e2e الفرع الرئيسي', locStatus: 'approved', delayMins: 0, lat: 24.7136, lng: 46.6753, accuracy: 12, locationName: 'e2e', actor: `uid-${eid}` }; }
  }
  for (const [k, v] of Object.entries(records)) bulk[`companies/${cid}/records/${k}`] = v;
  for (const ns of namespaces) { const db = getDatabase(initializeApp({ projectId: 'demo-basma', databaseURL: `http://${host}/?ns=${ns}` }, `e2e-${ns}`)); await db.ref().update(data); await db.ref().update(bulk); }
  return { password: PASSWORD, accounts: ACCOUNTS, branch: BRANCH, companyName: info.nameAr, today };
}
module.exports = { seed, PASSWORD, ACCOUNTS, BRANCH, EMPLOYEE_OF };
