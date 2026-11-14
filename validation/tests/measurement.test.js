'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {measure}=require('../scripts/measure-flows');
test('employee startup uses own home projection and two narrow live listeners, with no archive queries',async()=>{
 const x=await measure(path.join(__dirname,'..'),'employee');
 // ONE call opens the page (employeeHome carries the profile); the check-in functions are warmed in the background.
 assert.deepEqual(x.opening.callables.map(c=>c.name),['employeeHome','beginWebAuthn','finishWebAuthn','recordAttendance']);
 assert.equal(x.opening.freshLimitedUseRequests,0);
 // '.info/connected' is the SDK's local connection flag (connection watchdog), not a database read.
 assert.deepEqual(x.opening.reads.filter(r=>!r.path.startsWith('.info/')).map(r=>r.path).sort(),['companies/c1/info/status','companies/c1/today/e0']);
 assert.deepEqual(x.opening.errors,[]);
 assert.deepEqual(x.action.callables.map(c=>c.name),['beginWebAuthn','finishWebAuthn','recordAttendance','employeeHome']);
 assert.equal(x.action.freshLimitedUseRequests,0);assert.deepEqual(x.action.errors,[]);
});
test('manager opening bounds request reads and reuses metadata for attendance',async()=>{
 const x=await measure(path.join(__dirname,'..'),'manager');
 // Opening = profile + ONE managerHome call; the dashboard makes no direct reads of staff, settings or today's data.
 assert.deepEqual(x.opening.callables.map(c=>c.name),['managerHome']);assert.equal(x.action.functionCalls,0);
 assert.equal(x.opening.reads.some(r=>/^companies\/c1\/(info|employees|settings|warehouses|records|leaves|excuses)$/.test(r.path)&&r.kind==='once'),false);
 for(const r of x.opening.reads.filter(r=>/\/(leaves|excuses)$/.test(r.path)))assert.ok(r.order==='date'||r.order==='status');
 assert.equal(x.action.reads.some(r=>/\/(employees|settings|warehouses)$/.test(r.path)),false);
 assert.ok(x.action.reads.some(r=>r.path==='companies/c1/records'));
 assert.deepEqual(x.opening.errors,[]);assert.deepEqual(x.action.errors,[]);
});
test('adding resolved history outside October does not increase opening or monthly request payload',async()=>{
 const oldMode=process.env.BASMA_MEASUREMENT_MODE,oldAction=process.env.BASMA_MANAGER_ACTION,oldCount=process.env.BASMA_LEAVES_PER_EMPLOYEE;
 try{
  process.env.BASMA_MEASUREMENT_MODE='month-stability';process.env.BASMA_MANAGER_ACTION='month';const values=[];
  for(const count of [10,120,200]){process.env.BASMA_LEAVES_PER_EMPLOYEE=String(count);const x=await measure(path.join(__dirname,'..'),'manager');assert.deepEqual(x.opening.errors,[]);assert.deepEqual(x.action.errors,[]);values.push([x.opening.jsonPayloadBytes,x.action.jsonPayloadBytes]);}
  assert.deepEqual(values[0],values[1]);assert.deepEqual(values[1],values[2]);
 }finally{for(const [name,value]of [['BASMA_MEASUREMENT_MODE',oldMode],['BASMA_MANAGER_ACTION',oldAction],['BASMA_LEAVES_PER_EMPLOYEE',oldCount]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});
