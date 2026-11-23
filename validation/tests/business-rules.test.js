'use strict';
// v5.17 business rules (owner decisions of 22 Nov 2026) in the shared report model. Rules apply from 2026-12-01;
// earlier months keep the v1 rules (never recalculated differently).
const test = require('node:test'), assert = require('node:assert/strict');
const R = require('../public/assets/report-model.js');
const TZ = 'Asia/Baghdad';
const settings = { weekendDays: [5], holidays: { h1: { date: '2026-12-10', name: 'عطلة', active: true } } };
const warehouses = { w1: { name: 'الفرع', schedule: { startTime: '08:00' } }, w2: { name: 'فرع السبت', workDays: [6, 0, 1, 2, 3] } };
const emp = (extra = {}) => ({ name: 'أحمد', empId: 'A1', warehouseId: 'w1', warehouseName: 'الفرع', status: 'approved', createdAt: Date.parse('2026-01-01T00:00:00Z'), ...extra });
const rec = (empId, date, type, time, extra = {}) => ({ empId, type, dateKey: date, timestamp: `${date}T${time}:00.000Z`, warehouseId: 'w1', warehouseName: 'الفرع', ...extra });
const build = (o) => R.build({ settings, warehouses, timeZone: TZ, today: '2026-12-31', ...o });

test('work days: employee override, else branch, else company weekend; holidays are not work days', () => {
  assert.deepEqual(R.workDaysOf(settings, warehouses.w1, emp()), [0, 1, 2, 3, 4, 6], 'company: every day except Friday');
  assert.deepEqual(R.workDaysOf(settings, warehouses.w2, emp({ warehouseId: 'w2' })), [0, 1, 2, 3, 6], 'branch days');
  assert.deepEqual(R.workDaysOf(settings, warehouses.w2, emp({ workDays: [5] })), [5], 'employee override wins');
  assert.equal(R.isWorkDay(settings, warehouses.w1, emp(), '2026-12-10'), false, 'holiday');
  assert.equal(R.isWorkDay(settings, warehouses.w1, emp(), '2026-12-11'), false, 'Friday');
  assert.equal(R.isWorkDay(settings, warehouses.w1, emp(), '2026-12-12'), true, 'Saturday');
});

test('start time: employee, else branch, else company; not set = nobody is late', () => {
  assert.equal(R.startTimeOf(settings, warehouses.w1, emp()), '08:00');
  assert.equal(R.startTimeOf(settings, warehouses.w1, emp({ schedule: { startTime: '09:30' } })), '09:30');
  assert.equal(R.startTimeOf({}, {}, emp()), null);
});

test('day status v2: present, late (display), late excused, no check-out, leave paid/unpaid, non-work day, absent', () => {
  const employees = { e1: emp() };
  const records = {
    a: rec('e1', '2026-12-01', 'in', '05:20', { delayMins: 20 }), b: rec('e1', '2026-12-01', 'out', '13:00'),
    c: rec('e1', '2026-12-02', 'in', '05:05', { delayMins: 5 }),
    d: rec('e1', '2026-12-03', 'in', '05:00')
  };
  const leaves = { l1: { empId: 'e1', date: '2026-12-05', status: 'approved', leaveType: 'paid' }, l2: { empId: 'e1', date: '2026-12-06', status: 'approved', leaveType: 'unpaid' }, l3: { empId: 'e1', date: '2026-12-07', status: 'pending', leaveType: 'paid' } };
  const excuses = { x1: { empId: 'e1', date: '2026-12-02', type: 'late', status: 'approved' }, x2: { empId: 'e1', date: '2026-12-01', type: 'late', status: 'rejected' } };
  const rows = Object.fromEntries(build({ employees, records, leaves, excuses, from: '2026-12-01', to: '2026-12-11' }).map(r => [r.date, r]));
  assert.equal(rows['2026-12-01'].statusLabel, 'انصرف — متأخر'); assert.equal(rows['2026-12-01'].classification, 'present');
  assert.equal(rows['2026-12-02'].statusLabel, 'لم يسجل انصرافًا — متأخر (بعذر)', 'approved late excuse; forgotten check-out is marked, not fixed');
  assert.equal(rows['2026-12-02'].classification, 'present', 'forgotten check-out = present, no pay cut');
  assert.equal(rows['2026-12-03'].late, null, 'no delay recorded = not late');
  assert.equal(rows['2026-12-04'].classification, 'holiday', '4 Dec 2026 is a Friday');
  assert.equal(rows['2026-12-08'].classification, 'absent', 'a work day with nothing = absent');
  assert.equal(rows['2026-12-05'].classification, 'leave'); assert.equal(rows['2026-12-06'].classification, 'unpaid_leave');
  assert.equal(rows['2026-12-07'].classification, 'absent', 'a pending leave does not cover the day');
  assert.equal(rows['2026-12-10'].classification, 'holiday'); assert.equal(rows['2026-12-11'].classification, 'holiday', 'Friday is not a work day');
});

test('absence cannot be excused: an old-style approved excuse record does not change a v2 absent day', () => {
  const rows = build({ employees: { e1: emp() }, records: { x: { empId: 'e1', type: 'excused', excuseType: 'no_both', dateKey: '2026-12-08', timestamp: '2026-12-08T10:00:00Z' } }, from: '2026-12-08', to: '2026-12-08' });
  assert.equal(rows[0].classification, 'absent');
});

test('months before December 2026 keep the v1 rules unchanged', () => {
  const rows = build({ employees: { e1: emp() }, records: { x: { empId: 'e1', type: 'excused', excuseType: 'no_both', dateKey: '2026-11-08', timestamp: '2026-11-08T10:00:00Z' } }, from: '2026-11-08', to: '2026-11-08' });
  assert.equal(rows[0].classification, 'excused', 'v1 still honours the old excuse in November');
  assert.equal(rows[0].rules, undefined);
});

test('payroll v2: whole-month work days, unpaid leave deducted, late never deducted, current month not inflated', () => {
  const employees = { e1: emp() }, month = '2026-12';
  const workDays = R.monthDates(month).filter(d => R.isWorkDay(settings, warehouses.w1, employees.e1, d)).length;
  assert.equal(workDays, 26, '31 days - 4 Fridays - 1 holiday');
  // Payroll opened on Dec 3: one absence (Dec 2) must cost 1/26 of the salary, not 1/2.
  const rows = build({ employees, records: { a: rec('e1', '2026-12-01', 'in', '06:00', { delayMins: 60 }), b: rec('e1', '2026-12-01', 'out', '14:00') }, from: '2026-12-01', to: '2026-12-02', today: '2026-12-03' });
  const { rows: pay } = R.payrollV2(rows, employees, { e1: { salary: 2600, deductionPercent: 100 } }, { month, settings, warehouses, timeZone: TZ });
  assert.equal(pay[0].workingDays, 26); assert.equal(pay[0].absentDays, 1); assert.equal(pay[0].deduction, 100, 'late on Dec 1 deducts nothing');
  assert.equal(pay[0].net, 2500);
  const unpaid = build({ employees, records: {}, leaves: { l: { empId: 'e1', date: '2026-12-01', status: 'approved', leaveType: 'unpaid' }, p: { empId: 'e1', date: '2026-12-02', status: 'approved', leaveType: 'paid' } }, from: '2026-12-01', to: '2026-12-02' });
  assert.equal(R.payrollV2(unpaid, employees, { e1: { salary: 2600, deductionPercent: 100 } }, { month, settings, warehouses, timeZone: TZ }).rows[0].deduction, 100, 'only the unpaid day');
});

test('payroll v2: an employee added or disabled mid-month is paid for employed work days only', () => {
  const month = '2026-12', fin = { e1: { salary: 2600, deductionPercent: 100 } };
  const joined = { e1: emp({ createdAt: Date.parse('2026-12-14T07:00:00Z') }) };
  const r1 = build({ employees: joined, records: {}, from: '2026-12-01', to: '2026-12-13' });
  assert.equal(r1.length, 0, 'no rows (and no absences) before the start date');
  const p1 = R.payrollV2(build({ employees: joined, records: {}, leaves: Object.fromEntries(R.monthDates(month).filter(d => d >= '2026-12-14').map(d => [d, { empId: 'e1', date: d, status: 'approved', leaveType: 'paid' }])), from: '2026-12-01', to: '2026-12-31' }), joined, fin, { month, settings, warehouses, timeZone: TZ }).rows[0];
  assert.equal(p1.employedDays, 16, 'Dec 14-31 minus Fridays 18 and 25'); assert.equal(p1.due, 1600); assert.equal(p1.deduction, 0);
  const left = { e1: emp({ status: 'rejected', disabledAt: Date.parse('2026-12-05T10:00:00Z') }) };
  const r2 = build({ employees: left, records: {}, from: '2026-12-01', to: '2026-12-31' });
  assert.ok(r2.length > 0 && r2.every(r => r.date <= '2026-12-05'), 'a disabled employee appears for employed days only');
  const p2 = R.payrollV2(r2, left, fin, { month, settings, warehouses, timeZone: TZ }).rows[0];
  assert.equal(p2.employedDays, 4, 'Dec 1-5 minus Friday Dec 4'); assert.equal(p2.due, 400);
});

test('payroll v2: an employee without salary data is listed as missing, not a crash', () => {
  const rows = build({ employees: { e1: emp() }, records: {}, from: '2026-12-01', to: '2026-12-01' });
  assert.deepEqual(R.payrollV2(rows, { e1: emp() }, {}, { month: '2026-12', settings, warehouses, timeZone: TZ }), { rows: [], missing: ['e1'] });
});

test('the server uses the SAME rules file as the pages (functions/report-model.js is an exact copy)', () => {
  const fs = require('node:fs'), path = require('node:path');
  assert.equal(fs.readFileSync(path.join(__dirname, '../functions/report-model.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../public/assets/report-model.js'), 'utf8'), 'copy public/assets/report-model.js to functions/');
});

// v5.18: permanent branch transfer. Each day uses the branch he was in on that day; the old branch name stays.
test('transfer: days before the move keep the old branch (name and work days); days after use the new branch', () => {
  const ws = { w1: { name: 'القديم' }, w2: { name: 'الجديد', workDays: [6, 0, 1, 2, 3] } }; // new branch: Sat-Wed
  const employee = emp({ warehouseId: 'w2', warehouseName: 'الجديد', branchHistory: { a: { at: Date.parse('2026-12-10T06:00:00Z'), from: 'w1', to: 'w2' } } });
  assert.equal(R.branchOn(employee, '2026-12-09', TZ), 'w1'); assert.equal(R.branchOn(employee, '2026-12-10', TZ), 'w2');
  assert.equal(R.branchOn(emp(), '2026-12-09', TZ), 'w1', 'no transfers = current branch');
  const rows = Object.fromEntries(R.build({ settings, warehouses: ws, timeZone: TZ, today: '2026-12-31', employees: { e1: employee }, records: {}, from: '2026-12-03', to: '2026-12-17' }).map(r => [r.date, r]));
  assert.equal(rows['2026-12-03'].warehouseName, 'القديم', 'history keeps the old branch name');
  assert.equal(rows['2026-12-03'].classification, 'absent', 'Thursday is a work day in the old branch');
  assert.equal(rows['2026-12-17'].classification, 'holiday', 'Thursday is NOT a work day in the new branch');
  assert.equal(rows['2026-12-17'].warehouseName, 'الجديد');
  // Payroll work days of the month follow the branch of each day.
  const pay = R.payrollV2(Object.values(rows), { e1: employee }, { e1: { salary: 2400, deductionPercent: 100 } }, { month: '2026-12', settings, warehouses: ws, timeZone: TZ }).rows[0];
  const expected = R.monthDates('2026-12').filter(d => R.isWorkDay(settings, ws[d < '2026-12-10' ? 'w1' : 'w2'], employee, d)).length;
  assert.equal(pay.workingDays, expected);
  // His own special work days still win over any branch.
  const own = { ...employee, workDays: [1] };
  assert.equal(R.isWorkDay(settings, ws.w2, own, '2026-12-14'), true); assert.equal(R.isWorkDay(settings, ws.w2, own, '2026-12-15'), false);
});
