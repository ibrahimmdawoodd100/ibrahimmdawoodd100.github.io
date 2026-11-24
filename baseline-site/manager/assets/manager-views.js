'use strict';
// Final adapters for the three HTML files explicitly supplied on 15 October.
// Base data (staff, settings, branches) comes from the managerHome server call, never from direct database reads.
const managerData=BasmaManagerData.create(()=>({db:DB,cid:COMPANY_ID,session:Basma.profile||DB}),{loadBase:()=>Basma.timeout(Basma.call('managerHome'),Number(window.BASMA_MANAGER_TIMEOUT_MS)||25000,'managerHome')});
// v5.16 cost: CLOSED months cached on this phone (IndexedDB, read-only). Before using a cached month, one tiny call asks
// for the month's version (changed by any record/leave/excuse/approval in that month); only a changed month is
// downloaded again. Firebase stays the source of truth; logout deletes this cache. No IndexedDB = no cache.
const monthCache=(()=>{
  let dbp=null;
  const open=()=>dbp||(dbp=new Promise(resolve=>{try{const r=indexedDB.open('basma-month-cache',1);r.onupgradeneeded=()=>r.result.createObjectStore('months');r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);}catch{resolve(null);}}));
  const run=async(mode,fn)=>{const db=await open();if(!db)return null;return new Promise(resolve=>{try{const t=db.transaction('months',mode),req=fn(t.objectStore('months'));t.oncomplete=()=>resolve(req?.result??null);t.onerror=()=>resolve(null);}catch{resolve(null);}});};
  return {get:key=>run('readonly',st=>st.get(key)),put:(key,value)=>run('readwrite',st=>st.put(value,key))};
})();
const lastDay=month=>{const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
async function closedMonth(a,b,fetchPart){
  const month=a.slice(0,7);
  if(a!==`${month}-01`||b!==lastDay(month)||month>=secureManagerView.today().slice(0,7))return fetchPart();
  const key=`${COMPANY_ID}:${month}`;
  let version=null;try{version=(await Basma.timeout(Basma.call('managerList',{kind:'monthVersions',months:[month]}),Number(window.BASMA_MANAGER_TIMEOUT_MS)||25000,'managerList')).versions?.[month]??null;}catch{return fetchPart();}
  const cached=await monthCache.get(key);
  if(cached&&version!==null&&cached.version===version)return cached.data;
  const data=await fetchPart();if(version!==null)monthCache.put(key,{version,data});return data;
}
// Records, leaves and excuses for any range: managerRecords, at most 31 days per call (reports split longer ranges).
async function managerRange(from,to){
  const merged={records:{},leaves:{},excuses:{}};let start=Date.parse(`${from}T00:00:00Z`);const end=Date.parse(`${to}T00:00:00Z`);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>end)throw Error('نطاق التاريخ غير صالح');
  while(start<=end){
    const stop=Math.min(end,start+30*86400000),a=new Date(start).toISOString().slice(0,10),b=new Date(stop).toISOString().slice(0,10),t0=Basma.clock();
    try{const part=await closedMonth(a,b,()=>Basma.timeout(Basma.call('managerRecords',{from:a,to:b}),Number(window.BASMA_MANAGER_TIMEOUT_MS)||25000,'managerRecords'));Basma.trace(`الدالة managerRecords ${a}…${b}`,t0,true);for(const key of ['records','leaves','excuses'])Object.assign(merged[key],part[key]||{});}
    catch(error){Basma.trace(`الدالة managerRecords ${a}…${b}`,t0,false,error?.code||'error');throw error;}
    start=stop+86400000;
  }
  return merged;
}
// Table states: loading rows while data is fetched; a clear Arabic error with a retry button instead of an empty table.
function tableLoading(id,columns){const body=document.getElementById(id);if(!body)return;const rows=[];for(let i=0;i<3;i++){const tr=document.createElement('tr');for(let c=0;c<columns;c++){const td=document.createElement('td');td.textContent='…';td.style.opacity='.45';tr.appendChild(td);}rows.push(tr);}body.replaceChildren(...rows);}
function tableError(id,columns,error,retry){const body=document.getElementById(id);if(!body)return;const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=columns;td.style.textAlign='center';td.style.padding='24px';
  td.appendChild(secureManagerView.text('div','تعذر تحميل البيانات. '+(window.BasmaErrors?.message(error,'')??error?.message??'')));
  const button=secureManagerView.text('button','إعادة المحاولة');button.className='modal-btn';button.style.marginTop='10px';button.addEventListener('click',()=>{button.disabled=true;retry();});td.appendChild(button);tr.appendChild(td);body.replaceChildren(tr);}
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
    // Two server calls at most (base is cached from managerHome); no direct database read, no clock read.
    const [base,range]=await Promise.all([managerData.base(),managerRange(from,to)]);
    token.check();ALL_EMPLOYEES=base.employees;ALL_WAREHOUSES=base.warehouses;
    return BasmaReports.build({employees:base.employees,records:range.records,leaves:range.leaves,excuses:range.excuses,settings:base.settings,warehouses:typeof ALL_WAREHOUSES==='object'?ALL_WAREHOUSES:{},today:today(),from,to,employeeId,warehouseId,timeZone:COMPANY_INFO.timeZone||'UTC'});
  }
  function options(select,values,first) {
    const selected=select.value;select.replaceChildren();const all=text('option',first);all.value='all';select.appendChild(all);
    for(const [id,label]of values){const option=text('option',label);option.value=id;select.appendChild(option);}select.value=[...select.options].some(x=>x.value===selected)?selected:'all';
  }
  function filters() {
    options(el('pr-wh'),Object.entries(ALL_WAREHOUSES).map(([id,w])=>[id,w.name]),'كل الفروع الحالية');
    options(el('pr-emp'),Object.entries(ALL_EMPLOYEES).filter(([,e])=>e.status==='approved').map(([id,e])=>[id,e.name]),'كل الموظفين');
  }
  async function financial(eid,{optional=false}={}) {
    const token=managerData.capture(false);
    const value=(await token.db.ref(`privatePayroll/${token.cid}/${eid}`).once('value')).val();token.check();
    if(!value){if(optional)return null;throw Error('أدخل بيانات الراتب من ملف الموظف أولًا');}return value;
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
  // Badges and company status arrive inside managerHome: the badge listeners start from them (no extra call).
  if(home.badges&&typeof DB?.prime==='function'){DB.prime('managerList',{kind:'badges'},home.badges);DB.poll?.();} // badge listeners update from this answer (no extra call)
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
    const rows=BasmaReports.build({employees:home.employees||{},records:home.records||{},leaves:home.leaves||{},excuses:home.excuses||{},settings:home.settings||{},warehouses:typeof ALL_WAREHOUSES==='object'?ALL_WAREHOUSES:{},today:home.date,from:home.date,to:home.date,warehouseId:dashWHFilter,timeZone:COMPANY_INFO.timeZone||'UTC'});
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
  tableLoading('att-tbody',7);
  try{
    let rows=await secureManagerView.dataset(date,date,{warehouseId:document.getElementById('att-wh').value});
    if(ticket!==attendanceTicket||date!==document.getElementById('att-date').value)return;
    if(attStatusFilter!=='all')rows=rows.filter(r=>attStatusFilter==='present'?['present','excused'].includes(r.classification):attStatusFilter==='excused_out'?r.attendanceStatus==='excused_out':r.classification===attStatusFilter);
    secureManagerView.table('att-tbody',rows,r=>[r.name,r.role,r.warehouseName,r.statusLabel,secureManagerView.time(r.checkIn),secureManagerView.time(r.checkOut),r.delayMins],r=>secureManagerView.details([r],`${r.name} — ${date}`));
  }catch(error){if(error?.code==='stale-manager-scope'||ticket!==attendanceTicket)return;tableError('att-tbody',7,error,()=>loadAttendance());}
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
  // v5.17: months from December 2026 use the new rules, computed on the server (same rules file). A closed month is
  // saved after its 5-day grace and never recalculated. Earlier months keep the old calculation below, unchanged.
  if(from>=BasmaReports.RULES_FROM){
    try{
      const result=await Basma.timeout(Basma.call('managerList',{kind:'payrollMonth',month}),Number(window.BASMA_LIST_TIMEOUT_MS)||30000,'managerList');
      if(ticket!==payrollTicket)return;
      const wh=document.getElementById('pr-wh').value,eid=document.getElementById('pr-emp').value;
      const rows=(result.rows||[]).filter(r=>(eid==='all'||r.employeeId===eid)&&(wh==='all'||ALL_EMPLOYEES[r.employeeId]?.warehouseId===wh));
      payrollData={rows,monthVal:month,workingDays:rows[0]?.workingDays||0};
      secureManagerView.table('pr-tbody',rows,r=>[r.name,r.empId,r.salary.toLocaleString(),r.absentDays,`${r.deductPct}%`,r.deduction.toLocaleString(),r.net.toLocaleString(),'عرض الأيام'],
        r=>secureManagerView.details(r.days.map(d=>({...d,name:r.name,warehouseName:'',checkIn:null,checkOut:null,actualWorkMinutes:null})),`${r.name} — ${month}`));
      const stats=document.getElementById('pr-stats');stats.replaceChildren();
      for(const [label,key]of [['الرواتب المستحقة','due'],['الاستقطاع','deduction'],['الصافي','net']])stats.appendChild(secureManagerView.text('div',`${label}: ${rows.reduce((sum,r)=>sum+r[key],0).toLocaleString()}`));
      stats.appendChild(secureManagerView.text('div',result.frozen?'🔒 شهر مغلق ومحفوظ؛ لا يُعاد احتسابه.':result.closed?`⏳ الشهر مغلق؛ تُحفظ الرواتب نهائيًا بعد ${result.graceUntil} (مهلة قرارات الإجازات).`:'📅 الشهر الحالي: الخصم على أيام عمل الشهر كله، والتأخير للعرض فقط.'));
      if(result.missing?.length)stats.appendChild(secureManagerView.text('div',`⚠️ لا توجد بيانات راتب لـ: ${result.missing.join('، ')}. أدخلها من ملف الموظف ليظهر في الرواتب.`));
      document.getElementById('payroll-output').style.display='block';
    }catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}finally{hideLoading();}
    return;
  }
  try{
    let days=await secureManagerView.dataset(from,to);
    const wh=document.getElementById('pr-wh').value,eid=document.getElementById('pr-emp').value;
    days=days.filter(r=>(eid==='all'||r.employeeId===eid)&&(wh==='all'||ALL_EMPLOYEES[r.employeeId].warehouseId===wh));
    // One employee without salary data no longer cancels everyone's payroll (found by E2E v5.15): the others are
    // calculated and the missing ones are named. Lookups run in parallel (independent calls).
    // v5.16: all salaries in ONE call (was one call per employee).
    const all=(await Basma.timeout(Basma.call('managerList',{kind:'payrollAll'}),Number(window.BASMA_LIST_TIMEOUT_MS)||20000,'managerList')).items||{};
    const financial={},missing=[];
    for(const id of new Set(days.map(r=>r.employeeId))){const value=all[id];if(value&&value.salary!=null)financial[id]=value;else missing.push(id);}
    days=days.filter(r=>!missing.includes(r.employeeId));
    if(ticket!==payrollTicket)return;
    const rows=BasmaReports.payroll(days,ALL_EMPLOYEES,financial);payrollData={rows,monthVal:month,workingDays:rows[0]?.workingDays||0};
    secureManagerView.table('pr-tbody',rows,r=>[r.name,r.empId,r.salary.toLocaleString(),r.absentDays,`${r.deductPct}%`,r.deduction.toLocaleString(),r.net.toLocaleString(),'عرض الأيام'],r=>secureManagerView.details(r.days,`${r.name} — ${month}`));
    const stats=document.getElementById('pr-stats');stats.replaceChildren();
    for(const [label,key]of [['إجمالي الرواتب','salary'],['الاستقطاع','deduction'],['الصافي','net']])stats.appendChild(secureManagerView.text('div',`${label}: ${rows.reduce((sum,r)=>sum+r[key],0).toLocaleString()}`));
    if(missing.length)stats.appendChild(secureManagerView.text('div',`⚠️ لا توجد بيانات راتب لـ: ${missing.map(id=>ALL_EMPLOYEES[id]?.name||id).join('، ')}. أدخلها من ملف الموظف ليظهر في الرواتب.`));
    document.getElementById('payroll-output').style.display='block';
  }catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}finally{hideLoading();}
};

const secureOriginalModal=showEmpModal;
showEmpModal=async function(eid){
  await secureOriginalModal(eid);
  const parent=document.getElementById('emp-modal-box'),section=document.createElement('div');section.className='modal-section';
  // v5.18: permanent transfer (until changed again with this same screen) + change log.
  const employee=ALL_EMPLOYEES[eid]||{};
  section.appendChild(secureManagerView.text('h3','🔁 نقل إلى فرع آخر'));
  section.appendChild(secureManagerView.text('div',`الفرع الحالي: ${ALL_WAREHOUSES[employee.warehouseId]?.name||employee.warehouseName||'—'}`));
  const select=document.createElement('select');select.className='form-input';
  for(const [id,wh]of Object.entries(ALL_WAREHOUSES).filter(([,wh])=>wh.active)){const option=secureManagerView.text('option',wh.name);option.value=id;select.appendChild(option);}select.value=employee.warehouseId;
  const button=secureManagerView.text('button','حفظ النقل');button.className='action-btn-full';button.addEventListener('click',async()=>{
    if(select.value===employee.warehouseId){showToast('اختر فرعًا غير فرعه الحالي','error');return;}
    const target=ALL_WAREHOUSES[select.value]?.name||'';
    if(!await BasmaDialogs.confirm('نقل الموظف',`سيُنقل «${employee.name||''}» إلى «${target}» نقلًا دائمًا. يأخذ دوام الفرع الجديد وأيامه وموقعه. أوقاته وأيامه الخاصة تبقى، وموقعه الخاص يعود لموقع الفرع الجديد. السجلات السابقة تبقى باسم الفرع القديم. البصمة والجهاز يبقيان صالحين.`,'نقل'))return;
    button.disabled=true;try{await Basma.call('transferEmployee',{employeeId:eid,warehouseId:select.value});closeEmpModal();await loadAllData();showToast('تم النقل؛ السجلات السابقة لم تتغير','success');}catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}finally{button.disabled=false;}
  });section.append(select,button);
  const logBox=secureManagerView.text('div','جاري تحميل سجل التغييرات...');logBox.style.cssText='font-size:12px;color:var(--text2);margin-top:10px';section.appendChild(logBox);
  parent.appendChild(section);
  Basma.call('managerList',{kind:'employeeLog',employeeId:eid}).then(result=>{
    const items=Object.values(result?.items||{}).sort((a,b)=>b.at-a.at),name=id=>ALL_WAREHOUSES[id]?.name||'';
    logBox.replaceChildren(secureManagerView.text('b','📜 سجل النقل وموقع العمل'));
    if(!items.length){logBox.appendChild(secureManagerView.text('div','لا توجد تغييرات بعد'));return;}
    const where=z=>z==='branch'||!z?'موقع الفرع':`نقطة على الخريطة (نطاق ${Math.round(z.radius)} م)`;
    for(const x of items){const when=new Date(x.at).toLocaleString('ar',{timeZone:COMPANY_INFO.timeZone||'UTC'}),who='المدير';
      logBox.appendChild(secureManagerView.text('div',x.type==='transfer'?`${when} — ${who}: نقل من «${x.fromName||name(x.from)}» إلى «${x.toName||name(x.to)}»${x.locationReset?' (أُعيد موقعه لموقع الفرع)':''}`:`${when} — ${who}: موقع العمل من ${where(x.from)} إلى ${where(x.to)}`));}
  }).catch(error=>{logBox.textContent='تعذر تحميل السجل: '+(window.BasmaErrors?.message(error)??error.message);});
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
    const token=managerData.capture(),values=(await Basma.timeout(Basma.call('managerRecords',{kind:'requests',collection,month}),Number(window.BASMA_MANAGER_TIMEOUT_MS)||25000,'managerRecords')).items||{};token.check();if(ticket!==requestTickets[collection]||month!==input.value)return;
    const items=Object.entries(values).map(([key,value])=>({...value,key})).sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1)||String(b.date).localeCompare(String(a.date))||a.key.localeCompare(b.key));
    let page=0;const size=200;
    const draw=()=>{list.replaceChildren();
      for(const row of items.slice(page*size,(page+1)*size)){
        const card=document.createElement('div');card.className='approval-card';
        const type=collection==='leaves'?({paid:'مدفوعة',unpaid:'غير مدفوعة',sick:'مرضية',emergency:'طارئة',partial:'زمنية'}[row.leaveType]||row.leaveType):(row.type==='late'?`عذر تأخير${row.delayMins?` (${row.delayMins} دقيقة)`:''}`:({no_checkin:'لم يسجل حضورًا (نوع قديم)',no_checkout:'لم يسجل انصرافًا (نوع قديم)',no_both:'لم يسجل الحضور والانصراف (نوع قديم)'}[row.type]||row.type));
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
setInterval(()=>{if(document.visibilityState!=='hidden')refreshVisibleManager();},600000); // v5.16: 10 min (was 5); focus/visibility still refresh
window.addEventListener?.('basma-session-ended',clearManagerData);
window.addEventListener?.('basma-manager-mutated',()=>{managerData.invalidate();});
if(typeof pageLoaders!=='undefined'){pageLoaders.leaves=()=>loadLeaves();pageLoaders.excuses=()=>loadExcuses();}

saveTimeWindows=async function(){
  const v=id=>document.getElementById(id).value,checkIn={from:v('ci-from'),to:v('ci-to')},checkOut={from:v('co-from'),to:v('co-to')};
  if(crossesMidnight(checkIn,checkOut)){showToast(MIDNIGHT_MSG,'error');return;}
  if(checkOut.from<checkIn.to){showToast(OVERLAP_MSG,'error');setNote('tw-overlap-note',OVERLAP_MSG);return;}
  try{await Basma.call('managerSettings',{action:'timeWindows',checkIn,checkOut,startTime:v('start-time')||null});setNote('tw-overlap-note','');showToast('تم حفظ نوافذ الوقت','success');}
  catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}
};
if(typeof loadEmpSchedule==='function'){const originalLoad=loadEmpSchedule;loadEmpSchedule=function(...args){const result=originalLoad.apply(this,args);const emp=ALL_EMPLOYEES[document.getElementById('sched-emp-sel')?.value]||{};
  const start=document.getElementById('sched-start');if(start)start.value=emp.schedule?.startTime||'';renderDays('sched-days',emp.workDays);
  empLocDraft=emp.geoZone?.lat!=null?{lat:emp.geoZone.lat,lng:emp.geoZone.lng,radius:emp.geoZone.radius}:null;
  const mode=document.getElementById('sched-loc-mode');if(mode)mode.value=empLocDraft?'other':'branch';showEmpLoc();setNote('sched-overlap-note',overlaps(emp.schedule)?overlapText(emp.schedule):'');return result;};}
saveEmpSchedule=async function(){
  const eid=document.getElementById('sched-emp-sel').value;if(!eid)return;const v=id=>document.getElementById(id).value;
  const schedule={checkIn:{from:v('sched-ci-from'),to:v('sched-ci-to')},checkOut:{from:v('sched-co-from'),to:v('sched-co-to')},startTime:v('sched-start')||null,workDays:readDays('sched-days')};
  if(!schedule.checkIn.from||!schedule.checkIn.to||!schedule.checkOut.from||!schedule.checkOut.to){showToast('أدخل جميع الأوقات','error');return;}
  if(crossesMidnight(schedule.checkIn,schedule.checkOut)){showToast(MIDNIGHT_MSG,'error');return;}
  if(schedule.checkOut.from<schedule.checkIn.to){showToast(OVERLAP_MSG,'error');setNote('sched-overlap-note',OVERLAP_MSG);return;}
  const other=document.getElementById('sched-loc-mode')?.value==='other';
  if(other&&!empLocDraft){showToast('اختر نقطة موقع العمل على الخريطة أولًا','error');return;}
  schedule.location=other?empLocDraft:'branch';
  try{await Basma.call('managerSettings',{action:'employeeSchedule',employeeId:eid,schedule});
    ALL_EMPLOYEES[eid]={...ALL_EMPLOYEES[eid],schedule:{checkIn:schedule.checkIn,checkOut:schedule.checkOut,...(schedule.startTime?{startTime:schedule.startTime}:{})},workDays:schedule.workDays,geoZone:other?{...empLocDraft,enabled:true}:null};setNote('sched-overlap-note','');refreshOverlapWarnings();showToast('تم حفظ جدول الموظف ✅','success');}
  catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}
};

if(typeof clearEmpSchedule==='function'){const originalClear=clearEmpSchedule;clearEmpSchedule=async function(...args){
  const eid=document.getElementById('sched-emp-sel')?.value,result=await originalClear.apply(this,args);
  // The server returns him to his branch location as well (v5.18).
  if(eid&&ALL_EMPLOYEES[eid]&&!ALL_EMPLOYEES[eid].schedule){ALL_EMPLOYEES[eid].geoZone=null;delete ALL_EMPLOYEES[eid].workDays;empLocDraft=null;setNote('sched-overlap-note','');refreshOverlapWarnings();const mode=document.getElementById('sched-loc-mode');if(mode)mode.value='branch';renderDays('sched-days',null);showEmpLoc();}
  return result;};}

// Direct database mutations in the original manager UI must also evict cached metadata.
for(const name of ['saveEmpSchedule','clearEmpSchedule','addWarehouse','editWH','saveWhSchedule','clearWhSchedule','whGzSave','saveTimeWindows','addHoliday','deleteHoliday','saveGeoZone','approveEmp','rejectEmp']){
  const original=window[name];if(typeof original!=='function')continue;
  window[name]=async function(...args){managerData.invalidate();try{return await original.apply(this,args);}finally{managerData.invalidate();}};
}

// ---- v5.10: list pages through managerList, branch changes through managerBranch (no direct database reads). ----
// Each page call has a 20 s limit; loading, error (Arabic + code + retry) and empty states are explicit.
const managerListTimeout=()=>Number(window.BASMA_LIST_TIMEOUT_MS)||20000;
async function managerListPage(kind,cursor){
  const t0=Basma.clock();
  try{const value=await Basma.timeout(Basma.call('managerList',cursor?{kind,cursor}:{kind}),managerListTimeout(),'managerList');Basma.trace(`الدالة managerList ${kind}`,t0,true);return value;}
  catch(error){Basma.trace(`الدالة managerList ${kind}`,t0,false,error?.code||'error');throw error;}
}
// Employees and branches: every page (the plan limits staff); returns items in server order plus branch counts.
async function managerListAll(kind){
  const items={},counts={};let cursor=null;
  for(let i=0;i<50;i++){const page=await managerListPage(kind,cursor);for(const id of page.order||Object.keys(page.items||{}))if(page.items?.[id])items[id]=page.items[id];Object.assign(counts,page.counts||{});if(!page.next)return {items,counts};cursor=page.next;}
  throw Object.assign(new Error('القائمة أطول من المتوقع'),{code:'basma/too-many-pages'});
}
const managerListState=(box,kind,options)=>{if(box)box.replaceChildren(Basma.stateBox(kind,options));};
const managerErrorText=error=>window.BasmaErrors?.message(error,'')||error?.message||'';
const listTickets={};
// Runs one list load; a newer load of the same list (or a logout) makes the older answer ignored.
async function managerListLoad(name,box,load,{loading='جاري التحميل...'}={}){
  const ticket=listTickets[name]=(listTickets[name]||0)+1,token=managerData.capture(false);
  managerListState(box,'loading',{text:loading});
  try{const value=await load();token.check();return ticket===listTickets[name]?value:null;}
  catch(error){if(ticket!==listTickets[name]||error?.code==='stale-manager-scope')return null;managerListState(box,'error',{text:'تعذر تحميل القائمة. '+managerErrorText(error),error,retry:()=>pageLoaders[currentPage]?.()});return null;}
}
async function refreshStaff(){const [staff,branches]=await Promise.all([managerListAll('employees'),managerListAll('warehouses')]);ALL_EMPLOYEES=staff.items;ALL_WAREHOUSES=branches.items;return {staff,branches};}

loadEmployees=async function(){
  const grid=document.getElementById('emp-grid');
  const value=await managerListLoad('employees',grid,refreshStaff,{loading:'جاري تحميل الموظفين...'});
  if(!value)return;populateWHSelects();filterEmps();loadPendingDevices();
};
// v5.15: fingerprints/devices waiting for the manager's approval (a new device cannot record attendance before).
async function loadPendingDevices(){
  const grid=document.getElementById('emp-grid');if(!grid?.parentElement)return;
  let box=document.getElementById('pending-devices-section');
  if(!box){box=document.createElement('div');box.id='pending-devices-section';grid.parentElement.insertBefore(box,grid);}
  let value;try{value=await managerListPage('devices');}catch(error){box.replaceChildren(Basma.stateBox('error',{text:'تعذر تحميل الأجهزة بانتظار الاعتماد. '+managerErrorText(error),error,retry:()=>loadPendingDevices()}));return;}
  const ids=value.order||[];
  if(!ids.length){box.replaceChildren();return;}
  const title=secureManagerView.text('div',`📱 أجهزة بانتظار الاعتماد (${ids.length})`);title.className='section-title';
  box.replaceChildren(title,...ids.map(eid=>{
    const d=value.items[eid]||{},row=document.createElement('div');row.className='approval-card';row.setAttribute?.('data-employee-id',eid);const buttons=[];
    row.append(secureManagerView.text('div',ALL_EMPLOYEES[eid]?.name||eid),secureManagerView.text('div',`${d.label||'جهاز'} — ${d.registeredAt?new Date(d.registeredAt).toLocaleString('ar'):''}`));
    for(const [label,action,cls] of [['اعتماد الجهاز','approve','btn-green'],['رفض','reject','btn-red']]){
      const button=secureManagerView.text('button',label);button.className=`modal-btn ${cls}`;
      button.addEventListener('click',async()=>{
        if(action==='reject'&&!await BasmaDialogs.confirm('رفض الجهاز','سيُحذف هذا الجهاز وعلى الموظف تسجيل البصمة من جديد (وتحتاج اعتمادك).','رفض'))return;
        for(const b of buttons)b.disabled=true;
        try{await Basma.timeout(Basma.call('managerDevice',{action,employeeId:eid}),managerListTimeout(),'managerDevice');showToast(action==='approve'?'تم اعتماد الجهاز':'تم رفض الجهاز','success');}
        catch(error){showToast('تعذر الحفظ. '+managerErrorText(error),'error');}
        loadPendingDevices();
      });buttons.push(button);row.appendChild(button);
    }
    return row;
  }));
}
loadApprovals=async function(){
  const list=document.getElementById('approvals-list');if(!list)return;
  const value=await managerListLoad('approvals',list,()=>managerListAll('employees'));if(!value)return;
  const items=Object.entries(value.items).filter(([,e])=>e.status==='pending');
  if(!items.length){managerListState(list,'empty',{text:'لا توجد طلبات'});return;}
  list.replaceChildren(...items.map(([key,emp])=>{const card=document.createElement('div');card.className='approval-card';card.append(secureManagerView.text('div',emp.name),secureManagerView.text('div',`${emp.empId||''} | ${emp.role||''}`));
    for(const [label,fn]of [['قبول',approveEmp],['رفض',rejectEmp]]){const button=secureManagerView.text('button',label);button.className='modal-btn';button.addEventListener('click',()=>fn(key,emp.name));card.appendChild(button);}return card;}));
};

loadWarehouses=async function(){
  const list=document.getElementById('warehouses-list');
  const value=await managerListLoad('warehouses',list,refreshStaff,{loading:'جاري تحميل الفروع...'});
  if(!value)return;populateWHSelects();
  const entries=Object.entries(ALL_WAREHOUSES);
  if(!entries.length){managerListState(list,'empty',{text:'لا توجد فروع بعد. أضف أول فرع من الأعلى.'});return;}
  list.replaceChildren(...entries.map(([id,wh])=>{
    const card=document.createElement('div');card.className='wh-card-admin';
    const info=document.createElement('div');info.className='wh-info';
    const name=secureManagerView.text('div',`🏭 ${wh.name||''}`);name.className='wh-name';
    const meta=secureManagerView.text('div',`${value.branches.counts[id]||0} موظف`);meta.className='wh-meta';
    const badges=document.createElement('div');badges.style.cssText='margin-top:4px;display:flex;flex-direction:column;gap:2px';
    const gz=wh.geoZone?.lat?secureManagerView.text('span',`📍 موقع محدد (${wh.geoZone.radius||300}م)`):secureManagerView.text('span','📍 لا يوجد موقع');gz.style.cssText=`font-size:11px;color:var(${wh.geoZone?.lat?'--green':'--text2'})`;
    const sc=wh.schedule?secureManagerView.text('span',`⏰ ${wh.schedule.checkIn?.from||'--'} – ${wh.schedule.checkOut?.to||'--'}`):secureManagerView.text('span','⏰ لا يوجد دوام خاص');sc.style.cssText=`font-size:11px;color:var(${wh.schedule?'--gold':'--text2'})`;
    badges.append(gz,sc);
    if(overlaps(wh.schedule)){const warn=secureManagerView.text('span','⚠️ أوقات متداخلة — صحّح دوام الفرع');warn.style.cssText='font-size:11px;color:var(--red);font-weight:700';badges.append(warn);}
    info.append(name,meta,badges);
    const actions=document.createElement('div');actions.className='wh-actions';
    for(const [label,cls,fn]of [['⏰','btn-gold',()=>showWhScheduleModal(id)],['📍','btn-green',()=>whSetGeoZone(id)],['✏️','btn-gray',()=>editWH(id)],['🗑','btn-red',()=>deleteWH(id)]]){const button=secureManagerView.text('button',label);button.className=`modal-btn ${cls}`;button.addEventListener('click',fn);actions.appendChild(button);}
    card.append(info,actions);return card;
  }));
};
// One branch change at a time; buttons stay disabled until the server answers (20 s limit), then the list reloads.
let branchBusy=false;
async function branchChange(payload,done,{button}={}){
  if(branchBusy)return false;branchBusy=true;if(button)button.disabled=true;
  try{await Basma.timeout(Basma.call('managerBranch',payload),managerListTimeout(),'managerBranch');showToast(done,'success');managerData.invalidate();loadWarehouses();return true;}
  catch(error){showToast('تعذر حفظ التغيير. '+managerErrorText(error),'error');return false;}
  finally{branchBusy=false;if(button)button.disabled=false;}
}
addWarehouse=async function(){
  const input=document.getElementById('new-wh-name'),name=input.value.trim();
  if(!name){showToast('أدخل اسم الفرع','error');return;}
  if(await branchChange({action:'add',name},'تم إضافة الفرع',{button:document.querySelector('[data-basma-click="addWarehouse()"]')}))input.value='';
};
editWH=async function(id){
  const answer=await BasmaDialogs.form('تعديل اسم الفرع',[{id:'name',label:'اسم الفرع',value:ALL_WAREHOUSES[id]?.name||''}]);
  const name=answer?.name?.trim();if(!name)return;await branchChange({action:'rename',id,name},'تم التعديل');
};
deleteWH=async function(id){
  if(!await BasmaDialogs.confirm('حذف الفرع',`هل تريد حذف الفرع «${ALL_WAREHOUSES[id]?.name||''}»؟`,'حذف'))return;
  await branchChange({action:'delete',id},'تم الحذف');
};
// v5.17 (owner Q3 = A): work days per branch, optional override per employee; start time decides lateness (Q2 = B).
const DAY_NAMES=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
function renderDays(id,values){
  const box=document.getElementById(id);dayInputs[id]=[];if(!box)return;const chosen=new Set(Object.values(values||{}).map(Number));box.replaceChildren();
  DAY_NAMES.forEach((name,day)=>{const label=document.createElement('label');label.style.cssText='display:flex;gap:4px;align-items:center;padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:12px';
    const input=document.createElement('input');input.type='checkbox';input.value=String(day);input.checked=chosen.has(day);dayInputs[id].push(input);label.append(input,document.createTextNode(name));box.append(label);});
}
const dayInputs={};
const readDays=id=>{const list=(dayInputs[id]||[]).filter(x=>x.checked).map(x=>Number(x.value));return list.length?list:null;};
const crossesMidnight=(...windows)=>windows.some(w=>w.from&&w.to&&w.from>=w.to);
const MIDNIGHT_MSG='كل نافذة يجب أن تبدأ وتنتهي في اليوم نفسه (مثل 08:00 إلى 09:00)';
// v5.19 (owner, 24 Nov 2026): the check-out window starts at or after the check-in window ends (same day).
// New saves are refused (here and on the server). Existing overlaps are NOT changed: the manager sees a warning.
const OVERLAP_MSG='أوقات متداخلة: وقت الانصراف يجب أن يبدأ عند نهاية وقت الحضور أو بعده';
const overlapsPair=(i,o)=>!!(i?.from&&i?.to&&o?.from&&i.from<=o.from&&o.from<i.to); // overnight pairs (out earlier on the clock) are not flagged
const overlaps=s=>overlapsPair(s?.checkIn,s?.checkOut);
const overlapText=s=>`⚠️ أوقات متداخلة: الحضور ${s.checkIn.from}–${s.checkIn.to} والانصراف يبدأ ${s.checkOut.from}. يعمل الجدول كما هو، لكن صحّحه ليبدأ الانصراف عند ${s.checkIn.to} أو بعده.`;
function setNote(id,text){const el=document.getElementById(id);if(!el)return;el.textContent=text||'';el.style.display=text?'block':'none';}
function refreshOverlapWarnings(){
  const names=Object.values(typeof ALL_EMPLOYEES==='object'?ALL_EMPLOYEES:{}).filter(e=>e?.status!=='rejected'&&overlaps(e.schedule)).map(e=>e.name||'');
  setNote('sched-overlap-warn',names.length?`⚠️ أوقات متداخلة في الجدول الخاص لـ: ${names.join('، ')}. اختر كل موظف وصحّح أوقاته.`:'');
}
showWhScheduleModal=function(id){
  whSchedCurrentId=id;const sc=ALL_WAREHOUSES[id]?.schedule||{};
  document.getElementById('wh-start').value=sc.startTime||'';renderDays('wh-days',ALL_WAREHOUSES[id]?.workDays);setNote('wh-overlap-note',overlaps(sc)?overlapText(sc):'');
  document.getElementById('wh-sched-modal-title').textContent='⏰ دوام: '+(ALL_WAREHOUSES[id]?.name||'');
  for(const [field,value]of [['wh-ci-from',sc.checkIn?.from],['wh-ci-to',sc.checkIn?.to],['wh-co-from',sc.checkOut?.from],['wh-co-to',sc.checkOut?.to]])document.getElementById(field).value=value||'';
  document.getElementById('wh-sched-modal').style.display='flex';
};
saveWhSchedule=async function(){
  const v=id=>document.getElementById(id).value,schedule={checkIn:{from:v('wh-ci-from'),to:v('wh-ci-to')},checkOut:{from:v('wh-co-from'),to:v('wh-co-to')}};
  if(!schedule.checkIn.from||!schedule.checkIn.to||!schedule.checkOut.from||!schedule.checkOut.to){showToast('أدخل جميع الأوقات','error');return;}
  if(crossesMidnight(schedule.checkIn,schedule.checkOut)){showToast(MIDNIGHT_MSG,'error');return;}
  if(schedule.checkOut.from<schedule.checkIn.to){showToast(OVERLAP_MSG,'error');setNote('wh-overlap-note',OVERLAP_MSG);return;}
  Object.assign(schedule,{startTime:v('wh-start')||null,workDays:readDays('wh-days')});
  if(await branchChange({action:'schedule',id:whSchedCurrentId,schedule},'تم حفظ أوقات الدوام')){
    const w=ALL_WAREHOUSES[whSchedCurrentId];if(w){w.schedule={checkIn:schedule.checkIn,checkOut:schedule.checkOut,...(schedule.startTime?{startTime:schedule.startTime}:{})};w.workDays=schedule.workDays;}document.getElementById('wh-sched-modal').style.display='none';}
};
clearWhSchedule=async function(){
  if(await branchChange({action:'schedule',id:whSchedCurrentId,schedule:null},'تم إزالة الدوام الخاص بالفرع'))document.getElementById('wh-sched-modal').style.display='none';
};
// The map opens with a saved zone from the loaded list (no database read). One map, two uses (v5.18):
// a branch location (saved at once) or an employee's special work location (kept in the schedule form until "save").
let gzMode='branch',empLocDraft=null;
function openGzMap(title,zone,saveLabel){
  whGzLat=null;whGzLng=null;
  document.getElementById('wh-gz-modal-title').textContent=title;
  const save=document.getElementById('wh-gz-save-btn');if(save)save.textContent=saveLabel;
  document.getElementById('wh-gz-modal').style.display='flex';
  setTimeout(()=>{
    if(!whGzReady){const el=document.getElementById('wh-gz-map');if(!el||!window.L)return;el.replaceChildren();
      whGzMap=L.map('wh-gz-map').setView([24.7136,46.6753],13);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'© Esri — Satellite',maxZoom:19}).addTo(whGzMap);
      whGzMap.on('click',e=>whGzSetLoc(e.latlng.lat,e.latlng.lng));whGzReady=true;}
    whGzMap.invalidateSize();
    const r=zone?.radius||300;document.getElementById('wh-gz-radius-val').value=r>=1000?(r/1000).toFixed(1):r;document.getElementById('wh-gz-radius-unit').value=r>=1000?'km':'m';
    if(zone?.lat!=null){whGzSetLoc(zone.lat,zone.lng);whGzMap.setView([zone.lat,zone.lng],16);}
  },300);
}
whSetGeoZone=function(id){
  gzMode='branch';whGzCurrentId=id;
  openGzMap('📍 موقع: '+(ALL_WAREHOUSES[id]?.name||''),ALL_WAREHOUSES[id]?.geoZone,'💾 حفظ موقع الفرع');
};
const zoneLabel=z=>z?`📍 ${Number(z.lat).toFixed(5)} ، ${Number(z.lng).toFixed(5)} — نطاق ${z.radius>=1000?(z.radius/1000).toFixed(1)+' كم':Math.round(z.radius)+' م'}`:'لم تُحدَّد نقطة بعد';
function showEmpLoc(){
  const mode=document.getElementById('sched-loc-mode')?.value||'branch',box=document.getElementById('sched-loc-box');
  if(box)box.style.display=mode==='other'?'block':'none';
  const text=document.getElementById('sched-loc-text');if(text)text.textContent=zoneLabel(empLocDraft);
}
window.empLocModeChanged=function(){showEmpLoc();};
window.pickEmpLocation=function(){
  const eid=document.getElementById('sched-emp-sel')?.value;if(!eid)return;const emp=ALL_EMPLOYEES[eid]||{};
  const branch=ALL_WAREHOUSES[emp.warehouseId]?.geoZone;
  // Default radius = his branch radius; the map starts at the saved point, else at his branch.
  const start=empLocDraft||(branch?.lat!=null?{lat:branch.lat,lng:branch.lng,radius:branch.radius||300}:{radius:300});
  gzMode='employee';openGzMap('🗺 موقع عمل: '+(emp.name||''),start,'✔ اعتماد هذه النقطة للموظف');
};
whGzSave=async function(){
  if(!whGzLat||!whGzLng){showToast('حدد الموقع على الخريطة أولاً','error');return;}
  if(gzMode==='employee'){
    empLocDraft={lat:whGzLat,lng:whGzLng,radius:Math.round(whGzGetRadius())};gzMode='branch';
    document.getElementById('wh-gz-modal').style.display='none';showEmpLoc();
    showToast('تم اختيار النقطة؛ اضغط «حفظ جدول الموظف» لاعتمادها','info');return;
  }
  if(await branchChange({action:'geoZone',id:whGzCurrentId,geoZone:{lat:whGzLat,lng:whGzLng,radius:whGzGetRadius()}},'تم حفظ موقع الفرع ✅'))document.getElementById('wh-gz-modal').style.display='none';
};
// Branch list for the "add employee" panel from the loaded list.
const originalToggleAddEmpPanel=typeof toggleAddEmpPanel==='function'?toggleAddEmpPanel:()=>{};
toggleAddEmpPanel=function(){
  originalToggleAddEmpPanel();
  const panel=document.getElementById('add-emp-panel'),select=document.getElementById('ae-wh');
  if(panel?.style.display!=='block'||!select)return;
  const fill=()=>{select.replaceChildren(Object.assign(document.createElement('option'),{value:'',textContent:'اختر الفرع...'}));for(const [id,wh]of Object.entries(ALL_WAREHOUSES).filter(([,wh])=>wh.active!==false))select.appendChild(Object.assign(document.createElement('option'),{value:id,textContent:wh.name||id}));};
  fill();if(!Object.keys(ALL_WAREHOUSES).length)managerListAll('warehouses').then(v=>{ALL_WAREHOUSES=v.items;fill();}).catch(error=>showToast('تعذر تحميل الفروع. '+managerErrorText(error),'error'));
};

loadSettings=async function(){
  const t0=Basma.clock();
  try{
    const {settings:s={}}=await managerListPage('settings');Basma.trace('الإعدادات',t0,true);
    document.getElementById('ci-from').value=s.checkIn?.from||'08:00';document.getElementById('ci-to').value=s.checkIn?.to||'09:00';
    document.getElementById('co-from').value=s.checkOut?.from||'16:00';document.getElementById('co-to').value=s.checkOut?.to||'17:00';
    loadHolidays(s.holidays||{});
  }catch(error){showToast('تعذر تحميل الإعدادات؛ لا تحفظ قبل «إعادة المحاولة». '+managerErrorText(error),'error');}
};

// Newest first, 50 per page, "عرض المزيد" for older messages.
loadMessages=async function(){
  const list=document.getElementById('sent-messages-list'),select=document.getElementById('msg-emp-select');
  const value=await managerListLoad('messages',list,async()=>{const [staff,page]=await Promise.all([managerListAll('employees'),managerListPage('messages')]);ALL_EMPLOYEES=staff.items;return page;},{loading:'جاري تحميل الرسائل...'});
  if(!value)return;
  const previous=select.value;select.replaceChildren(Object.assign(document.createElement('option'),{value:'',textContent:'اختر موظفاً...'}));
  for(const [id,e]of Object.entries(ALL_EMPLOYEES).filter(([,e])=>e.status==='approved'))select.appendChild(Object.assign(document.createElement('option'),{value:id,textContent:e.name}));
  if(previous)select.value=previous;
  const draw=page=>{
    for(const key of page.order||[]){const m=page.items[key];if(!m)continue;const item=document.createElement('div');item.className='msg-item';
      const head=document.createElement('div');head.className='msg-head';head.append(Object.assign(secureManagerView.text('span',ALL_EMPLOYEES[m.empId]?.name||m.empName||'موظف'),{className:'msg-emp'}),Object.assign(secureManagerView.text('span',m.read?'قُرئت':'لم تُقرأ'),{className:`msg-read ${m.read?'read':'unread'}`}));
      item.append(head,secureManagerView.text('div',m.message||''),Object.assign(secureManagerView.text('div',m.createdAt?new Date(m.createdAt).toLocaleString('ar'):''),{className:'msg-time'}));list.appendChild(item);}
    if(page.next){const more=secureManagerView.text('button','عرض المزيد');more.className='modal-btn';more.addEventListener('click',async()=>{more.disabled=true;try{const next=await managerListPage('messages',page.next);more.remove();draw(next);}catch(error){more.disabled=false;showToast('تعذر تحميل المزيد. '+managerErrorText(error),'error');}});list.appendChild(more);}
  };
  list.replaceChildren();if(!(value.order||[]).length){managerListState(list,'empty',{text:'لا توجد رسائل مرسلة'});return;}draw(value);
};

// Missions: newest first, 100 per page; filters apply to the loaded pages; "عرض المزيد" loads older ones.
let missionCache={order:[],items:{},next:null};
loadMissions=async function(){
  const list=document.getElementById('missions-list');if(!list)return;
  const value=await managerListLoad('missions',list,()=>managerListPage('missions'),{loading:'جاري تحميل المهام...'});
  if(!value)return;missionCache={order:[...(value.order||[])],items:{...(value.items||{})},next:value.next};drawMissions();
};
function drawMissions(){
  const list=document.getElementById('missions-list');if(!list)return;
  const emp=document.getElementById('mission-filter-emp')?.value||'all',status=document.getElementById('mission-filter-status')?.value||'all',date=document.getElementById('mission-filter-date')?.value||'';
  const rows=missionCache.order.map(key=>({key,...missionCache.items[key]})).filter(m=>(emp==='all'||m.empId===emp)&&(status==='all'||m.status===status)&&(!date||m.date===date));
  list.replaceChildren();
  if(!rows.length)managerListState(list,'empty',{text:missionCache.order.length?'لا توجد مهام مطابقة للتصفية':'لا توجد مهام'});
  const label={assigned:'🔔 مُسندة',started:'⚡ جارية',completed:'✅ مكتملة'},badge={assigned:'badge-gold',started:'badge-orange',completed:'badge-green'};
  for(const m of rows){
    const card=document.createElement('div');card.className=`mission-card mission-status-${m.status||'assigned'}`;
    const top=document.createElement('div');top.style.cssText='display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px';
    const who=document.createElement('div');who.append(Object.assign(secureManagerView.text('div',m.empName||'--'),{style:'font-size:15px;font-weight:700'}),Object.assign(secureManagerView.text('div',`📍 ${m.location||''}`),{style:'font-size:13px;color:var(--gold);margin-top:2px'}));
    if(m.description)who.appendChild(Object.assign(secureManagerView.text('div',m.description),{style:'font-size:12px;color:var(--text2);margin-top:4px'}));
    top.append(who,Object.assign(secureManagerView.text('span',label[m.status||'assigned']||m.status),{className:`badge ${badge[m.status||'assigned']||''}`}));
    const meta=secureManagerView.text('div',[`📅 ${m.date||''}`,m.expectedTime?`⏰ ${m.expectedTime}`:'',m.startedAt?`بدأت: ${format12(m.startedAt)}`:'',m.completedAt?`انتهت: ${format12(m.completedAt)}`:''].filter(Boolean).join('  •  '));meta.style.cssText='font-size:12px;color:var(--text2);margin-bottom:10px';
    const actions=document.createElement('div');actions.style.cssText='display:flex;gap:8px';
    for(const [text,cls,fn]of [['✏️ تعديل','btn-gray',()=>openMissionModal(m.key)],['🗑 حذف','btn-red',()=>deleteMission(m.key)]]){const button=secureManagerView.text('button',text);button.className=`modal-btn ${cls}`;button.addEventListener('click',fn);actions.appendChild(button);}
    card.append(top,meta,actions);list.appendChild(card);
  }
  if(missionCache.next){const more=secureManagerView.text('button','عرض المزيد');more.className='modal-btn';more.addEventListener('click',async()=>{more.disabled=true;try{const page=await managerListPage('missions',missionCache.next);missionCache.order.push(...(page.order||[]));Object.assign(missionCache.items,page.items||{});missionCache.next=page.next;drawMissions();}catch(error){more.disabled=false;showToast('تعذر تحميل المزيد. '+managerErrorText(error),'error');}});list.appendChild(more);}
}
// Editing a mission fills the form from the loaded list instead of reading the database.
const originalOpenMissionModal=typeof openMissionModal==='function'?openMissionModal:()=>{};
openMissionModal=function(key){
  originalOpenMissionModal();
  if(!key)return;const m=missionCache.items[key];if(!m)return;
  document.getElementById('mission-modal-title').textContent='✏️ تعديل مهمة';document.getElementById('mission-edit-key').value=key;
  document.getElementById('mission-emp-select').value=m.empId||'';
  for(const [field,value]of [['mission-location',m.location],['mission-desc',m.description],['mission-date',m.date],['mission-time',m.expectedTime]])document.getElementById(field).value=value||'';
};

// Activity notifications: newest 50 per page from the server; unread ones shown are marked read in the background.
loadAdminNotifPage=async function(){
  const list=document.getElementById('admin-notif-list');if(!list)return;
  if(adminNotifPageListener){DB.ref(`companies/${COMPANY_ID}/notifications/admin`).off('value',adminNotifPageListener);adminNotifPageListener=null;}
  const value=await managerListLoad('notifications',list,()=>managerListPage('notifications'),{loading:'جاري تحميل الإشعارات...'});
  if(!value)return;
  const icon={checkin:'⏰',checkout:'🚪',excuse_new:'📝',leave_new:'🌴',reg_new:'👤',mission:'📋'},label={checkin:'تسجيل حضور',checkout:'تسجيل انصراف',excuse_new:'عذر جديد',leave_new:'طلب إجازة',reg_new:'طلب تسجيل',mission:'تحديث مهمة'};
  const draw=page=>{
    const unread={};
    for(const key of page.order||[]){const n=page.items[key];if(!n)continue;if(!n.read)unread[`${key}/read`]=true;
      const item=document.createElement('div');item.style.cssText=`padding:14px 16px;border-radius:12px;margin-bottom:10px;background:var(--surface);border:1px solid ${n.read?'var(--border)':'var(--gold)'};border-right:4px solid ${n.read?'var(--border)':'var(--gold)'}`;
      const head=document.createElement('div');head.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:6px';
      head.append(Object.assign(secureManagerView.text('span',`${icon[n.type]||'🔔'} ${label[n.type]||''}`),{style:'font-weight:700;font-size:13px'}),Object.assign(secureManagerView.text('span',n.timestamp?new Date(n.timestamp).toLocaleString('ar'):''),{style:'font-size:11px;color:var(--text2)'}));
      item.append(head,Object.assign(secureManagerView.text('div',n.message||''),{style:'font-size:13px;line-height:1.6'}));list.appendChild(item);}
    if(Object.keys(unread).length)DB.ref(`companies/${COMPANY_ID}/notifications/admin`).update(unread).catch(()=>{});
    if(page.next){const more=secureManagerView.text('button','عرض المزيد');more.className='modal-btn';more.addEventListener('click',async()=>{more.disabled=true;try{const next=await managerListPage('notifications',page.next);more.remove();draw(next);}catch(error){more.disabled=false;showToast('تعذر تحميل المزيد. '+managerErrorText(error),'error');}});list.appendChild(more);}
  };
  list.replaceChildren();if(!(value.order||[]).length){managerListState(list,'empty',{text:'🔕 لا توجد إشعارات'});return;}draw(value);
};
// The inline page map holds the original functions; point it at the server-backed loaders.
if(typeof pageLoaders!=='undefined'){pageLoaders.emps=()=>loadEmployees();pageLoaders.warehouses=()=>loadWarehouses();pageLoaders.messages=()=>loadMessages();pageLoaders.settings=async()=>{refreshOverlapWarnings();updateRepDates();await loadSettings();const v=id=>document.getElementById(id)?.value;setNote('tw-overlap-note',overlapsPair({from:v('ci-from'),to:v('ci-to')},{from:v('co-from')})?overlapText({checkIn:{from:v('ci-from'),to:v('ci-to')},checkOut:{from:v('co-from')}}):'');};pageLoaders['admin-notifs']=()=>loadAdminNotifPage();}
// Leaflet is served from this site (/manager/assets/leaflet/); marker images come from the same folder.
if(window.L?.Icon?.Default)window.L.Icon.Default.imagePath='/manager/assets/leaflet/images/';
