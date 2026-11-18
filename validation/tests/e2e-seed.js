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
      warehouses: { 'e2e-w1': { name: 'e2e الفرع الرئيسي', active: true, geoZone: { ...BRANCH, enabled: true } } },
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
      excuses: { 'e2e-x1': { empId: 'e2e-emp2', empName: 'e2e موظف السجلات', warehouseName: 'e2e الفرع الرئيسي', date: today, status: 'pending', type: 'no_checkout', reason: 'e2e عذر', createdAt: now } },
      notifications: { 'e2e-emp1': { 'e2e-n1': { type: 'broadcast', message: 'e2e إشعار للموظف', timestamp: new Date(now).toISOString(), read: false } }, admin: { 'e2e-a1': { type: 'checkin', message: 'e2e نشاط', timestamp: new Date(now).toISOString(), read: false } } }
    },
    [`privatePayroll/${cid}/e2e-emp2`]: { salary: 1000, deductionPercent: 100 }
  };
  for (const ns of namespaces) await getDatabase(initializeApp({ projectId: 'demo-basma', databaseURL: `http://${host}/?ns=${ns}` }, `e2e-${ns}`)).ref().update(data);
  return { password: PASSWORD, accounts: ACCOUNTS, branch: BRANCH, companyName: info.nameAr, today };
}
module.exports = { seed, PASSWORD, ACCOUNTS, BRANCH, EMPLOYEE_OF };
