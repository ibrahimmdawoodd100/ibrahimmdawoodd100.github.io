'use strict';
// Executes the supplied source in a VM with a deterministic DOM/SDK/data fixture.
// Counts requested SDK reads and JSON payload bytes, NOT Firebase billed wire bytes.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
function fixture(){
 const history=Number(process.env.BASMA_LEAVES_PER_EMPLOYEE||10);
 if(!Number.isInteger(history)||history<1||history>1000)throw Error('BASMA_LEAVES_PER_EMPLOYEE must be 1..1000');
 const now=Date.parse('2026-10-24T12:00:00Z'),date='2026-10-24';
 const company={info:{nameAr:'شركة الاختبار',timeZone:'UTC',status:'active',expiresAt:now+86400000},settings:{checkIn:{from:'00:00',to:'23:59'},checkOut:{from:'00:00',to:'23:59'},weekendDays:[]},warehouses:{w1:{name:'الفرع',active:true}},employees:{},leaves:{},excuses:{},records:{},today:{},missions:{},notifications:{admin:{}}};
 for(let i=0;i<100;i++){
  const id='e'+i;company.employees[id]={name:'موظف '+i,empId:String(i),role:'موظف',status:'approved',warehouseId:'w1',warehouseName:'الفرع',credId:'credential',createdAt:1};
  company.today[id]={dateKey:date,empId:id,checkIn:null,checkOut:null};
  for(let k=0;k<history;k++){
   const leaveDate=k===0?date:history===10?'2026-09-01':`${2010+Math.floor(k/12)}-${String(k%12+1).padStart(2,'0')}-01`;
   const partial=history===10||k%4===0;
   company.leaves[id+'_'+k]={empId:id,date:leaveDate,status:k===0?'pending':history!==10&&k%11===0?'rejected':'approved',leaveType:partial?'partial':['paid','sick','unpaid'][k%3],isPartial:partial,
    ...(partial?{fromTime:'13:00',toTime:'14:00'}:{}),reason:history===10?'سبب تجريبي':'طلب إجازة لمراجعة طبية أو ظرف عائلي، محفوظ في السجل التاريخي. '.repeat(4),
    ...(history===10?{}:{createdAt:Date.parse(leaveDate+'T08:00:00Z'),...(k===0?{}:{[k%11===0?'rejectedAt':'approvedAt']:Date.parse(leaveDate+'T09:00:00Z')}),empName:'موظف '+i,warehouseId:'w1',warehouseName:'الفرع الرئيسي'})};
  }
  for(let k=0;k<5;k++)company.excuses[id+'_'+k]={empId:id,date:'2026-09-01',status:k===0?'pending':'approved',type:'no_checkin',reason:'عذر تجريبي'};
  company.notifications[id]={n1:{read:false,message:'إشعار تجريبي'}};
  company.missions[id]={empId:id,status:'completed',date:'2026-09-01',name:'مهمة سابقة'};
  for(const type of ['in','out'])company.records[id+'_'+type]={empId:id,type,dateKey:date,timestamp:`${date}T${type==='in'?'08':'16'}:00:00.000Z`,warehouseId:'w1',warehouseName:'الفرع',locStatus:'approved',locationName:'موقع العمل',delayMins:0};
 }
 if(process.env.BASMA_MEASUREMENT_MODE==='month-stability'){
  company.leaves={};
  for(let i=0;i<100;i++)for(let k=0;k<history;k++){
   const id='e'+i,dateKey=k===0?'2026-10-10':k===1?'2026-10-20':k===2?'2020-01-01':`${2010+Math.floor(k/12)}-${String(k%12+1).padStart(2,'0')}-01`;
   const partial=k===1||k%4===0,status=k===1||k===2?'pending':k%11===0?'rejected':'approved';
   company.leaves[id+'_'+String(k).padStart(4,'0')]={empId:id,empName:'موظف '+i,warehouseId:'w1',warehouseName:'الفرع الرئيسي',date:dateKey,status,leaveType:partial?'partial':['paid','sick','unpaid'][k%3],isPartial:partial,...(partial?{fromTime:'13:00',toTime:'14:00'}:{}),reason:'طلب إجازة لمراجعة طبية أو ظرف عائلي، محفوظ في السجل التاريخي. '.repeat(4),createdAt:Date.parse(dateKey+'T08:00:00Z'),...(status==='pending'?{}:{[status==='approved'?'approvedAt':'rejectedAt']:Date.parse(dateKey+'T09:00:00Z')})};
  }
 }
 return {now,date,data:{companies:{c1:company}}};
}
async function measure(source,role){
 const f=fixture(),reads=[],calls=[],listeners=[],nodes=new Map(),errors=[];let serial=0;
 class Node{
  constructor(id=''){this.id=id;this.style={};this.dataset={};this.value=id==='att-date'?f.date:'all';this.children=[];this.classList={add(){},remove(){},toggle(){},contains(){return false;}};}
  get options(){return this.children;}get parentElement(){return null;}
  appendChild(n){this.children.push(n);return n;}append(...n){this.children.push(...n);}remove(){}replaceChildren(...n){this.children=n;}addEventListener(){}setAttribute(){}getAttribute(){return null;}querySelector(){return node('query');}querySelectorAll(){return [];}getContext(){return null;}
 }
 function node(id){if(!nodes.has(id))nodes.set(id,new Node(id));return nodes.get(id);}
 const document={getElementById:node,createElement:()=>new Node(),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},visibilityState:'visible',body:new Node(),documentElement:new Node()};
 function value(location){return location==='.info/serverTimeOffset'?0:location.split('/').reduce((v,k)=>v?.[k],f.data)??null;}
 const snap=v=>({val:()=>v,exists:()=>v!==null,numChildren:()=>Object.keys(v||{}).length,forEach:fn=>{for(const [key,item]of Object.entries(v||{}))fn({key,...snap(item)});}});
 function query(location){const spec={path:location};return {orderByChild(x){spec.order=x;return this;},equalTo(x){spec.equal=x;return this;},limitToLast(x){spec.last=x;return this;},limitToFirst(x){spec.first=x;return this;},startAt(x){spec.from=x;return this;},startAfter(x,k){spec.after=x;spec.afterKey=k;return this;},endAt(x){spec.to=x;return this;},
  async once(){return deliver();},on(type,fn){listeners.push({path:location,fn,spec:{...spec}});queueMicrotask(()=>fn(deliver('listener-initial')));return fn;},off(){},
  update:async()=>{},set:async()=>{},remove:async()=>{},push(){return {key:'n'+(++serial)};}};
  function deliver(kind='once'){
   let result=value(location);
   if(spec.order&&result){let entries=Object.entries(result).filter(([k,v])=>(spec.equal===undefined||v[spec.order]===spec.equal)&&(spec.from===undefined||v[spec.order]>=spec.from)&&(spec.to===undefined||v[spec.order]<=spec.to)&&(spec.after===undefined||v[spec.order]>spec.after||v[spec.order]===spec.after&&k>spec.afterKey));entries.sort((a,b)=>String(a[1][spec.order]).localeCompare(String(b[1][spec.order]))||a[0].localeCompare(b[0]));if(spec.last)entries=entries.slice(-spec.last);if(spec.first)entries=entries.slice(0,spec.first);result=entries.length?Object.fromEntries(entries):null;}
   reads.push({...spec,kind,jsonBytes:Buffer.byteLength(JSON.stringify(result)),children:result&&typeof result==='object'?Object.keys(result).length:0});return snap(result);
  }
 }
 const database={ref:query,goOffline(){},goOnline(){},INTERNAL:{forceLongPolling(){}}};
 const auth={currentUser:{getIdToken:async()=>{}},setPersistence:async()=>{},onAuthStateChanged:fn=>{queueMicrotask(fn);return()=>{};},signOut:async()=>{},signInWithEmailAndPassword:async()=>{}};
 const handlers={};const browserEvents={};
 const firebase={apps:[],initializeApp:()=>app,appCheck:{ReCaptchaEnterpriseProvider:class{}},auth:{Auth:{Persistence:{LOCAL:'local',SESSION:'session'}}}};
 const app={name:'secure-'+role,auth:()=>auth,database:()=>database,appCheck:()=>({activate(){}}),functions:()=>({httpsCallable:(name,options)=>async data=>{
  const call={name,limitedUseAppCheckTokens:options?.limitedUseAppCheckTokens===true};calls.push(call);
  const response=data=>{call.responseJsonBytes=Buffer.byteLength(JSON.stringify(data));return {data};};
  if(name==='profile')return response({role,companyId:'c1',employeeId:role==='employee'?'e0':null,serverTime:f.now,timeZone:'UTC'});
  if(name==='serverClock')return response({serverTime:f.now});
  if(name==='managerHome'){const c=f.data.companies.c1,day=(o,k)=>Object.fromEntries(Object.entries(o||{}).filter(([,v])=>v?.[k]===f.date));
   const keep=['name','empId','role','warehouseId','warehouseName','status','schedule','createdAt'],staff=Object.fromEntries(Object.entries(c.employees||{}).map(([id,e])=>[id,Object.fromEntries(keep.filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))]));
   return response({serverTime:f.now,date:f.date,companyId:'c1',info:c.info,settings:c.settings||{},warehouses:c.warehouses||{},employees:staff,records:day(c.records,'dateKey'),leaves:day(c.leaves,'date'),excuses:day(c.excuses,'date')});}
  if(name==='employeeHome')return response({serverTime:f.now,date:f.date,employee:f.data.companies.c1.employees.e0,info:f.data.companies.c1.info,settings:f.data.companies.c1.settings,warehouse:f.data.companies.c1.warehouses.w1,today:f.data.companies.c1.today.e0,onLeave:false});
  if(name==='beginWebAuthn')return response({challengeId:'challenge',options:{challenge:'YQ',allowCredentials:[]}});
  if(name==='finishWebAuthn')return response({proof:'proof'});
  if(name==='recordAttendance'){const p='companies/c1/today/e0';f.data.companies.c1.today.e0={dateKey:f.date,empId:'e0',checkIn:new Date(f.now).toISOString()};queueMicrotask(()=>{for(const l of listeners.filter(l=>l.path===p)){const v=value(p);reads.push({...l.spec,kind:'listener-update',jsonBytes:Buffer.byteLength(JSON.stringify(v))});l.fn(snap(v));}});return response({ok:true});}
  throw Error('Unknown callable '+name);
 }})};
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[f.now]));}static now(){return f.now;}}
 const storage={getItem:()=>null,setItem(){},removeItem(){}};
 const context={document,firebase,console,Date:ClockDate,Intl,URL,Buffer,Promise,queueMicrotask,performance:{now:()=>0},setInterval:()=>++serial,clearInterval(){},setTimeout:()=>++serial,clearTimeout(){},localStorage:storage,sessionStorage:storage,location:{origin:'https://ibrahimmdawoodd100.github.io',pathname:`/${role}/`,reload(){}},navigator:{geolocation:{getCurrentPosition:success=>queueMicrotask(()=>success({coords:{latitude:0,longitude:0,accuracy:5}}))},credentials:{get:async()=>({id:'credential',rawId:new Uint8Array([1]).buffer,type:'public-key',getClientExtensionResults:()=>({}),response:{clientDataJSON:new Uint8Array([1]).buffer,authenticatorData:new Uint8Array([1]).buffer,signature:new Uint8Array([1]).buffer}})}},atob:x=>Buffer.from(x,'base64').toString('binary'),btoa:x=>Buffer.from(x,'binary').toString('base64'),alert(){},confirm:()=>false,prompt:()=>null,CustomEvent:class{constructor(type){this.type=type;}},addEventListener:(type,fn)=>(browserEvents[type]||=[]).push(fn),dispatchEvent:event=>{for(const fn of browserEvents[event.type]||[])fn(event);}};
 context.window=context;context.BASMA_CONFIG={firebase:{databaseURL:'https://fixture.firebaseio.com'},appCheckSiteKey:'fixture-public',region:'us-central1'};
 const ctx=vm.createContext(context),run=(text,file)=>vm.runInContext(text,ctx,{filename:file});
 const file=path.join(source,'public',role,'index.html'),html=fs.readFileSync(file,'utf8');
 for(const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc=/.test(match[1]))run(match[2],file);
 for(const name of ['report-model','core',role,...(role==='employee'?['attendance-clock','employee-views']:[...(fs.existsSync(path.join(source,'public/assets/manager-data.js'))?['manager-data']:[]),'manager-views'])])run(fs.readFileSync(path.join(source,'public/assets',name+'.js'),'utf8'),name+'.js');
 // Keep business/loading paths real; stub only interactions whose DOM templates require a browser parser.
 for(const name of ['showScreen','showTab','showLoading','hideLoading','showToast','populateWHSelects'])ctx[name]=(...args)=>{if(name==='showToast'&&args[1]==='error')errors.push(args[0]);};
 ctx.Basma.controls=()=>{};
 const flush=async()=>{for(let i=0;i<250;i++)await Promise.resolve();};
 await ctx.onload();await flush();
 const summarize=()=>({callables:calls.slice(),functionCalls:calls.length,appCheckTokenAttachments:calls.length,freshLimitedUseRequests:calls.filter(c=>c.limitedUseAppCheckTokens).length,callableResponseJsonBytes:calls.reduce((sum,c)=>sum+(c.responseJsonBytes||0),0),reads:reads.slice(),sdkReadDeliveries:reads.length,jsonPayloadBytes:reads.filter(r=>!r.path.startsWith('.info')).reduce((sum,r)=>sum+r.jsonBytes,0),errors:errors.slice()});
 const opening=summarize();reads.length=0;calls.length=0;errors.length=0;
 if(role==='employee')await ctx.recBio('in');else if(process.env.BASMA_MANAGER_ACTION==='month'){node('leaves-month').value=f.date.slice(0,7);node('excuses-month').value=f.date.slice(0,7);await ctx.loadLeaves();await flush();await ctx.loadExcuses();}else await ctx.loadAttendance();await flush();
 return {opening,action:summarize()};
}
async function main(){const source=path.resolve(process.argv[2]||path.join(__dirname,'..'));const result={source,measurementMode:process.env.BASMA_MEASUREMENT_MODE||'original',managerAction:process.env.BASMA_MANAGER_ACTION||'attendance',fixture:`100 employees; ${Number(process.env.BASMA_LEAVES_PER_EMPLOYEE||10)*100} leaves (${process.env.BASMA_LEAVES_PER_EMPLOYEE||10}/employee); 500 excuses; 200 daily records; 100 missions; each employee has 1 notification; UTC 2026-10-24 12:00`,scope:'VM SDK requests and JSON response bytes. No real Auth/App Check/RTDB network, TLS/protocol bytes, cache deduplication or Admin SDK reads measured.',employee:await measure(source,'employee'),manager:await measure(source,'manager')};console.log(JSON.stringify(result,null,2));}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={measure,fixture};
