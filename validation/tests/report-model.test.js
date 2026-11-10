'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),M=require('../public/assets/report-model'),policy=require('../functions/policy');
const employees={e1:{name:'موظف',empId:'001',status:'approved',warehouseId:'new',warehouseName:'الجديد',salary:999999}};
test('all display summaries agree with server ledger semantics',()=>{
  for(const events of [{},{in:{timestamp:'2026-10-12T08:00:00Z'}},{excused:{excuseType:'no_both'}},{excused:{excuseType:'no_checkin'},out:{timestamp:'2026-10-12T16:00:00Z'}},{in:{timestamp:'2026-10-12T08:00:00Z'},out:{timestamp:'2026-10-12T16:00:00Z'}}]){
    const expected=policy.attendanceSummary({events}),actual=M.summary(events);for(const key of Object.keys(actual))assert.equal(actual[key],expected[key]);
  }
});
test('late-approved excuse belongs to its server dateKey rather than the approval timestamp',()=>{
  const records={r1:{empId:'e1',type:'excused',excuseType:'no_both',timestamp:'2026-10-15T12:00:00Z',dateKey:'2026-10-12'}};
  const rows=M.build({records,employees,from:'2026-10-12',to:'2026-10-12'});
  assert.equal(rows[0].statusLabel,'انصرف (بعذر)');assert.equal(rows[0].actualWorkMinutes,null);assert.equal(rows[0].checkIn,null);
});
test('branch filter follows recorded history after transfer rather than rewriting old attendance',()=>{
  const record={empId:'e1',type:'in',timestamp:'2026-10-12T08:00:00Z',dateKey:'2026-10-12',warehouseId:'old',warehouseName:'القديم'};
  const args={records:{record},employees,from:'2026-10-12',to:'2026-10-12'};
  assert.equal(M.build({...args,warehouseId:'old'}).length,1);assert.equal(M.build({...args,warehouseId:'new'}).length,0);
});
test('payroll uses private values, exempts approved excuses, and keeps daily details',()=>{
  const records={r1:{empId:'e1',type:'excused',excuseType:'no_both',timestamp:'2026-10-12T08:00:00Z',dateKey:'2026-10-12'}};
  const days=M.build({records,employees,from:'2026-10-12',to:'2026-10-13'});
  const [row]=M.payroll(days,employees,{e1:{salary:500,deductionPercent:50}});
  assert.equal(row.salary,500);assert.equal(row.absentDays,1);assert.equal(row.deduction,125);assert.equal(row.net,375);assert.equal(row.days.length,2);
  assert.throws(()=>M.payroll(days,employees,{}),/غير مكتملة/);
});
test('holidays and approved full-day leave do not count as absence',()=>{
  const days=M.build({employees,leaves:{l1:{empId:'e1',date:'2026-10-17',status:'approved',leaveType:'paid'}},from:'2026-10-16',to:'2026-10-17'});
  assert.deepEqual(days.map(d=>d.classification),['holiday','leave']);assert.equal(M.payroll(days,employees,{e1:{salary:500,deductionPercent:100}})[0].absentDays,0);
});
