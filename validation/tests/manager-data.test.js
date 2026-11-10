'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create,pages,monthRange}=require('../public/assets/manager-data');
function fake(data,{pause,fail}={}){
 const calls=[];
 const db={ref(path){const spec={path};return {orderByChild(field){spec.field=field;return this;},startAt(value){spec.from=value;return this;},endAt(value){spec.to=value;return this;},startAfter(value,key){spec.after=value;spec.key=key;return this;},limitToFirst(size){spec.size=size;return this;},async once(){calls.push({...spec});if(pause)await pause(spec);if(fail&&fail(spec))throw Error('network failed');let value=path.split('/').reduce((at,key)=>at?.[key],data)||null;
  if(spec.field){let items=Object.entries(value||{}).filter(([key,v])=>(spec.from===undefined||v[spec.field]>=spec.from)&&(spec.to===undefined||v[spec.field]<=spec.to)&&(spec.after===undefined||v[spec.field]>spec.after||(v[spec.field]===spec.after&&key>spec.key))).sort((a,b)=>a[1][spec.field]<b[1][spec.field]?-1:a[1][spec.field]>b[1][spec.field]?1:a[0]<b[0]?-1:1);value=Object.fromEntries(items.slice(0,spec.size));}
  return {val:()=>value,forEach(fn){for(const [key,v]of Object.entries(value||{})){if(fn({key,val:()=>v})===true)break;}},numChildren:()=>Object.keys(value||{}).length};
 }};}};return {db,calls};
}
const company=()=>({employees:{e1:{name:'One',status:'approved'}},settings:{},warehouses:{},leaves:{},excuses:{}});
test('pagination includes 2105 same-date requests once, with date+key cursors',async()=>{
 const c=company();for(let i=0;i<2105;i++)c.leaves['k'+String(i).padStart(5,'0')]={date:'2026-10-10',empId:'e1',status:'approved'};
 c.leaves.old={date:'2026-09-30'};c.leaves.next={date:'2026-11-01'};
 const f=fake({companies:{c1:c}}),out=await pages(f.db,'c1','leaves',{from:'2026-10-01',to:'2026-10-31'});
 assert.equal(Object.keys(out).length,2105);assert.equal(new Set(Object.keys(out)).size,2105);assert.equal(f.calls.length,3);assert.equal(f.calls[1].after,'2026-10-10');assert.equal(f.calls[1].key,'k00999');assert.equal(out.old,undefined);
});
test('pending queries paginate over 1000 old requests and union monthly duplicates by key',async()=>{
 const c=company();for(let i=0;i<1205;i++)c.leaves['k'+String(i).padStart(5,'0')]={date:'2020-01-01',status:'pending'};
 c.leaves.thisMonth={date:'2026-10-10',status:'pending'};c.leaves.resolved={date:'2026-10-11',status:'approved'};c.leaves.oldResolved={date:'2020-01-01',status:'approved'};
 const f=fake({companies:{c1:c}}),store=create(()=>({db:f.db,cid:'c1',session:'a'}));
 const out=await store.requests('leaves','2026-10');assert.equal(Object.keys(out).length,1207);assert.equal(out.oldResolved,undefined);assert.ok(out.k00000);assert.ok(f.calls.some(c=>c.field==='status'&&c.after==='pending'));
});
test('cache is isolated by company, database, and login session; clear never reuses a previous login',async()=>{
 const c1=company(),c2=company();c2.employees.e1.name='Two';const f=fake({companies:{c1,c2}}),g=fake({companies:{c1:company()}});let ctx={db:f.db,cid:'c1',session:'a'};const store=create(()=>ctx);
 assert.equal((await store.base()).employees.e1.name,'One');await store.base();assert.equal(f.calls.length,3);
 ctx={...ctx,cid:'c2'};assert.equal((await store.base()).employees.e1.name,'Two');
 ctx={...ctx,session:'b'};await store.base();assert.equal(f.calls.length,9);
 ctx={db:g.db,cid:'c1',session:'b'};await store.base();assert.equal(g.calls.length,3);
 store.clear();await store.base();assert.equal(g.calls.length,6);
});
test('an old-company in-flight result is rejected before it can reach a renderer',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=fake({companies:{c1:company(),c2:company()}},{pause:()=>gate});let ctx={db:f.db,cid:'c1',session:'a'};const store=create(()=>ctx),pending=store.base();ctx={...ctx,cid:'c2'};release();await assert.rejects(pending,/الجلسة أو الشركة/);
});
test('failed later page yields no partial month and is not cached; retry returns the full period',async()=>{
 const c=company();for(let i=0;i<1002;i++)c.leaves['k'+String(i).padStart(5,'0')]={date:'2026-10-10',status:'approved'};
 let broken=true;const f=fake({companies:{c1:c}},{fail:s=>broken&&s.path.endsWith('/leaves')&&s.after!==undefined});const store=create(()=>({db:f.db,cid:'c1',session:'a'}));
 await assert.rejects(store.period('2026-10-01','2026-10-31'),/network/);broken=false;assert.equal(Object.keys((await store.period('2026-10-01','2026-10-31')).leaves).length,1002);
});
test('base TTL, period TTL and explicit invalidation fetch fresh values',async()=>{
 let time=0;const c=company(),f=fake({companies:{c1:c}}),store=create(()=>({db:f.db,cid:'c1',session:'a'}),{now:()=>time});
 await store.base();await store.period('2026-10-01','2026-10-31');const initial=f.calls.length;
 await store.base();await store.period('2026-10-01','2026-10-31');assert.equal(f.calls.length,initial);
 time=60001;await store.period('2026-10-01','2026-10-31');assert.equal(f.calls.length,initial+2);
 time=300001;await store.base();assert.equal(f.calls.length,initial+5);
 store.invalidate();await store.base();assert.equal(f.calls.length,initial+8);
});
test('invalidating while a period is loading rejects the obsolete result',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=fake({companies:{c1:company()}},{pause:()=>gate}),store=create(()=>({db:f.db,cid:'c1',session:'a'}));
 const pending=store.period('2026-10-01','2026-10-31');store.invalidate();release();await assert.rejects(pending,/الجلسة أو الشركة/);
});
test('month bounds include leap days and reject impossible months and ranges',async()=>{
 assert.deepEqual(monthRange('2024-02'),{from:'2024-02-01',to:'2024-02-29'});assert.throws(()=>monthRange('2026-13'));
 await assert.rejects(pages(fake({}).db,'c1','leaves',{from:'2026-10-31',to:'2026-10-01'}));assert.throws(()=>monthRange('2026-00'));
});
test('period projection preserves daily classifications, excused checkout and payroll totals',async()=>{
 const reports=require('../public/assets/report-model'),c=company();c.employees.e1={...c.employees.e1,empId:'001',warehouseId:'w1',warehouseName:'Branch'};
 c.leaves={old:{empId:'e1',date:'2020-01-01',status:'approved',leaveType:'paid'},current:{empId:'e1',date:'2026-10-02',status:'approved',leaveType:'paid'}};
 c.excuses={old:{empId:'e1',date:'2020-01-01',status:'approved',type:'no_both'},current:{empId:'e1',date:'2026-10-03',status:'approved',type:'no_checkin'}};
 const records={a:{empId:'e1',dateKey:'2026-10-03',type:'excused',excuseType:'no_checkin',timestamp:'2026-10-03T08:00:00Z',warehouseId:'w1'},b:{empId:'e1',dateKey:'2026-10-03',type:'out',timestamp:'2026-10-03T16:00:00Z',warehouseId:'w1'}};
 const f=fake({companies:{c1:c}}),store=create(()=>({db:f.db,cid:'c1',session:'a'})),projection=await store.period('2026-10-01','2026-10-24');
 const input={employees:c.employees,settings:{},records,from:'2026-10-01',to:'2026-10-24',timeZone:'UTC'};
 const before=reports.build({...input,leaves:c.leaves,excuses:c.excuses}),after=reports.build({...input,...projection});
 assert.deepEqual(after,before);assert.ok(after.some(row=>row.statusLabel==='انصرف (بعذر)'));
 const financial={e1:{salary:600,deductionPercent:50}};assert.deepEqual(reports.payroll(after,c.employees,financial),reports.payroll(before,c.employees,financial));
});
test('cached periods keep October and November data separate',async()=>{
 const c=company();c.leaves.oct={date:'2026-10-01',status:'approved'};c.leaves.nov={date:'2026-11-01',status:'approved'};
 const f=fake({companies:{c1:c}}),store=create(()=>({db:f.db,cid:'c1',session:'a'}));
 const [oct,nov]=await Promise.all([store.period('2026-10-01','2026-10-31'),store.period('2026-11-01','2026-11-30')]);
 assert.deepEqual(Object.keys(oct.leaves),['oct']);assert.deepEqual(Object.keys(nov.leaves),['nov']);
 assert.deepEqual(Object.keys((await store.period('2026-10-01','2026-10-31')).leaves),['oct']);
});
test('default manager month follows synchronized server time and the company zone at a month boundary',()=>{
 const vm=require('node:vm'),fs=require('node:fs'),code=fs.readFileSync(require.resolve('../public/assets/manager-views'),'utf8');
 const start=code.indexOf('const secureManagerView = (()=>{'),end=code.indexOf('})();',start)+5;
 class DeviceDate extends Date{static now(){return Date.parse('2040-01-01T00:00:00Z');}}
 const context={Date:DeviceDate,BasmaReports:require('../public/assets/report-model'),Basma:{profile:{clockOffset:Date.parse('2026-10-31T22:30:00Z')-DeviceDate.now()}},COMPANY_INFO:{timeZone:'Asia/Baghdad'}};
 vm.runInNewContext(code.slice(start,end)+';globalThis.currentDay=secureManagerView.today;',context);
 assert.equal(context.currentDay(),'2026-11-01');assert.deepEqual(monthRange(context.currentDay().slice(0,7)),{from:'2026-11-01',to:'2026-11-30'});
 context.COMPANY_INFO.timeZone='UTC';assert.equal(context.currentDay(),'2026-10-31');
});
test('subscription scope guards survive data invalidation but fail after logout/clear even before reload',()=>{
 const f=fake({companies:{c1:company()}}),store=create(()=>({db:f.db,cid:'c1',session:'a'}));
 const scope=store.capture(false);store.invalidate();assert.doesNotThrow(()=>scope.check());store.clear();assert.throws(()=>scope.check(),/الجلسة أو الشركة/);
});
