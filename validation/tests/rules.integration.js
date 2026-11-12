'use strict';
// Run against Firebase Database Emulator, never a live project.
const fs=require('node:fs'),path=require('node:path'),test=require('node:test');
const {initializeTestEnvironment,assertFails,assertSucceeds}=require('@firebase/rules-unit-testing');
const {ref,set,get,update,query,orderByChild,equalTo,limitToLast,startAt,startAfter,endAt,limitToFirst}=require('firebase/database');
let env;
test.before(async()=>{
  if(!process.env.FIREBASE_DATABASE_EMULATOR_HOST)throw Error('Database emulator required.');
  const [host,port]=process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  env=await initializeTestEnvironment({projectId:'demo-basma',database:{host,port:Number(port),rules:fs.readFileSync(path.join(__dirname,'../database.rules.json'),'utf8')}});
});
test.after(async()=>env?.cleanup());
test.beforeEach(async()=>{
  await env.clearDatabase();await env.withSecurityRulesDisabled(async context=>set(ref(context.database()),{
    access:{manager:{role:'manager',companyId:'c1',enabled:true,version:2},employee:{role:'employee',companyId:'c1',employeeId:'e1',enabled:true,version:1},seller:{role:'seller',enabled:true,version:1}},
    companies:{c1:{info:{status:'active',expiresAt:Date.now()+3600000},employees:{e1:{name:'E',empId:'01',warehouseId:'w',status:'approved',credId:'key',createdAt:1},e2:{name:'Other'}},records:{r1:{empId:'e1',timestamp:'2026-10-10T08:00:00Z',type:'in',lat:0,lng:0,locStatus:'pending',delayMins:0,warehouseId:'w',actor:'employee'}},today:{e1:{checkIn:'test'}}},c2:{info:{status:'active',expiresAt:Date.now()+3600000},employees:{private:{name:'Private'}}}},
    credentials:{employee:{publicKey:'secret'}},audit:{a:{actor:'seller'}}
  }));
});
const db=(uid,version)=>env.authenticatedContext(uid,{version}).database();
test('anonymous access and cross-company manager reads/writes fail',async()=>{
  await assertFails(get(ref(env.unauthenticatedContext().database(),'companies/c1/info')));
  await assertFails(get(ref(db('manager',2),'companies/c2/employees')));
  await assertFails(set(ref(db('manager',2),'companies/c2/settings'),{x:1}));
  await assertSucceeds(get(ref(db('manager',2),'companies/c1/employees')));
});
test('employee may query own records but cannot enumerate coworkers or read credential keys',async()=>{
  const database=db('employee',1);
  await assertSucceeds(get(query(ref(database,'companies/c1/records'),orderByChild('empId'),equalTo('e1'),limitToLast(200))));
  await assertFails(get(query(ref(database,'companies/c1/records'),orderByChild('empId'),equalTo('e2'),limitToLast(200))));
  await assertFails(get(ref(database,'companies/c1/employees')));
  await assertFails(get(ref(database,'credentials/employee')));
});
test('employee cannot fabricate attendance, grant roles, or activate biometric identity',async()=>{
  const database=db('employee',1);
  for(const [location,value]of [['companies/c1/records/fake',{empId:'e1'}],['companies/c1/today/e1',{checkIn:'fake'}],['access/employee/role','seller'],['companies/c1/employees/e1/status','approved']])await assertFails(set(ref(database,location),value));
});
test('stale tokens and suspended-company sessions lose access',async()=>{
  await assertFails(get(ref(db('manager',1),'companies/c1/employees')));
  await env.withSecurityRulesDisabled(async context=>set(ref(context.database(),'companies/c1/info/status'),'suspended'));
  await assertFails(get(ref(db('manager',2),'companies/c1/employees')));
  await assertFails(get(ref(db('employee',1),'companies/c1/employees/e1')));
});
test('manager cannot delete proof fields, replace credentials, or change plan',async()=>{
  const database=db('manager',2);
  await assertFails(update(ref(database,'companies/c1/employees/e1'),{credId:null}));
  await assertFails(update(ref(database,'companies/c1/records/r1'),{lat:null}));
  await assertFails(update(ref(database,'companies/c1/records/r1'),{timestamp:'fake'}));
  await assertFails(set(ref(database,'companies/c1/info/maxEmployees'),99999));
  await assertFails(update(ref(database,'companies/c1/records/r1'),{locStatus:'approved'}));
});
test('audit cannot be modified by seller and self-provisioning is denied',async()=>{
  await assertFails(set(ref(db('seller',1),'audit/a'),{actor:'forged'}));
  await assertFails(set(ref(db('employee',1),'access/employee'),{companyId:'c2'}));
  // The derived leave projection is server-private under the existing root deny.
  for(const [uid,version] of [['employee',1],['manager',2],['seller',1]]){
    await assertFails(get(ref(db(uid,version),'fullDayLeaveIndex/c1/e1/2026-10-24')));
    await assertFails(set(ref(db(uid,version),'fullDayLeaveIndex/c1/e1/2026-10-24'),true));
  }
});
test('salary stays outside the employee-readable profile',async()=>{
  await env.withSecurityRulesDisabled(async context=>{
    await set(ref(context.database(),'privatePayroll/c1/e1'),{salary:700,deductionPercent:50});
  });
  await assertSucceeds(get(ref(db('employee',1),'companies/c1/employees/e1')));
  await assertFails(get(ref(db('employee',1),'privatePayroll/c1/e1')));
  await assertSucceeds(get(ref(db('manager',2),'privatePayroll/c1/e1')));
  await assertFails(set(ref(db('manager',2),'companies/c1/employees/e1/salary'),800));
});
test('manager must use server approval for excuses instead of direct database writes',async()=>{
  await env.withSecurityRulesDisabled(async context=>set(ref(context.database(),'companies/c1/excuses/x1'),{empId:'e1',status:'pending'}));
  await assertFails(update(ref(db('manager',2),'companies/c1/excuses/x1'),{status:'approved'}));
});

// Exercise the exact v5.2 pagination module against Firebase's real ordering and rules.
function managerDatabase(database){return {ref(location){let current=ref(database,location);const wrapper={orderByChild(field){current=query(current,orderByChild(field));return wrapper;},startAt(value){current=query(current,startAt(value));return wrapper;},startAfter(value,key){current=query(current,startAfter(value,key));return wrapper;},endAt(value){current=query(current,endAt(value));return wrapper;},limitToFirst(value){current=query(current,limitToFirst(value));return wrapper;},once:()=>get(current)};return wrapper;}};}
test('v5.2 real date cursor loads 2105 equal-date requests without skips or duplicates',async()=>{
 const leaves={};for(let i=0;i<2105;i++)leaves['k'+String(i).padStart(5,'0')]={date:'2026-10-15',empId:'e1',status:'approved'};
 leaves.old={date:'2026-09-30',empId:'e1',status:'approved'};leaves.next={date:'2026-11-01',empId:'e1',status:'approved'};
 await env.withSecurityRulesDisabled(async context=>set(ref(context.database(),'companies/c1/leaves'),leaves));
 const {pages}=require('../public/assets/manager-data'),result=await pages(managerDatabase(db('manager',2)),'c1','leaves',{from:'2026-10-01',to:'2026-10-31'});
 require('node:assert/strict').equal(Object.keys(result).length,2105);require('node:assert/strict').deepEqual(Object.keys(result).sort(),Object.keys(leaves).filter(key=>key!=='old'&&key!=='next').sort());
});
test('v5.2 real pending pages retain old requests, deduplicate month union and enforce company isolation',async()=>{
 const leaves={};for(let i=0;i<1005;i++)leaves['k'+String(i).padStart(5,'0')]={date:'2020-01-01',empId:'e1',status:'pending'};
 leaves.current={date:'2026-10-15',empId:'e1',status:'pending'};leaves.resolved={date:'2020-01-01',empId:'e1',status:'approved'};
 await env.withSecurityRulesDisabled(async context=>set(ref(context.database(),'companies/c1/leaves'),leaves));
 const {create}=require('../public/assets/manager-data'),database=managerDatabase(db('manager',2));let cid='c1';const store=create(()=>({db:database,cid,session:'manager-v2'}));
 const result=await store.requests('leaves','2026-10');require('node:assert/strict').equal(Object.keys(result).length,1006);require('node:assert/strict').equal(result.resolved,undefined);
 cid='c2';await require('node:assert/strict').rejects(store.requests('leaves','2026-10'));
});
test('v5.2 indexed unread notification badge excludes read history and preserves company isolation',async()=>{
 await env.withSecurityRulesDisabled(async context=>set(ref(context.database(),'companies/c1/notifications/admin'),{a:{read:false,message:'Unread'},b:{read:true,message:'Archive'}}));
 const result=await get(query(ref(db('manager',2),'companies/c1/notifications/admin'),orderByChild('read'),equalTo(false)));
 require('node:assert/strict').deepEqual(Object.keys(result.val()),['a']);
 await assertFails(get(query(ref(db('manager',2),'companies/c2/notifications/admin'),orderByChild('read'),equalTo(false))));
});
test('seller revenue and notifications pages: seller may read and write their own paths; others and stale tokens are denied',async()=>{
  const seller=db('seller',1);
  // Revenue page: read transactions, add one (same shape as addTransaction()).
  await assertSucceeds(get(ref(seller,'seller/transactions')));
  await assertSucceeds(set(ref(seller,'seller/transactions/t1'),{companyId:'c1',companyName:'شركة',plan:'starter',amount:50,dateStr:'2026-11-12',date:Date.parse('2026-11-12'),note:'',createdAt:Date.now()}));
  // Notifications page: read the list, mark read with a multi-path update.
  await env.withSecurityRulesDisabled(async context=>set(ref(context.database(),'seller/notifications/n1'),{type:'new_company',message:'m',read:false,timestamp:'2026-11-12T10:00:00Z'}));
  await assertSucceeds(get(ref(seller,'seller/notifications')));
  await assertSucceeds(update(ref(seller,'seller/notifications'),{'n1/read':true}));
  // Nothing else under seller/ is writable, even by the seller.
  await assertFails(set(ref(seller,'seller/other'),{x:1}));
  // Manager, employee, anonymous and a stale-version seller token are all denied.
  for(const database of [db('manager',2),db('employee',1),env.unauthenticatedContext().database(),db('seller',2)]){
    await assertFails(get(ref(database,'seller/transactions')));
    await assertFails(get(ref(database,'seller/notifications')));
    await assertFails(set(ref(database,'seller/transactions/x'),{amount:1}));
    await assertFails(set(ref(database,'seller/notifications/x'),{read:true}));
  }
});
