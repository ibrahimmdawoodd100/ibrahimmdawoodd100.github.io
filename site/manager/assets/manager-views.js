'use strict';
// Final adapters for the three HTML files explicitly supplied on 15 October.
const managerData=BasmaManagerData.create(()=>({db:DB,cid:COMPANY_ID,session:Basma.profile||DB}));
const secureManagerView = (()=>{
  let offset=0;
  const today=()=>BasmaReports.dateAt(Date.now()+(offset||Basma.profile?.clockOffset||0),COMPANY_INFO.timeZone||'UTC');
  const el=id=>document.getElementById(id);
  const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=String(value??'');return node;};
  const time=value=>value?new Date(value).toLocaleTimeString('ar',{timeZone:COMPANY_INFO.timeZone||'UTC',hour:'2-digit',minute:'2-digit'}):'—';
  function table(id,rows,cells,click) {
    const body=el(id);let page=0;const size=200;
    el(`${id}-pager`)?.remove();
    const pager=document.createElement('div');pager.id=`${id}-pager`;const label=text('span',''),previous=text('button','السابق'),next=text('button','التالي');
    const draw=()=>{
      body.replaceChildren();
      for(const row of rows.slice(page*size,(page+1)*size)){const tr=document.createElement('tr');for(const value of cells(row))tr.appendChild(text('td',value));if(click){tr.style.cursor='pointer';tr.addEventListener('click',()=>click(row));}body.appendChild(tr);}
      if(!rows.length){const td=text('td','لا توجد بيانات مطابقة');td.colSpan=12;const tr=document.createElement('tr');tr.appendChild(td);body.appendChild(tr);}
      label.textContent=rows.length?`${page*size+1}–${Math.min((page+1)*size,rows.length)} من ${rows.length}`:'0';previous.disabled=page===0;next.disabled=(page+1)*size>=rows.length;
    };
    previous.addEventListener('click',()=>{page--;draw();});next.addEventListener('click',()=>{page++;draw();});pager.append(previous,label,next);body.parentElement?.parentElement?.appendChild(pager);draw();
  }
  async function dataset(from,to,{employeeId='all',warehouseId='all'}={}) {
    const token=managerData.capture();
    const [base,history,records,clock]=await Promise.all([
      managerData.base(),managerData.period(from,to),Basma.records(token.db,token.cid,from,to,COMPANY_INFO.timeZone||'UTC'),token.db.ref('.info/serverTimeOffset').once('value')
    ]);
    token.check();offset=clock.val()||0;ALL_EMPLOYEES=base.employees;ALL_WAREHOUSES=base.warehouses;
    return BasmaReports.build({employees:base.employees,records:records.val()||{},leaves:history.leaves,excuses:history.excuses,settings:base.settings,from,to,employeeId,warehouseId,timeZone:COMPANY_INFO.timeZone||'UTC'});
  }
  function options(select,values,first) {
    const selected=select.value;select.replaceChildren();const all=text('option',first);all.value='all';select.appendChild(all);
    for(const [id,label]of values){const option=text('option',label);option.value=id;select.appendChild(option);}select.value=[...select.options].some(x=>x.value===selected)?selected:'all';
  }
  function filters() {
    options(el('pr-wh'),Object.entries(ALL_WAREHOUSES).map(([id,w])=>[id,w.name]),'كل الفروع الحالية');
    options(el('pr-emp'),Object.entries(ALL_EMPLOYEES).filter(([,e])=>e.status==='approved').map(([id,e])=>[id,e.name]),'كل الموظفين');
  }
  async function financial(eid) {
    const token=managerData.capture(false);
    const value=(await token.db.ref(`privatePayroll/${token.cid}/${eid}`).once('value')).val();token.check();
    if(!value)throw Error('أدخل بيانات الراتب من ملف الموظف أولًا');return value;
  }
  function details(rows,title) {
    el('daily-details-title').textContent=title;
    table('daily-details-body',rows,r=>[r.date,r.name,r.warehouseName,r.statusLabel,time(r.checkIn),time(r.checkOut),r.actualWorkMinutes==null?'—':(r.actualWorkMinutes/60).toFixed(2),r.delayMins]);
    el('daily-details-modal').style.display='flex';
  }
  return {today,el,text,time,table,dataset,filters,financial,details};
})();

let dashboardTicket=0,attendanceTicket=0,reportTicket=0,payrollTicket=0;
// ---- Dashboard from ONE server call (managerHome), with a visible limit and a retry button ----
// Before: info + employees + settings + warehouses + leave/excuse pages + records + clock, all direct database reads
// with no limit; on a stalled database connection the cards stayed "-" and the table spun forever.
const managerHomeTimeoutMs=()=>Number(window.BASMA_MANAGER_TIMEOUT_MS)||25000;
function applyManagerHome(home){
  COMPANY_INFO={...(COMPANY_INFO||{}),...(home.info||{})};
  managerData.prime(home);ALL_EMPLOYEES=home.employees||{};ALL_WAREHOUSES=home.warehouses||{};
  const name=document.getElementById('sb-company'),logo=document.getElementById('sb-logo');
  if(name&&COMPANY_INFO.nameAr)name.textContent=COMPANY_INFO.nameAr;if(logo)logo.textContent=COMPANY_INFO.logo||'🏭';
}
function dashboardError(error){
  for(const id of ['ds-total','ds-present','ds-absent','ds-leave']){const node=document.getElementById(id);if(node)node.textContent='—';}
  const body=document.getElementById('dash-tbody');if(!body)return;
  const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=7;td.style.textAlign='center';td.style.padding='24px';
  td.appendChild(secureManagerView.text('div','تعذر تحميل لوحة التحكم. '+(window.BasmaErrors?.message(error,'')??error?.message??'')));
  const retry=secureManagerView.text('button','إعادة المحاولة');retry.className='modal-btn';retry.style.marginTop='10px';
  retry.addEventListener('click',()=>{retry.disabled=true;loadDashboard();});td.appendChild(retry);tr.appendChild(td);body.replaceChildren(tr);
}
loadDashboard=async function(){
  const ticket=++dashboardTicket,token=managerData.capture(false),t0=Basma.clock();dashRefreshAt=Date.now();
  let home;
  try{home=Basma.takeHome?.('managerHome')||await Basma.timeout(Basma.call('managerHome'),managerHomeTimeoutMs(),'managerHome');token.check();Basma.trace('الدالة managerHome',t0,true);}
  catch(error){if(error?.code==='stale-manager-scope'||ticket!==dashboardTicket)return;Basma.trace('الدالة managerHome',t0,false,error?.code||'error');dashboardError(error);return;}
  if(ticket!==dashboardTicket)return;
  const t1=Basma.clock();
  try{
    applyManagerHome(home);
    const rows=BasmaReports.build({employees:home.employees||{},records:home.records||{},leaves:home.leaves||{},excuses:home.excuses||{},settings:home.settings||{},from:home.date,to:home.date,warehouseId:dashWHFilter,timeZone:COMPANY_INFO.timeZone||'UTC'});
    const count=kind=>rows.filter(r=>r.classification===kind).length;
    document.getElementById('ds-total').textContent=rows.length;
    document.getElementById('ds-present').textContent=count('present')+count('excused');
    document.getElementById('ds-absent').textContent=count('absent');document.getElementById('ds-leave').textContent=count('leave');
    secureManagerView.table('dash-tbody',rows,r=>[r.name,r.role,r.warehouseName,r.statusLabel,secureManagerView.time(r.checkIn),secureManagerView.time(r.checkOut),r.locationName||'—'],r=>showEmpModal(r.employeeId));
    secureManagerView.filters();Basma.trace('عرض لوحة التحكم',t1,true);
  }catch(error){Basma.trace('عرض لوحة التحكم',t1,false,error?.code||'error');dashboardError(error);}
};
loadAttendance=async function(){
  const ticket=++attendanceTicket;
  const date=document.getElementById('att-date').value;if(!date)return;
  try{
    let rows=await secureManagerView.dataset(date,date,{warehouseId:document.getElementById('att-wh').value});
    if(ticket!==attendanceTicket||date!==document.getElementById('att-date').value)return;
    if(attStatusFilter!=='all')rows=rows.filter(r=>attStatusFilter==='present'?['present','excused'].includes(r.classification):attStatusFilter==='excused_out'?r.attendanceStatus==='excused_out':r.classification===attStatusFilter);
    secureManagerView.table('att-tbody',rows,r=>[r.name,r.role,r.warehouseName,r.statusLabel,secureManagerView.time(r.checkIn),secureManagerView.time(r.checkOut),r.delayMins],r=>secureManagerView.details([r],`${r.name} — ${date}`));
  }catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}
};
generateReport=async function(){
  const ticket=++reportTicket;
  reportData=[];document.getElementById('report-output').style.display='none';
  const get=id=>document.getElementById(id).value,from=get('rep-from'),to=get('rep-to');showLoading('جاري إعداد التقرير...');
  try{
    const rows=await secureManagerView.dataset(from,to,{warehouseId:get('rep-wh'),employeeId:get('rep-emp')});
    if(ticket!==reportTicket)return;
    reportData=rows.map(r=>({...r,emp:r.name,in:secureManagerView.time(r.checkIn),out:secureManagerView.time(r.checkOut),hrs:r.actualWorkMinutes==null?'—':(r.actualWorkMinutes/60).toFixed(2),delay:r.delayMins,note:r.statusLabel,noteType:r.classification}));
    secureManagerView.table('rep-tbody',reportData,r=>[r.name,r.date,r.in,r.out,r.hrs,r.delay,r.statusLabel],r=>secureManagerView.details([r],`${r.name} — ${r.date}`));
    const stats=document.getElementById('rep-stats');stats.replaceChildren();
    for(const [label,value]of [['السجلات',rows.length],['حضور',rows.filter(r=>r.classification==='present').length],['بعذر',rows.filter(r=>r.classification==='excused').length],['غياب',rows.filter(r=>r.classification==='absent').length]])stats.appendChild(secureManagerView.text('div',`${label}: ${value}`));
    document.getElementById('report-output').style.display='block';
  }catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}finally{hideLoading();}
};
calculatePayroll=async function(){
  const ticket=++payrollTicket;
  payrollData={};document.getElementById('payroll-output').style.display='none';
  const month=document.getElementById('pr-month').value;
  if(!/^\d{4}-\d{2}$/.test(month)){showToast('اختر الشهر','error');return;}
  const from=`${month}-01`,[y,m]=month.split('-').map(Number);
  const end=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10),to=end<secureManagerView.today()?end:secureManagerView.today();
  if(from>to){showToast('لا يمكن احتساب شهر مستقبلي','error');return;}
  showLoading('جاري احتساب الرواتب...');
  try{
    let days=await secureManagerView.dataset(from,to);
    const wh=document.getElementById('pr-wh').value,eid=document.getElementById('pr-emp').value;
    days=days.filter(r=>(eid==='all'||r.employeeId===eid)&&(wh==='all'||ALL_EMPLOYEES[r.employeeId].warehouseId===wh));
    const financial={};for(const id of new Set(days.map(r=>r.employeeId)))financial[id]=await secureManagerView.financial(id);
    if(ticket!==payrollTicket)return;
    const rows=BasmaReports.payroll(days,ALL_EMPLOYEES,financial);payrollData={rows,monthVal:month,workingDays:rows[0]?.workingDays||0};
    secureManagerView.table('pr-tbody',rows,r=>[r.name,r.empId,r.salary.toLocaleString(),r.absentDays,`${r.deductPct}%`,r.deduction.toLocaleString(),r.net.toLocaleString(),'عرض الأيام'],r=>secureManagerView.details(r.days,`${r.name} — ${month}`));
    const stats=document.getElementById('pr-stats');stats.replaceChildren();
    for(const [label,key]of [['إجمالي الرواتب','salary'],['الاستقطاع','deduction'],['الصافي','net']])stats.appendChild(secureManagerView.text('div',`${label}: ${rows.reduce((sum,r)=>sum+r[key],0).toLocaleString()}`));
    document.getElementById('payroll-output').style.display='block';
  }catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}finally{hideLoading();}
};

const secureOriginalModal=showEmpModal;
showEmpModal=async function(eid){
  await secureOriginalModal(eid);
  const parent=document.getElementById('emp-modal-box'),section=document.createElement('div');section.className='modal-section';
  section.appendChild(secureManagerView.text('h3','نقل إلى فرع'));
  const select=document.createElement('select');select.className='form-input';
  for(const [id,wh]of Object.entries(ALL_WAREHOUSES).filter(([,wh])=>wh.active)){const option=secureManagerView.text('option',wh.name);option.value=id;select.appendChild(option);}select.value=ALL_EMPLOYEES[eid].warehouseId;
  const button=secureManagerView.text('button','حفظ نقل الفرع');button.className='action-btn-full';button.addEventListener('click',async()=>{
    button.disabled=true;try{await Basma.call('transferEmployee',{employeeId:eid,warehouseId:select.value});closeEmpModal();await loadAllData();showToast('تم نقل الفرع مع حفظ السجلات السابقة','success');}catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}finally{button.disabled=false;}
  });section.append(select,button);parent.appendChild(section);
  const salary=document.getElementById('emp-salary-input'),deduction=document.getElementById('emp-deduction-input');salary.value='';deduction.value='';
  salary.disabled=deduction.disabled=true;
  try{const financial=await secureManagerView.financial(eid);salary.value=financial.salary;deduction.value=financial.deductionPercent;}catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'info');}finally{salary.disabled=deduction.disabled=false;}
};
saveEmpSalary=async function(eid){
  if(document.getElementById('emp-salary-input').disabled||document.getElementById('emp-salary-input').value.trim()===''||document.getElementById('emp-deduction-input').value.trim()===''){showToast('أكمل قيم الراتب والاستقطاع أولًا','error');return;}
  try{await Basma.call('setEmployeePayroll',{employeeId:eid,salary:Number(document.getElementById('emp-salary-input').value),deductionPercent:Number(document.getElementById('emp-deduction-input').value)});showToast('حُفظ الراتب في السجل المالي المحمي','success');}catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}
};
loadLocReview=()=>{};
approveLocation=rejectLocation=answerBypass=()=>showToast('اعتماد الموقع يتم على الخادم؛ تغيير الجهاز عبر إعادة التعيين من ملف الموظف','info');
document.getElementById('daily-details-close').addEventListener('click',()=>{document.getElementById('daily-details-modal').style.display='none';});
updateRepDates=function(){
  const today=secureManagerView.today(),type=document.getElementById('rep-type').value;
  let from=type==='daily'?today:`${today.slice(0,7)}-01`;
  if(type==='weekly'){const stamp=Date.parse(`${today}T12:00:00Z`),weekday=new Date(stamp).getUTCDay();from=new Date(stamp-weekday*86400000).toISOString().slice(0,10);}
  for(const [id,value]of [['rep-from',from],['rep-to',today]]){document.getElementById(id).value=value;document.getElementById(id).max=today;}
  const select=document.getElementById('rep-emp'),previous=select.value;select.replaceChildren();
  for(const [id,label]of [['all','كل الموظفين'],...Object.entries(ALL_EMPLOYEES).filter(([,e])=>e.status==='approved').map(([id,e])=>[id,e.name])]){const option=secureManagerView.text('option',label);option.value=id;select.appendChild(option);}select.value=previous||'all';
};
// The supplied inline navigation captured function references before adapters loaded.
// Replace these references as well as the global functions.
if(typeof pageLoaders!=='undefined'){
  pageLoaders.dash=()=>loadDashboard();pageLoaders.reports=()=>updateRepDates();
  pageLoaders.attend=()=>{const input=document.getElementById('att-date');if(!input.value)input.value=secureManagerView.today();return loadAttendance();};
  pageLoaders.payroll=()=>{const input=document.getElementById('pr-month');if(!input.value)input.value=secureManagerView.today().slice(0,7);secureManagerView.filters();};
}

// Central lifecycle: the cache and all subscriptions belong to this login only.
let managerSubscriptions=[],managerStatusSubscription=null;
function stopManagerSubscriptions(){for(const [query,handler]of managerSubscriptions)query.off('value',handler);managerSubscriptions=[];if(managerStatusSubscription){managerStatusSubscription[0].off('value',managerStatusSubscription[1]);managerStatusSubscription=null;}}
function clearManagerData(){if(adminNotifPageListener&&DB){DB.ref(`companies/${COMPANY_ID}/notifications/admin`).off('value',adminNotifPageListener);adminNotifPageListener=null;}if(adminNotifBadgeListener?.query){adminNotifBadgeListener.query.off('value',adminNotifBadgeListener.handler);adminNotifBadgeListener=null;}stopManagerSubscriptions();managerData.clear();dashboardTicket++;attendanceTicket++;reportTicket++;payrollTicket++;requestTickets.leaves++;requestTickets.excuses++;ALL_EMPLOYEES={};ALL_WAREHOUSES={};reportData=[];payrollData={};}
loadAllData=async function(){
  showLoading('جاري تحميل البيانات...');
  try{managerData.invalidate();await loadDashboard();populateWHSelects();loadBadges();loadAdminNotifBadge();}
  finally{hideLoading();}
};
const requestTickets={leaves:0,excuses:0};
async function loadManagerRequests(collection){
  const ticket=++requestTickets[collection],input=document.getElementById(`${collection}-month`),list=document.getElementById(`${collection}-list`);
  if(!input||!list)return;const month=input.value||secureManagerView.today().slice(0,7);input.value=month;list.replaceChildren(secureManagerView.text('p','جاري تحميل جميع صفحات الفترة...'));
  try{
    const token=managerData.capture(),values=await managerData.requests(collection,month);token.check();if(ticket!==requestTickets[collection]||month!==input.value)return;
    const items=Object.entries(values).map(([key,value])=>({...value,key})).sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1)||String(b.date).localeCompare(String(a.date))||a.key.localeCompare(b.key));
    let page=0;const size=200;
    const draw=()=>{list.replaceChildren();
      for(const row of items.slice(page*size,(page+1)*size)){
        const card=document.createElement('div');card.className='approval-card';
        const type=collection==='leaves'?({paid:'مدفوعة',unpaid:'غير مدفوعة',sick:'مرضية',emergency:'طارئة',partial:'زمنية'}[row.leaveType]||row.leaveType):({no_checkin:'لم يسجل حضورًا',no_checkout:'لم يسجل انصرافًا',no_both:'لم يسجل الحضور والانصراف'}[row.type]||row.type);
        for(const line of [row.empName,row.warehouseName,row.date,type,row.isPartial||row.leaveType==='partial'?`${row.fromTime||''} – ${row.toTime||''}`:'',row.reason,({approved:'مقبول',rejected:'مرفوض',pending:'معلق'}[row.status]||row.status)])if(line)card.appendChild(secureManagerView.text('div',line));
        if(row.status==='pending')for(const [label,status]of [['قبول','approved'],['رفض','rejected']]){
          const button=secureManagerView.text('button',label);button.className='modal-btn';button.addEventListener('click',async()=>{
            button.disabled=true;try{token.check();await Basma.call('reviewRequest',{collection,id:row.key,status});managerData.invalidate();await loadManagerRequests(collection);loadBadges();showToast('تم تحديث الطلب','success');}catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}finally{button.disabled=false;}
          });card.appendChild(button);
        }list.appendChild(card);
      }
      if(!items.length)list.appendChild(secureManagerView.text('p','لا توجد طلبات مطابقة'));
      const pager=document.createElement('div'),back=secureManagerView.text('button','السابق'),next=secureManagerView.text('button','التالي');
      back.disabled=page===0;next.disabled=(page+1)*size>=items.length;back.addEventListener('click',()=>{page--;draw();});next.addEventListener('click',()=>{page++;draw();});
      pager.append(back,secureManagerView.text('span',`${items.length?page*size+1:0}–${Math.min((page+1)*size,items.length)} من ${items.length}`),next);list.appendChild(pager);
    };draw();
  }catch(error){if(ticket!==requestTickets[collection])return;list.replaceChildren(secureManagerView.text('p','تعذر إكمال التحميل؛ لم تُعرض قائمة جزئية. أعد المحاولة.'));showToast(window.BasmaErrors?.message(error)??error.message,'error');}
}
loadLeaves=()=>loadManagerRequests('leaves');loadExcuses=()=>loadManagerRequests('excuses');
function refreshManagerRequests(collection){managerData.invalidate();return loadManagerRequests(collection);}
loadBadges=function(){
  for(const [query,handler]of managerSubscriptions)query.off('value',handler);managerSubscriptions=[];
  const token=managerData.capture(false);
  function watch(query,render){let initial=true;const handler=query.on('value',snapshot=>{try{token.check();render(snapshot);if(!initial){managerData.invalidate();if(currentPage==='leaves')loadLeaves();else if(currentPage==='excuses')loadExcuses();else if(currentPage==='dash')loadDashboard();}initial=false;}catch(error){if(error.code!=='stale-manager-scope')showToast(window.BasmaErrors?.message(error)??error.message,'error');}});managerSubscriptions.push([query,handler]);}
  for(const [collection,badgeId]of [['leaves','leaves-badge'],['excuses','excuse-badge']])watch(DB.ref(`companies/${COMPANY_ID}/${collection}`).orderByChild('status').equalTo('pending'),snapshot=>{const badge=document.getElementById(badgeId),count=snapshot.numChildren();badge.textContent=count;badge.style.display=count?'inline':'none';});
  const active={assigned:0,started:0};for(const status of ['assigned','started'])watch(DB.ref(`companies/${COMPANY_ID}/missions`).orderByChild('status').equalTo(status),snapshot=>{active[status]=snapshot.numChildren();const badge=document.getElementById('missions-badge');if(!badge)return;badge.textContent=active.assigned+active.started;badge.style.display=active.assigned+active.started?'inline':'none';});
  // Location review UI is retired; do not download its historical record badge.
  const badge=document.getElementById('loc-badge');if(badge)badge.style.display='none';
};
// Only unread notifications feed the badge. The history is fetched on its own page.
loadAdminNotifBadge=function(){
  const query=DB.ref(`companies/${COMPANY_ID}/notifications/admin`).orderByChild('read').equalTo(false),token=managerData.capture(false);
  if(adminNotifBadgeListener){adminNotifBadgeListener.query.off('value',adminNotifBadgeListener.handler);}
  const handler=query.on('value',snapshot=>{try{token.check();const count=snapshot.numChildren(),badge=document.getElementById('admin-notif-badge');badge.textContent=count;badge.style.display=count?'inline':'none';adminNotifCount=count;}catch{}});
  adminNotifBadgeListener={query,handler};
};
let dashRefresh=null,dashRefreshAt=0;
async function refreshVisibleManager(){
  if(typeof DB==='undefined'||!DB||document.visibilityState==='hidden')return;managerData.invalidate();
  // focus + pageshow + visibilitychange fire together on return: one dashboard request, and none within 15 s of the last.
  if(currentPage==='dash'){if(dashRefresh)return dashRefresh;if(Date.now()-dashRefreshAt<15000)return;dashRefreshAt=Date.now();dashRefresh=loadDashboard().finally(()=>{dashRefresh=null;});return dashRefresh;}
  try{const token=managerData.capture(),base=await managerData.base();token.check();ALL_EMPLOYEES=base.employees;ALL_WAREHOUSES=base.warehouses;secureManagerView.filters();
    if(currentPage==='reports'){if(reportData.length)await generateReport();return;}
    if(currentPage==='payroll'){if(payrollData.rows)await calculatePayroll();return;}
    const run=typeof pageLoaders!=='undefined'?pageLoaders[currentPage]:null;await run?.();
  }catch(error){if(error.code!=='stale-manager-scope')showToast(window.BasmaErrors?.message(error)??error.message,'error');}
}
refreshCurrentPage=()=>refreshVisibleManager();
window.addEventListener?.('focus',refreshVisibleManager);window.addEventListener?.('pageshow',refreshVisibleManager);
document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='visible')refreshVisibleManager();});
setInterval(()=>{if(document.visibilityState!=='hidden')refreshVisibleManager();},300000);
window.addEventListener?.('basma-session-ended',clearManagerData);
window.addEventListener?.('basma-manager-mutated',()=>{managerData.invalidate();});
if(typeof pageLoaders!=='undefined'){pageLoaders.leaves=()=>loadLeaves();pageLoaders.excuses=()=>loadExcuses();}

// Direct database mutations in the original manager UI must also evict cached metadata.
for(const name of ['saveEmpSchedule','clearEmpSchedule','addWarehouse','editWH','saveWhSchedule','clearWhSchedule','whGzSave','saveTimeWindows','addHoliday','deleteHoliday','saveGeoZone','approveEmp','rejectEmp']){
  const original=window[name];if(typeof original!=='function')continue;
  window[name]=async function(...args){managerData.invalidate();try{return await original.apply(this,args);}finally{managerData.invalidate();}};
}
