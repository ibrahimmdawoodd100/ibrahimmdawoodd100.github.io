'use strict';
// Offline integration tests exercise callable authorization and state transitions.
// The WebAuthn library is mocked here; signature verification needs the real library/emulator.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const policy = require('../functions/policy');
function harness({rpID='basma.example.org',origins='https://basma.example.org',now=null}={}) {
  let state = {}, serial = 0; const users = {}, optionsSeen = [], readPaths = [];
  const clone = value => value == null ? null : structuredClone(value);
  function get(path) { return path.split('/').filter(Boolean).reduce((value, key) => value?.[key], state) ?? null; }
  function set(path, value) { const keys = path.split('/').filter(Boolean); let at = state; for (const key of keys.slice(0, -1)) at = at[key] ||= {}; if (value == null) delete at[keys.at(-1)]; else at[keys.at(-1)] = clone(value); }
  const snap = value => ({ val: () => clone(value), exists: () => value !== null, numChildren: () => Object.keys(value || {}).length });
  function ref(path = '') {
    const filters={};
    return { key: path.split('/').at(-1), orderByChild(field){filters.field=field;return this;},orderByKey(){filters.byKey=true;return this;},limitToFirst(value){filters.first=value;return this;},startAfter(value){filters.after=value;return this;},equalTo(value){filters.equal=value;return this;},limitToLast(value){filters.limit=value;return this;},async get() { readPaths.push(path); const value=get(path);if(filters.byKey&&value&&typeof value==='object')return snap(Object.fromEntries(Object.entries(value).sort(([x],[y])=>x<y?-1:x>y?1:0).filter(([k])=>filters.after==null||k>filters.after).slice(0,filters.first||Infinity)));return snap(filters.field&&value?Object.fromEntries(Object.entries(value).filter(([,v])=>v[filters.field]===filters.equal).slice(-(filters.limit||200))):value); }, async set(value) { set(path, value); }, async remove() { set(path, null); }, async update(updates) { for (const [key,value] of Object.entries(updates)) set(`${path}/${key}`,value); },
      async transaction(fn) { const next = fn(clone(get(path))); if (next === undefined) return { committed:false, snapshot:snap(get(path)) }; set(path,next); return { committed:true,snapshot:snap(next) }; },
      push(value) { const child=ref(`${path}/k${++serial}`); if(value!==undefined) { child.set(value); return Promise.resolve(child); } return child; }
    };
  }
  const auth = { async createUser(value) { const uid=`u${++serial}`; users[uid]={uid,...value}; return users[uid]; }, async setCustomUserClaims(uid,claims) { (users[uid] ||= {uid}).claims=claims; }, async deleteUser(uid) { delete users[uid]; }, async updateUser(uid,value) { Object.assign(users[uid] ||= {uid},value); }, async revokeRefreshTokens(uid) { (users[uid] ||= {uid}).revoked=true; }, async getUser(uid) { return users[uid]; } };
  const db = { ref };
  class HttpsError extends Error { constructor(code,message,details) { super(message); this.code=code; this.details=details; } }
  const webauthn = {
    async generateRegistrationOptions() { return { challenge:`challenge${++serial}`,user:{id:'dQ'} }; },
    async generateAuthenticationOptions() { return { challenge:`challenge${++serial}` }; },
    async verifyRegistrationResponse(options) { optionsSeen.push(options); return { verified:options.response.valid === true, registrationInfo:{credential:{id:'credential1',publicKey:Buffer.from('key'),counter:0,transports:[]},credentialDeviceType:'singleDevice',credentialBackedUp:false} }; },
    async verifyAuthenticationResponse(options) { optionsSeen.push(options); return { verified:options.response.valid === true,authenticationInfo:{newCounter:options.credential.counter+1} }; }
  };
  const modules = {
    'node:crypto':require('node:crypto'), 'firebase-admin/app':{initializeApp(){}}, 'firebase-admin/database':{getDatabase:()=>db}, 'firebase-admin/auth':{getAuth:()=>auth}, 'firebase-admin/storage':{getStorage:()=>({})},
    'firebase-functions/v2/https':{onCall:(options,fn)=>{fn.options=options;return fn;},HttpsError},
    'firebase-functions/v2/database':{onValueWritten:(options,fn)=>fn}, 'firebase-functions/v2/scheduler':{onSchedule:(options,fn)=>fn},
    'firebase-functions/params':{defineString:name=>({value:()=>name==='WEBAUTHN_RP_ID'?rpID:origins})},
    '@simplewebauthn/server':webauthn, './policy':policy
  };
  const ServerDate=now===null?Date:class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  const context={exports:{},require:name=>{if(!modules[name])throw Error(name);return modules[name];},Buffer,console:{error(){}},Date:ServerDate,URL};
  vm.runInNewContext(fs.readFileSync(require.resolve('../functions/index.js'),'utf8'),context);
  const company={status:'active',expiresAt:Date.now()+86400000,timeZone:'UTC',maxEmployees:2};
  set('companies/c1/info',company); set('companies/c2/info',company);
  set('companies/c1/settings',{checkIn:{from:'00:00',to:'23:59'},checkOut:{from:'00:00',to:'23:59'},weekendDays:[9]});
  set('companies/c1/warehouses/w1',{active:true,name:'Branch'});
  set('companies/c1/employees/e1',{status:'pending_activation',name:'Employee',warehouseId:'w1',warehouseName:'Branch'});
  for(const [uid,role,cid,eid] of [['seller','seller'],['manager','manager','c1'],['employee','employee','c1','e1']]) set(`access/${uid}`,{role,companyId:cid||null,employeeId:eid||null,version:1,enabled:true});
  const invoke=(name,uid,data={},version=1)=>context.exports[name]({auth:uid?{uid,token:{version,auth_time:Date.now()/1000}}:null,app:{alreadyConsumed:false},data});
  return { api:context.exports, get,set,invoke,users,optionsSeen,readPaths };
}
test('callable layer rejects anonymous, suspended, stale, and cross-role calls',async()=>{
  const h=harness();
  for(const [name,uid,data,version] of [['profile',null,{},1],['companyStatus','manager',{companyId:'c2',status:'suspended'},1],['profile','employee',{},0]]) await assert.rejects(()=>h.invoke(name,uid,data,version));
  h.set('companies/c1/info/status','suspended');await assert.rejects(()=>h.invoke('profile','employee'));
  assert.equal(h.get('companies/c2/info/status'),'active');
});
test('WebAuthn registration verifies origin/RP/UV and challenge cannot be replayed',async()=>{
  const h=harness(), start=await h.invoke('beginWebAuthn','employee',{mode:'register'});
  await h.invoke('finishWebAuthn','employee',{challengeId:start.challengeId,response:{valid:true}});
  const seen=h.optionsSeen[0]; assert.equal(seen.expectedRPID,'basma.example.org'); assert.equal(seen.expectedOrigin[0],'https://basma.example.org'); assert.equal(seen.requireUserVerification,true);
  assert.equal(seen.expectedChallenge,start.options.challenge);
  await assert.rejects(()=>h.invoke('finishWebAuthn','employee',{challengeId:start.challengeId,response:{valid:true}}));
  await assert.rejects(()=>h.invoke('beginWebAuthn','employee',{mode:'register'}));
});
test('invalid verification cannot create credentials or attendance proofs',async()=>{
  const h=harness(),start=await h.invoke('beginWebAuthn','employee',{mode:'register'});
  await assert.rejects(()=>h.invoke('finishWebAuthn','employee',{challengeId:start.challengeId,response:{valid:false}}));
  assert.equal(h.get('credentials/employee'),null); assert.equal(h.get('proofs/employee'),null);
});
test('attendance requires matching one-use proof and derives employee identity server-side',async()=>{
  const h=harness();
  h.set('companies/c1/employees/e1/status','approved');
  h.set('proofs/employee/p1',{intent:'out',version:1,expiresAt:Date.now()+60000});
  await assert.rejects(()=>h.invoke('recordAttendance','employee',{type:'in',proof:'p1',location:{lat:0,lng:0}}));
  h.set('proofs/employee/p2',{intent:'in',version:1,expiresAt:Date.now()+60000});
  const data={type:'in',proof:'p2',employeeId:'victim',companyId:'c2',timestamp:'1990-01-01',location:{lat:0,lng:0}};
  const result=await h.invoke('recordAttendance','employee',data),value=h.get(`attendanceLedger/c1/e1/${result.date}/events/in`);
  assert.equal(value.empId,'e1');assert.equal(value.actor,'employee');assert.notEqual(value.timestamp,data.timestamp);
  assert.equal(h.get('attendanceLedger/c2'),null);
  await assert.rejects(()=>h.invoke('recordAttendance','employee',data));
  h.set('proofs/employee/p3',{intent:'in',version:1,expiresAt:Date.now()+60000});
  await assert.rejects(()=>h.invoke('recordAttendance','employee',{...data,proof:'p3'}));
});
test('reset rotates the existing account and old sessions fail immediately',async()=>{
  const h=harness(); h.users.manager={email:'manager@basma.app'};h.set('accountLinks/c1/manager','manager');
  const result=await h.invoke('resetManager','seller',{companyId:'c1'});
  assert.equal(result.uid,'manager'); assert.equal(h.get('access/manager/version'),2);assert.equal(h.users.manager.revoked,true);
  await assert.rejects(()=>h.invoke('profile','manager',{},1));assert.equal((await h.invoke('profile','manager',{},2)).role,'manager');
  assert.equal(h.get('companies/c1/info/managerPassword'),null);
});
test('company employee cap and unique IDs survive concurrent additions',async()=>{
  const h=harness(),data={name:'A',empId:'A1',role:'Worker',warehouseId:'w1',salary:1,deductionPercent:50};
  const results=await Promise.allSettled([h.invoke('addEmployee','manager',data),h.invoke('addEmployee','manager',data)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  await h.invoke('addEmployee','manager',{...data,empId:'A2'});
  await assert.rejects(()=>h.invoke('addEmployee','manager',{...data,empId:'A3'}));
  assert.equal(h.get('employeeIndex/c1/count'),2);
});
test('excuse date comes from the server; approval grants checkout through the ledger',async()=>{
  for(const type of ['no_checkin','no_both']){
    const h=harness();h.set('companies/c1/employees/e1/status','approved');
    await h.invoke('submitRequest','employee',{kind:'excuse',type,reason:'سبب',date:'1900-01-01',companyId:'c2',empId:'victim'});
    const [id,request]=Object.entries(h.get('companies/c1/excuses'))[0];
    assert.equal(request.date,new Date(request.createdAt).toISOString().slice(0,10));assert.equal(request.dateSource,'server');
    await h.invoke('reviewRequest','manager',{collection:'excuses',id,status:'approved'});
    const ledger=h.get(`attendanceLedger/c1/e1/${request.date}`);assert.equal(ledger.events.excused.excuseType,type);assert.equal(ledger.events.in,undefined);
    h.set('proofs/employee/outproof',{intent:'out',version:1,expiresAt:Date.now()+60000});
    await h.invoke('recordAttendance','employee',{type:'out',proof:'outproof',location:{lat:0,lng:0,accuracy:30}});
    const state=h.get(`attendanceLedger/c1/e1/${request.date}`);assert.equal(state.events.out.empId,'e1');assert.equal(state.events.in,undefined);
    await h.api.projectAttendance({params:{cid:'c1',eid:'e1',date:request.date}});
    assert.equal(h.get('companies/c1/today/e1/statusLabel'),'انصرف (بعذر)');assert.equal(h.get('companies/c1/today/e1/checkIn'),null);
  }
});
test('unapproved, rejected, malformed, and wrong-company excuses cannot grant checkout',async()=>{
  const h=harness();h.set('companies/c1/employees/e1/status','approved');
  await h.invoke('submitRequest','employee',{kind:'excuse',type:'no_checkin',reason:'سبب',date:'1900-01-01'});
  const [id]=Object.keys(h.get('companies/c1/excuses'));
  await h.invoke('reviewRequest','manager',{collection:'excuses',id,status:'rejected'});
  await assert.rejects(()=>h.invoke('reviewRequest','manager',{collection:'excuses',id,status:'approved'}));
  h.set('companies/c2/excuses/foreign',{empId:'e1',status:'pending'});
  await assert.rejects(()=>h.invoke('reviewRequest','manager',{collection:'excuses',id:'foreign',status:'approved'}));
  h.set('companies/c1/excuses/malformed',{empId:'e1',status:'pending',type:'no_both',date:'2026-01-01'});
  await assert.rejects(()=>h.invoke('reviewRequest','manager',{collection:'excuses',id:'malformed',status:'approved'}));
  h.set('proofs/employee/outproof',{intent:'out',version:1,expiresAt:Date.now()+60000});
  await assert.rejects(()=>h.invoke('recordAttendance','employee',{type:'out',proof:'outproof',location:{lat:0,lng:0}}));
});
test('salaries are private and payroll updates are manager-only',async()=>{
  const h=harness();
  const account=await h.invoke('addEmployee','manager',{name:'A',empId:'A1',role:'Worker',warehouseId:'w1',salary:550,deductionPercent:25});
  const employee=h.get(`companies/c1/employees/${account.employeeId}`);
  assert.equal(employee.salary,undefined);assert.equal(employee.deductionPercent,undefined);assert.equal(h.get(`privatePayroll/c1/${account.employeeId}/salary`),550);
  await assert.rejects(()=>h.invoke('setEmployeePayroll','employee',{employeeId:'e1',salary:900,deductionPercent:40}));
  await h.invoke('setEmployeePayroll','manager',{employeeId:'e1',salary:900,deductionPercent:40});assert.equal(h.get('privatePayroll/c1/e1/salary'),900);
});
test('branch transfer preserves historical attendance and checks the destination',async()=>{
  const h=harness();h.set('companies/c1/warehouses/w2',{active:true,name:'New Branch'});
  h.set('companies/c1/records/history',{empId:'e1',warehouseId:'w1'});
  await h.invoke('transferEmployee','manager',{employeeId:'e1',warehouseId:'w2'});
  assert.equal(h.get('companies/c1/employees/e1/warehouseId'),'w2');assert.equal(h.get('companies/c1/records/history/warehouseId'),'w1');
  await assert.rejects(()=>h.invoke('transferEmployee','manager',{employeeId:'e1',warehouseId:'foreign'}));
});
test('renewal extends from the later of expiry and server time, is idempotent, and retains suspension',async()=>{
  const h=harness(),expiry=Date.now()+86400000;h.set('companies/c1/info/expiresAt',expiry);h.set('companies/c1/info/status','suspended');
  const data={companyId:'c1',days:30,requestId:'renewal1'};
  const first=await h.invoke('renewSubscription','seller',data),second=await h.invoke('renewSubscription','seller',data);
  assert.equal(first.expiresAt,expiry+30*86400000);assert.equal(second.expiresAt,first.expiresAt);assert.equal(h.get('companies/c1/info/status'),'suspended');
  await assert.rejects(()=>h.invoke('renewSubscription','manager',data));
});
test('GitHub Pages origin and exact RP ID are accepted; scheme/path in RP ID is rejected',async()=>{
  const id='ibrahimmdawoodd100.github.io',h=harness({rpID:id,origins:`https://${id}`});
  const start=await h.invoke('beginWebAuthn','employee',{mode:'register'});
  await h.invoke('finishWebAuthn','employee',{challengeId:start.challengeId,response:{valid:true}});
  assert.equal(h.optionsSeen[0].expectedRPID,id);assert.equal(h.optionsSeen[0].expectedOrigin[0],`https://${id}`);
  for(const rpID of [`https://${id}`,`${id}/employee/`]){
    const invalid=harness({rpID,origins:`https://${id}`});await assert.rejects(()=>invalid.invoke('beginWebAuthn','employee',{mode:'register'}));
  }
});

for(const [name,zone,stamp,today,tomorrow] of [
  ['east midnight','Asia/Baghdad','2026-10-15T21:01:00Z','2026-10-16','2026-10-17'],
  ['west previous day','America/Los_Angeles','2026-10-16T01:00:00Z','2026-10-15','2026-10-16']
])test(`submitRequest server calendar: ${name}`,async()=>{
  const h=harness({now:Date.parse(stamp)});h.set('companies/c1/info/timeZone',zone);
  for(const leaveType of ['paid','unpaid','sick','emergency']){
    for(const date of ['2026-10-14',today])await assert.rejects(()=>h.invoke('submitRequest','employee',{kind:'leave',leaveType,date,reason:'سبب'}),/الغد/);
    await h.invoke('submitRequest','employee',{kind:'leave',leaveType,date:tomorrow,reason:'سبب'});
  }
  await assert.rejects(()=>h.invoke('submitRequest','employee',{kind:'leave',leaveType:'partial',date:'2026-10-14',reason:'سبب',fromTime:'12:00',toTime:'13:00'}),/اليوم/);
  for(const date of [today,tomorrow])await h.invoke('submitRequest','employee',{kind:'leave',leaveType:'partial',date,reason:'سبب',fromTime:'12:00',toTime:'13:00'});
  await assert.rejects(()=>h.invoke('submitRequest','employee',{kind:'leave',leaveType:'paid',date:'2027-02-30',reason:'سبب'}),/تاريخ/);
});
test('time rejection has a specific reason and server time without consuming biometric proof',async()=>{
  const stamp=Date.parse('2026-10-15T12:00:00Z'),h=harness({now:stamp});h.set('companies/c1/employees/e1/status','approved');
  h.set('companies/c1/settings/checkIn',{from:'14:00',to:'14:30'});
  h.set('proofs/employee/p1',{intent:'in',version:1,expiresAt:stamp+60000});
  await assert.rejects(()=>h.invoke('recordAttendance','employee',{type:'in',proof:'p1',location:{lat:0,lng:0}}),error=>error.details?.reason==='attendance-window'&&error.details.serverTime===stamp);
  assert.equal(h.get('proofs/employee/p1/used'),null);
});

test('approved partial leave permits biometric departure then return only within its server window',async()=>{
  const stamp=Date.parse('2026-10-15T12:10:00Z'),h=harness({now:stamp});h.set('companies/c1/employees/e1/status','approved');
  await h.invoke('submitRequest','employee',{kind:'leave',leaveType:'partial',date:'2026-10-15',reason:'سبب',fromTime:'12:00',toTime:'12:30'});
  const id=Object.keys(h.get('companies/c1/leaves'))[0];await h.invoke('reviewRequest','manager',{collection:'leaves',id,status:'approved'});
  for(const [type,proof]of [['in','p1'],['departure','p2'],['return','p3']]){
    h.set(`proofs/employee/${proof}`,{intent:type,version:1,expiresAt:stamp+60000});await h.invoke('recordAttendance','employee',{type,proof,location:{lat:0,lng:0}});
  }
  const events=h.get('attendanceLedger/c1/e1/2026-10-15/events');assert.ok(events.in&&events.departure&&events.return);
  await h.api.projectAttendance({params:{cid:'c1',eid:'e1',date:'2026-10-15'}});
  assert.equal(h.get('companies/c1/partialLeaveRecords/e1/2026-10-15/returnAt'),'2026-10-15T12:10:00.000Z');
  h.set('companies/c1/todayPartialLeave/e1/fromTime','13:00');h.set('companies/c1/todayPartialLeave/e1/toTime','14:00');
  h.set('proofs/employee/p4',{intent:'departure',version:1,expiresAt:stamp+60000});
  await assert.rejects(()=>h.invoke('recordAttendance','employee',{type:'departure',proof:'p4',location:{lat:0,lng:0}}),/إجازة زمنية/);
});

test('employeeHome returns only own profile and current schedule/state without histories or payroll',async()=>{
 const h=harness({now:Date.parse('2026-10-24T12:00:00Z')});
 h.set('companies/c1/employees/other',{name:'PRIVATE_COWORKER'});
 h.set('companies/c1/leaves/x',{empId:'e1',date:'2026-10-24',status:'approved',leaveType:'paid',reason:'PRIVATE_REASON'});
 h.set('companies/c1/leaves/y',{empId:'other',date:'2026-10-24',status:'approved',reason:'FOREIGN_REASON'});
 h.set('fullDayLeaveIndex/c1/e1/2026-10-24',true);
 h.set('privatePayroll/c1/e1',{salary:999});
 const home=await h.invoke('employeeHome','employee',{employeeId:'other',companyId:'c2'});
 assert.equal(home.employee.name,'Employee');assert.equal(home.onLeave,true);assert.equal(home.date,'2026-10-24');
 for(const secret of ['PRIVATE_COWORKER','PRIVATE_REASON','FOREIGN_REASON','salary'])assert.equal(JSON.stringify(home).includes(secret),false);
 await assert.rejects(()=>h.invoke('employeeHome','manager'));
});
test('ordinary App Check retains enforcement without token consumption on every endpoint',()=>{
 const h=harness();for(const name of ['profile','employeeHome','serverClock','recordAttendance','beginWebAuthn','finishWebAuthn']){assert.equal(h.api[name].options.enforceAppCheck,true);assert.notEqual(h.api[name].options.consumeAppCheckToken,true);}
});


test('full-day approval atomically projects own dated flag; retry preserves other approved dates',async()=>{
 const h=harness({now:Date.parse('2026-10-24T22:00:00Z')});
 h.set('companies/c1/info/timeZone','Asia/Baghdad');
 for(const [id,date] of [['a','2026-10-25'],['b','2026-10-26']]){
  h.set(`companies/c1/leaves/${id}`,{empId:'e1',date,status:'pending',leaveType:'paid',isPartial:false});
  await h.invoke('reviewRequest','manager',{collection:'leaves',id,status:'approved'});
  assert.equal(h.get(`fullDayLeaveIndex/c1/e1/${date}`),true);
  assert.equal(h.get(`companies/c1/leaves/${id}/status`),'approved');
 }
 await h.invoke('reviewRequest','manager',{collection:'leaves',id:'a',status:'approved'});
 assert.equal((await h.invoke('employeeHome','employee')).onLeave,true);
 assert.equal((await h.invoke('employeeHome','employee')).date,'2026-10-25');
 assert.equal(h.get('fullDayLeaveIndex/c1/e1/2026-10-26'),true);
 assert.equal(h.get('fullDayLeaveIndex/c2'),null);
});
test('partial and rejected leaves create no full-day flag; foreign dates and employees do not affect home',async()=>{
 const h=harness({now:Date.parse('2026-10-24T12:00:00Z')});
 for(const [id,partial,status] of [['p',true,'approved'],['r',false,'rejected']]){
  h.set(`companies/c1/leaves/${id}`,{empId:'e1',date:'2026-10-24',status:'pending',leaveType:partial?'partial':'paid',isPartial:partial,fromTime:'13:00',toTime:'14:00'});
  await h.invoke('reviewRequest','manager',{collection:'leaves',id,status});
 }
 assert.equal(h.get('fullDayLeaveIndex'),null);
 h.set('fullDayLeaveIndex/c1/e1/2026-10-25',true);
 h.set('fullDayLeaveIndex/c1/other/2026-10-24',true);
 h.set('fullDayLeaveIndex/c2/e1/2026-10-24',true);
 assert.equal((await h.invoke('employeeHome','employee',{date:'2026-10-25',employeeId:'other',companyId:'c2'})).onLeave,false);
});
test('home never consults leave history and does not infer approval from unprojected records',async()=>{
 const h=harness({now:Date.parse('2026-10-24T12:00:00Z')});
 for(let i=0;i<250;i++)h.set(`companies/c1/leaves/k${i}`,{empId:'e1',date:'2026-10-24',status:'approved',leaveType:'paid'});
 assert.equal((await h.invoke('employeeHome','employee')).onLeave,false);
 h.set('fullDayLeaveIndex/c1/e1/2026-10-24',true);
 assert.equal((await h.invoke('employeeHome','employee')).onLeave,true);
 assert.equal(h.readPaths.some(path=>path.includes('/leaves')),false);
 assert.equal(h.readPaths.filter(path=>path==='fullDayLeaveIndex/c1/e1/2026-10-24').length,2);
});

test('listCompanies returns the manager username for the seller panel, never a password', async () => {
  const h = harness();
  const created = await h.invoke('createCompany', 'seller', { nameAr: 'شركة', nameEn: 'Co', maxEmployees: 5, expiresAt: Date.now() + 86400000, timeZone: 'UTC', settings: { checkIn: { from: '08:00', to: '09:00' }, checkOut: { from: '16:00', to: '17:00' } } });
  assert.match(created.username, /^manager_[0-9a-f]{20}$/);
  h.set(`companyDirectory/${created.companyId}`, h.get(`companies/${created.companyId}/info`));
  h.set('companyDirectory/noLink', { nameAr: 'بلا مدير', status: 'active', expiresAt: Date.now() + 86400000 });
  const page = await h.invoke('listCompanies', 'seller', {});
  assert.equal(page.companies[created.companyId].managerUsername, created.username);
  assert.equal('managerUsername' in page.companies.noLink, false, 'no link: field left out, no guess');
  const text = JSON.stringify(page);
  assert.equal(text.includes(created.password), false, 'the password never appears');
  assert.equal(/password/i.test(text), false);
});

test('listCompanies username lookup survives a broken link and stays seller-only', async () => {
  const h = harness();
  h.set('companyDirectory/cBroken', { nameAr: 'x', status: 'active', expiresAt: Date.now() + 86400000 });
  h.set('accountLinks/cBroken/manager', 'uidThatDoesNotExist');
  const page = await h.invoke('listCompanies', 'seller', {});
  assert.equal('managerUsername' in page.companies.cBroken, false);
  await assert.rejects(h.invoke('listCompanies', 'manager', {}));
  await assert.rejects(h.invoke('listCompanies', 'employee', {}));
});
