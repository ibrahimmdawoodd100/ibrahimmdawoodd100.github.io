'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('record pagination preserves timestamp ties beyond a single page',async()=>{
  const window={};vm.runInNewContext(fs.readFileSync(require.resolve('../public/assets/core.js'),'utf8'),{window,console});
  const entries=Array.from({length:1005},(_,i)=>({key:`r${String(i).padStart(4,'0')}`,value:{timestamp:'2026-10-10T08:00:00.000Z',dateKey:'2026-10-10',empId:'e1'}}));
  const cursors=[];
  const database={ref(){let afterKey='',limit=1000;return{orderByChild(){return this;},startAt(){return this;},endAt(){return this;},startAfter(value,key){cursors.push([value,key]);afterKey=key;return this;},limitToFirst(value){limit=value;return this;},async once(){const page=entries.filter(x=>x.key>afterKey).slice(0,limit);return{numChildren:()=>page.length,forEach:fn=>page.forEach(item=>fn({key:item.key,val:()=>item.value}))};}};}};
  const result=await window.Basma.records(database,'c1','2026-10-10','2026-10-10');
  assert.equal(Object.keys(result.val()).length,1005);assert.equal(cursors[0][1],'r0999');
});
test('template event dispatcher calls allowlisted actions without executing injected JavaScript',()=>{
  const listeners={},calls=[];
  class Element{}
  Object.defineProperty(Element.prototype,'innerHTML',{configurable:true,get(){return'';},set(){}});
  const window={BASMA_ALLOWED_ACTIONS:['showPage','recBio'],showPage:value=>calls.push(value),recBio:value=>calls.push(value)};
  const document={addEventListener:(name,fn)=>listeners[name]=fn};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/assets/safe-dom.js'),'utf8'),{window,document,Element,URL,location:{href:'https://basma.example.org',origin:'https://basma.example.org'},Promise});
  const send=code=>listeners.click({target:{closest:()=>({getAttribute:()=>code})},stopPropagation(){}});
  send("showPage('dash')");send("recBio('in')");
  for(const code of ["eval('alert(1)')","showPage(document.cookie)","showPage('x');alert('stolen')","window.location='https://attacker.invalid'","showPage('${malicious}')"])send(code);
  assert.deepEqual(calls.slice(0,2),['dash','in']);assert.equal(calls.includes('stolen'),false);
});
function authHarness(role,{blockLocal=false}={}) {
  const attempts=[],signouts=[],banners=[],settled=[],providers=[],callOptions=[];let profileError;
  const auth={currentUser:{getIdToken:async()=>{}},setPersistence:async value=>{attempts.push(value);if(value==='local'&&blockLocal)throw Error('Storage blocked');},onAuthStateChanged:fn=>{queueMicrotask(fn);return()=>{};},signOut:async()=>{signouts.push(true);},signInWithEmailAndPassword:async()=>{}};
  const app={name:`secure-${role}`,auth:()=>auth,appCheck:()=>({activate(provider,autoRefresh){providers.push({provider,autoRefresh});}}),functions:()=>({httpsCallable:(name,options)=>async()=>{callOptions.push({name,...options});if(profileError)throw profileError;const who={role,companyId:'c1'};return{data:/Home$/.test(name)?{profile:who}:who};}})};
  const firebase={apps:[],initializeApp:(config,name)=>{app.name=name;return app;},appCheck:{ReCaptchaEnterpriseProvider:class{constructor(siteKey){this.siteKey=siteKey;this.kind='enterprise';}}}};
  firebase.auth={Auth:{Persistence:{LOCAL:'local',SESSION:'session'}}};
  const window={dispatchEvent:event=>settled.push(event.type),BASMA_CONFIG:{firebase:{databaseURL:'https://example.firebaseio.com'},appCheckSiteKey:'public-test',region:'us-central1'}};
  const document={getElementById:()=>null,createElement:()=>({style:{},set textContent(value){banners.push(value);}}),body:{appendChild(){}}};
  const navigator={geolocation:{getCurrentPosition:success=>success({coords:{latitude:0,longitude:0,accuracy:123}})}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/assets/core.js'),'utf8'),{window,firebase,navigator,document,URL,console,setTimeout,clearTimeout,CustomEvent:class{constructor(type){this.type=type;}}});
  return {Basma:window.Basma,attempts,signouts,banners,settled,providers,callOptions,app,setError:error=>profileError=error};
}
test('employee persistence is LOCAL, while manager persistence remains SESSION in another app namespace',async()=>{
  const employee=authHarness('employee'),manager=authHarness('manager');
  assert.equal((await employee.Basma.session('employee')).role,'employee');await manager.Basma.session('manager');
  assert.deepEqual(employee.attempts,['local']);assert.deepEqual(manager.attempts,['session']);assert.notEqual(employee.app.name,manager.app.name);
  assert.equal(employee.Basma.persistenceMode,'LOCAL');
  const seller=authHarness('seller');await seller.Basma.session('seller');
  for(const h of [employee,manager,seller]){assert.equal(h.providers.length,1);assert.equal(h.providers[0].provider.kind,'enterprise');assert.equal(h.providers[0].provider.siteKey,'public-test');assert.equal(h.providers[0].autoRefresh,true);}
});
test('blocked local storage falls back explicitly; a transient network failure does not clear persistent Auth',async()=>{
  const h=authHarness('employee',{blockLocal:true});await h.Basma.session('employee');
  assert.deepEqual(h.attempts,['local','session']);assert.equal(h.Basma.persistenceMode,'SESSION');assert.match(h.banners[0],/تعذر حفظ الجلسة/);
  h.setError(Object.assign(Error('offline'),{code:'functions/unavailable'}));await assert.rejects(()=>h.Basma.session('employee'));assert.equal(h.signouts.length,0);
  h.setError(Object.assign(Error('revoked'),{code:'functions/permission-denied'}));await assert.rejects(()=>h.Basma.session('employee'));assert.equal(h.signouts.length,1);
});
test('GPS capture forwards measured accuracy including valid zero coordinates',async()=>{
  const h=authHarness('employee'),point=await h.Basma.getGPS();
  assert.equal(point.lat,0);assert.equal(point.lng,0);assert.equal(point.accuracy,123);
});
test('record range includes a later-approved excuse using its server dateKey',async()=>{
  const window={};vm.runInNewContext(fs.readFileSync(require.resolve('../public/assets/core.js'),'utf8'),{window,console});
  const values={late:{type:'excused',empId:'e1',dateKey:'2026-10-12',timestamp:'2026-10-20T12:00:00Z'},other:{type:'out',empId:'e1',dateKey:'2026-10-13',timestamp:'2026-10-13T08:00:00Z'}};
  const database={ref(){let field,lower,upper;return{orderByChild(value){field=value;return this;},startAt(value){lower=value;return this;},endAt(value){upper=value;return this;},limitToFirst(){return this;},async once(){const selected=Object.entries(values).filter(([,value])=>typeof value[field]==='string'&&value[field]>=lower&&value[field]<=upper);return{numChildren:()=>selected.length,forEach:fn=>selected.forEach(([key,value])=>fn({key,val:()=>value}))};}};}};
  const snapshot=await window.Basma.records(database,'c1','2026-10-12','2026-10-12','Asia/Baghdad');
  assert.deepEqual(Object.keys(snapshot.val()).sort(),['late']);
});

test('every successful and failed recordAttendance call dispatches a window re-evaluation event',async()=>{
  const h=authHarness('employee');await h.Basma.session('employee');
  await h.Basma.call('recordAttendance',{type:'in'});
  h.setError(Object.assign(Error('outside window'),{code:'functions/failed-precondition',details:{reason:'attendance-window'}}));
  await assert.rejects(()=>h.Basma.call('recordAttendance',{type:'out'}));
  assert.deepEqual(h.settled,['basma-attendance-settled','basma-attendance-settled']);
});

test('the client requests ordinary reusable App Check tokens for every callable',async()=>{
 const h=authHarness('employee');await h.Basma.session('employee');await h.Basma.call('serverClock');await h.Basma.call('recordAttendance');
 assert.equal(h.callOptions.length,3);for(const option of h.callOptions)assert.equal(option.limitedUseAppCheckTokens,false);
});
