'use strict';
// Execute the real view adapters with DOM/SDK fixtures; this is not a browser smoke test.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const reports=require('../public/assets/report-model');
test('manager dashboard, report and payroll render the same excuse status and expose day details',async()=>{
  const nodes=new Map();
  class Node{
    constructor(tag='div'){this.tag=tag;this.children=[];this.style={};this.listeners={};this.value='';}
    set innerHTML(value){throw Error('Unexpected raw HTML');}
    appendChild(child){this.children.push(child);child.parentElement=this;if(child.id)nodes.set(child.id,child);return child;}
    append(...children){children.forEach(x=>this.appendChild(x));}
    replaceChildren(...children){this.children=[];this.append(...children);}
    addEventListener(type,fn){this.listeners[type]=fn;}
    remove(){if(this.id)nodes.delete(this.id);}
    get options(){return this.children;}
  }
  const ids=['ds-total','ds-present','ds-absent','ds-leave','dash-tbody','pr-wh','pr-emp','pr-month','pr-tbody','pr-stats','payroll-output','rep-from','rep-to','rep-wh','rep-emp','rep-tbody','rep-stats','report-output','daily-details-title','daily-details-body','daily-details-modal','daily-details-close'];
  for(const id of ids){const node=new Node();node.id=id;nodes.set(id,node);}
  const today=reports.dateAt(Date.now()),employee={name:'موظف <img src=x>',empId:'001',status:'approved',warehouseId:'w1',warehouseName:'الفرع'};
  for(const id of ['pr-wh','pr-emp','rep-wh','rep-emp'])nodes.get(id).value='all';
  for(const id of ['rep-from','rep-to'])nodes.get(id).value=today;nodes.get('pr-month').value=today.slice(0,7);
  const data={employees:{e1:employee},leaves:{},excuses:{},settings:{},privatePayroll:{e1:{salary:500,deductionPercent:100}}};
  const records={r1:{empId:'e1',type:'excused',excuseType:'no_both',timestamp:new Date().toISOString(),dateKey:today,warehouseId:'w1',warehouseName:'الفرع'}};
  const errors=[];
  const context={document:{getElementById:id=>nodes.get(id)||null,createElement:tag=>new Node(tag)},BasmaReports:reports,
    DB:{ref:location=>({orderByChild(){return this;},startAt(){return this;},startAfter(){return this;},endAt(){return this;},limitToFirst(){return this;},once:async()=>({val:()=>location==='.info/serverTimeOffset'?0:location.startsWith('privatePayroll/')?data.privatePayroll.e1:data[location.split('/').at(-1)]||null,forEach(){},numChildren:()=>0})})},
    Basma:{records:async()=>({val:()=>records}),call:async()=>({ok:true})},
    BasmaManagerData:require('../public/assets/manager-data'),window:{addEventListener(){}},setInterval(){},COMPANY_ID:'c1',COMPANY_INFO:{timeZone:'UTC'},ALL_EMPLOYEES:{e1:employee},ALL_WAREHOUSES:{w1:{name:'الفرع',active:true}},dashWHFilter:'all',attStatusFilter:'all',reportData:[],payrollData:{},adminNotifBadgeListener:null,pageLoaders:{dash:()=>{throw Error('stale navigation');}},
    showToast:message=>errors.push(message),showLoading(){},hideLoading(){},loadAllData:async()=>{},closeEmpModal(){},Date,Intl};
  for(const name of ['loadDashboard','loadAttendance','generateReport','calculatePayroll','showEmpModal','saveEmpSalary','loadAdminNotifBadge','loadLocReview','approveLocation','rejectLocation','answerBypass'])context[name]=async()=>{};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/assets/manager-views.js'),'utf8'),context);
  await context.loadDashboard();
  await context.pageLoaders.dash();
  assert.equal(nodes.get('ds-present').textContent,1);assert.equal(nodes.get('dash-tbody').children[0].children[3].textContent,'انصرف (بعذر)');
  assert.equal(nodes.get('dash-tbody').children[0].children[0].children.length,0);
  await context.generateReport();assert.equal(context.reportData[0].note,'انصرف (بعذر)');
  await context.calculatePayroll();assert.equal(context.payrollData.rows[0].salary,500);
  nodes.get('pr-tbody').children[0].listeners.click();assert.equal(nodes.get('daily-details-modal').style.display,'flex');
  assert.ok(context.payrollData.rows[0].days.some(d=>d.statusLabel==='انصرف (بعذر)'));
  assert.deepEqual(errors,[]);
});
test('employee can check out after an approved missing-checkin excuse within GPS accuracy tolerance',async()=>{
  const nodes=new Map(),ids=['geo-zone-alert','main-wh-name','profile-wh','leave-banner','holiday-banner','fp-card','btn-checkin','btn-checkout','win-msg','tw-in-range','tw-out-range','tw-in-status','tw-out-status','gz-text','splash-company-name','wh-company-name','reg-company-name','main-company-name','splash-logo','wh-logo','reg-logo','login-logo','main-logo'];
  for(const id of ids)nodes.set(id,{style:{},querySelector:()=>nodes.get('gz-text')});
  const day='2026-10-15',today={dateKey:day,checkInExcused:true,statusLabel:'حاضر (بعذر)'},employee={status:'approved',warehouseId:'w1',warehouseName:'الفرع'};
  const values={'companies/c1/info':{timeZone:'UTC'},'companies/c1/settings':{weekendDays:[],checkIn:{from:'00:00',to:'23:59'},checkOut:{from:'00:00',to:'23:59'}},'companies/c1/employees/e1':employee,'companies/c1/today/e1':today,'companies/c1/leaves':{},'companies/c1/warehouses/w1':{name:'الفرع',geoZone:{lat:0,lng:0,radius:100,enabled:true}}};
  const clock={...require('../public/assets/attendance-clock'),controller:options=>require('../public/assets/attendance-clock').controller({...options,timers:{setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){}}})};
  const context={window:{addEventListener(){}},performance:{now:()=>0},Basma:{call:async name=>name==='employeeHome'?{serverTime:Date.parse(`${day}T12:00:00Z`),date:day,employee,info:values['companies/c1/info'],settings:values['companies/c1/settings'],warehouse:values['companies/c1/warehouses/w1'],today,onLeave:false}:{serverTime:Date.parse(`${day}T12:00:00Z`)}},BasmaClock:clock,SERVER_TIME_OFFSET:0,document:{addEventListener(){},getElementById:id=>{if(!nodes.has(id))throw Error(`Missing element ${id}`);return nodes.get(id);}},BasmaReports:reports,DB:{ref:path=>({orderByChild(){return this;},equalTo(){return this;},limitToLast(){return this;},once:async()=>({val:()=>values[path]})})},ACTIVATION_UID:'e1',EMP:{id:'e1'},COMPANY_ID:'c1',COMPANY_INFO:{timeZone:'UTC'},SETTINGS:{},WAREHOUSE_GEO_ZONE:null,WAREHOUSE_SCHEDULE:null,GEO_ZONE_OK:null,GPS_DATA:{lat:0,lng:0.0018,accuracy:120},serverNow:()=>new Date(`${day}T12:00:00Z`),getEmpSchedule:()=>({checkIn:{from:'00:00',to:'23:59'},checkOut:{from:'00:00',to:'23:59'}}),timeToMins:value=>Number(value.slice(0,2))*60+Number(value.slice(3)),getDistanceMeters:(lat,lng,toLat,toLng)=>require('../functions/policy').distance({lat,lng},{lat:toLat,lng:toLng}),setProfileStatus(){},Date,Intl};
  context.loadNotifPage=()=>{};context.loadNotifBadge=()=>{};
  for(const name of ['checkGeoZone','getGPS','checkHoliday','loadWinStatus','loadTodayStats','submitExcuse','loadHistory'])context[name]=()=>{};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/assets/employee-views.js'),'utf8'),context);
  await context.loadWinStatus();assert.equal(nodes.get('btn-checkout').disabled,false);assert.equal(context.GEO_ZONE_OK,true);
  today.checkInExcused=false;await context.loadWinStatus();assert.equal(nodes.get('btn-checkout').disabled,true);
  today.checkInExcused=true;context.GPS_DATA.accuracy=20;await context.loadWinStatus();assert.equal(nodes.get('btn-checkout').disabled,true);assert.match(nodes.get('gz-text').textContent,/الزائد بعدها/);
});
