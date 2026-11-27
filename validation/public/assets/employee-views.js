'use strict';
const secureEmployeeDate=()=>BasmaReports.dateAt(new Date(secureAttendanceWindows.now()),COMPANY_INFO.timeZone||'UTC');
function secureZoneCheck(){
  const zone=WAREHOUSE_GEO_ZONE&&WAREHOUSE_GEO_ZONE.enabled!==false?WAREHOUSE_GEO_ZONE:SETTINGS?.geoZone?.enabled?SETTINGS.geoZone:null;
  const alert=document.getElementById('geo-zone-alert');
  if(!zone){GEO_ZONE_OK=true;alert.style.display='none';return true;}
  let message='';
  if(!Number.isFinite(GPS_DATA.lat)||!Number.isFinite(GPS_DATA.lng)){GEO_ZONE_OK=false;message='اسمح بتحديد الموقع وانتظر اكتماله';}
  else{
    const zones=zone.zones?Object.values(zone.zones):[zone],tolerance=Math.min(Math.max(GPS_DATA.accuracy||0,0),150);
    const valid=zones.filter(z=>Number.isFinite(z.lat)&&Number.isFinite(z.lng)&&Number.isFinite(z.radius)&&z.radius>0&&z.radius<=100000);
    const excess=Math.min(...valid.map(z=>getDistanceMeters(GPS_DATA.lat,GPS_DATA.lng,z.lat,z.lng)-z.radius));
    GEO_ZONE_OK=excess<=tolerance;
    if(!GEO_ZONE_OK)message=valid.length?`خارج النطاق بمقدار ${Math.ceil(excess)} متر؛ السماحية ${Math.round(tolerance)} متر، والزائد بعدها ${Math.ceil(excess-tolerance)} متر.`:'يلزم ضبط نطاق الموقع بواسطة المدير';
  }
  alert.style.display=GEO_ZONE_OK?'none':'flex';if(message)alert.querySelector('.gz-text').textContent=message;return GEO_ZONE_OK;
}
checkGeoZone=function(){secureZoneCheck();return secureAttendanceWindows.evaluate();};
getGPS=async function(){
  const dot=document.getElementById('gps-dot'),label=document.getElementById('gps-text');dot.className='gps-dot gps-loading';label.textContent='جاري تحديد الموقع...';
  try{GPS_DATA={...await Basma.getGPS(),name:'موقع الجهاز'};dot.className='gps-dot gps-ok';label.textContent=`الموقع محدد؛ دقة GPS نحو ${Math.round(GPS_DATA.accuracy)} متر`;}
  catch(error){GPS_DATA={lat:null,lng:null,accuracy:null,name:null};dot.className='gps-dot gps-err';label.textContent=window.BasmaErrors?.message(error)??error.message;}
  secureZoneCheck();secureAttendanceWindows.evaluate();
};
checkHoliday=function(date,settings){const day=BasmaReports.dateAt(date,COMPANY_INFO.timeZone||'UTC');return Object.values(settings?.weekendDays??[5]).includes(new Date(`${day}T12:00:00Z`).getUTCDay())||Object.values(settings?.holidays||{}).some(h=>h.date===day&&h.active!==false);};
const secureAttendanceWindows=(()=>{
  let anchor=null,clockPending=null,view=null,seeded=null,current=null,knownVersion=null;
  const mono=()=>performance.now();
  function now(){return anchor&&mono()-anchor.at<1800000?anchor.server+mono()-anchor.at:NaN;} // 30 min (sleep detector re-anchors after sleep)
  async function sync(){
    if(clockPending)return clockPending;
    clockPending=(async()=>{const before=mono(),result=await Basma.call('serverClock'),after=mono();if(!Number.isFinite(result.serverTime))throw Error('تعذرت مزامنة وقت الخادم');anchor={server:result.serverTime+(after-before)/2,at:after};SERVER_TIME_OFFSET=anchor.server-Date.now();})();
    try{await clockPending;}finally{clockPending=null;}
  }
  // Never replace today's state with an OLDER copy of the same day (a re-read can arrive before the projection
  // trigger has written the new check-in; the attendance answer itself carries the newer state). E2E v5.12.
  const newer=(old,incoming)=>{incoming=incoming||{};if(old?.dateKey&&old.dateKey===incoming.dateKey&&(Number(old.ledgerRevision)||0)>(Number(incoming.ledgerRevision)||0))return old;if(old?.dateKey&&incoming.dateKey&&old.dateKey>incoming.dateKey)return old;if(old?.dateKey&&!incoming.dateKey&&(Number(old.ledgerRevision)||0)>0)return old;return incoming;};
  function apply(home,before=mono()){
    const after=mono();
    if(!Number.isFinite(home.serverTime))throw Error('تعذرت مزامنة وقت الخادم');
    anchor={server:home.serverTime+(after-before)/2,at:after};SERVER_TIME_OFFSET=anchor.server-Date.now();
    COMPANY_INFO=home.info;SETTINGS=home.settings||{};geocoderConfig=home.geocoder||null;EMP={...home.employee,id:ACTIVATION_UID||EMP.id};
    const wh=home.warehouse||{};WAREHOUSE_GEO_ZONE=(home.employee?.geoZone?.lat!=null&&home.employee.geoZone.enabled!==false?home.employee.geoZone:wh.geoZone)||null; // v5.18: his special work location firstWAREHOUSE_SCHEDULE=wh.schedule||null;
    current={today:newer(current?.today,home.today),date:home.date,onLeave:home.onLeave,schedule:EMP.schedule||wh.schedule||SETTINGS,device:home.device||{status:'none'},workDays:Array.isArray(home.workDays)?home.workDays:null,startTime:home.startTime||null};
    knownVersion=home.scheduleVersion??knownVersion;
    for(const id of ['main-wh-name','profile-wh'])document.getElementById(id).textContent=wh.name||EMP.warehouseName||'';
    for(const id of ['splash-company-name','wh-company-name','reg-company-name','main-company-name']){const el=document.getElementById(id);if(el)el.textContent=COMPANY_INFO.nameAr||COMPANY_INFO.name||'الشركة';}
    for(const id of ['splash-logo','wh-logo','reg-logo','login-logo','main-logo']){const el=document.getElementById(id);if(el)el.textContent=COMPANY_INFO.logo||'🏭';}
    return current;
  }
  async function load(){
    if(seeded){const home=seeded;seeded=null;return apply(home);}
    const before=mono(),home=await Basma.call('employeeHome');return apply(home,before);
  }
  function updateToday(snapshot){if(current){current.today=newer(current.today,snapshot.val());view?.evaluate();}}
  function render(cache,stamp){
    const inButton=document.getElementById('btn-checkin'),outButton=document.getElementById('btn-checkout');
    inButton.disabled=true;outButton.disabled=true;
    if(!cache||!Number.isFinite(stamp)){document.getElementById('win-msg').textContent='بانتظار مزامنة وقت الخادم والجدول؛ تحقق من الاتصال';return 60000;}
    const zone=COMPANY_INFO.timeZone||'UTC',day=BasmaClock.parts(stamp,zone).date,state=cache.today.dateKey===day?cache.today:{};
    if(cache.date!==day){get().refresh();return 1000;}
    const onLeave=cache.onLeave===true;
    // v5.17: work days come from the server (branch, employee override, else company weekend); holidays still apply.
    const holiday=checkHoliday(new Date(stamp),SETTINGS)||(cache.workDays?!cache.workDays.includes(new Date(`${day}T12:00:00Z`).getUTCDay()):false),schedule=cache.schedule;
    document.getElementById('leave-banner').style.display=onLeave?'block':'none';document.getElementById('holiday-banner').style.display=holiday?'block':'none';document.getElementById('fp-card').style.display=onLeave||holiday?'none':'block';
    const incoming=BasmaClock.windowState(stamp,zone,schedule.checkIn),outgoing=BasmaClock.windowState(stamp,zone,schedule.checkOut);
    const geo=secureZoneCheck();
    inButton.disabled=onLeave||holiday||!geo||!incoming.open||!!state.checkIn||!!state.checkOut;
    outButton.disabled=onLeave||holiday||!geo||!outgoing.open||!!state.checkOut||!(state.checkIn||state.checkInExcused);
    // v5.19: the server refuses a check-out within 10 minutes of the check-in; the button waits too.
    const sinceIn=state.checkIn?stamp-Date.parse(state.checkIn):Infinity,waitMins=sinceIn<600000?Math.ceil((600000-sinceIn)/60000):0;
    if(waitMins&&!state.checkOut)outButton.disabled=true;
    setProfileStatus(onLeave?'في إجازة':holiday?'عطلة':state.statusLabel||'بانتظار الحضور',state.attendanceStatus==='excused_out'?'badge-blue':'badge-gray');
    document.getElementById('win-msg').textContent=(state.checkInExcused&&!state.checkOut?'العذر معتمد؛ يمكنك تسجيل الانصراف ضمن وقته وبالتحقق من البصمة والموقع':state.statusLabel||'سجّل حضورك ضمن نافذة الدوام')+(state.checkIn&&cache.startTime&&state.delayMins>0?` — متأخر ${state.delayMins} دقيقة`:'')+(waitMins&&!state.checkOut?` — يمكنك الانصراف بعد ${waitMins} دقيقة`:'');
    document.getElementById('tw-in-range').textContent=`${schedule.checkIn.from} — ${schedule.checkIn.to}`;document.getElementById('tw-out-range').textContent=`${schedule.checkOut.from} — ${schedule.checkOut.to}`;
    document.getElementById('tw-in-status').textContent=incoming.label;document.getElementById('tw-out-status').textContent=outgoing.label;
    // v5.15: a fingerprint/device the manager has not approved yet cannot record attendance (the server refuses too).
    if(cache.device?.status==='pending'){inButton.disabled=true;outButton.disabled=true;document.getElementById('win-msg').textContent='بصمتك أو جهازك الجديد بانتظار اعتماد المدير؛ لا يمكن تسجيل الحضور قبل الاعتماد. ستتحدث الصفحة وحدها بعد الاعتماد.';}
    window.basmaRenderPartial?.();
    return Math.min(incoming.nextMs,outgoing.nextMs,waitMins&&!state.checkOut?Math.max(1000,(600000-sinceIn)%60000||60000):Infinity); // re-check each minute while waiting
  }
  function get(){if(!view)view=BasmaClock.controller({now,load,render,refreshMs:900000,onError:error=>{document.getElementById('btn-checkin').disabled=true;document.getElementById('btn-checkout').disabled=true;document.getElementById('win-msg').textContent=window.BasmaErrors?.message(error)??error.message;}});return view;}
  function foreground(){if(EMP?.id&&view)get().foreground();}
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')foreground();});
  for(const event of ['focus','pageshow','online','basma-attendance-settled'])window.addEventListener(event,foreground);
  // v5.15: manager changes (schedules, branches, holidays, device approval) reach an open page within ~30 s: one tiny
  // server call returns the company's schedule version; only a CHANGED version re-reads employeeHome.
  async function checkVersion(){
    if(!EMP?.id||!view||document.visibilityState==='hidden')return;
    try{const value=(await Basma.timeout(Basma.call('employeeList',{kind:'version'}),20000,'employeeList')).value??0;if(knownVersion!==null&&value!==knownVersion){knownVersion=value;get().refresh();}else knownVersion=value;}catch{}
  }
  // v5.16 cost: every 3 min +-30 s (jitter spreads load), only while visible; focus/online/wake re-read at once.
  const pollEvery=()=>{const base=Number(window.BASMA_VERSION_POLL_MS)||180000;return base+(window.BASMA_VERSION_POLL_MS?0:Math.round((Math.random()-0.5)*60000));};
  const schedulePoll=()=>{if(typeof setTimeout==='function')setTimeout(async()=>{await checkVersion();schedulePoll();},pollEvery());};
  schedulePoll();
  // Phone sleep: performance.now() may stop while asleep, so the server-anchored clock would lag. If wall-clock time
  // jumped well past the monotonic clock, re-read (new server-time anchor) before showing any window state.
  let wall=Date.now(),monoAt=mono();
  if(typeof setInterval==='function')setInterval(()=>{const w=Date.now(),m=mono();if((w-wall)-(m-monoAt)>5000)foreground();wall=w;monoAt=m;},2000);
  return {seed:home=>{seeded=home;apply(home);},updateToday,get today(){return current?.today||{};},start:()=>get().start(),refresh:()=>get().foreground(),evaluate:()=>view?.evaluate(),sync,now};
})();
loadWinStatus=()=>secureAttendanceWindows.start();
loadTodayStats=async function(){
  const raw=secureAttendanceWindows.today,day=raw.dateKey===secureEmployeeDate()?raw:{};
  const clock=value=>new Date(value).toLocaleTimeString('ar',{timeZone:COMPANY_INFO.timeZone||'UTC',hour:'2-digit',minute:'2-digit'});
  document.getElementById('stat-in').textContent=day.checkIn?clock(day.checkIn):day.checkInExcused?'بعذر':'—';
  document.getElementById('stat-out').textContent=day.checkOut?clock(day.checkOut):day.checkOutExcused?'بعذر':'—';
  document.getElementById('stat-hrs').textContent=day.actualWorkMinutes==null?'—':`${(day.actualWorkMinutes/60).toFixed(1)} ساعة`;
  document.getElementById('stat-delay').textContent=day.delayMins?`${day.delayMins} دقيقة`:'—';document.getElementById('stat-loc').textContent=day.locationName||'—';
};
submitExcuse=async function(){
  try{await Basma.call('submitRequest',{kind:'excuse',reason:document.getElementById('excuse-reason').value,type:document.querySelector('input[name="excuse-type"]:checked')?.value});showToast('أُرسل العذر بتاريخ الخادم','success');loadExcusePage();}catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}
};
loadHistory=async function(){
  const container=document.getElementById('main-tab-hist');container.replaceChildren();
  const title=document.createElement('h2');title.textContent='سجلاتي';container.appendChild(title);
  try{
    const snapshot=await DB.ref(`companies/${COMPANY_ID}/records`).orderByChild('empId').equalTo(EMP.id).limitToLast(200).once('value');
    const records=Object.values(snapshot.val()||{}).sort((a,b)=>(b.dateKey||b.timestamp).localeCompare(a.dateKey||a.timestamp));
    for(const record of records){
      const card=document.createElement('div');card.className='today-status-card';
      const label={in:'حضور',out:'انصراف',excused:'عذر معتمد',mission_start:'بدء مهمة',mission_end:'إنهاء مهمة',departure:'مغادرة زمنية',return:'عودة من إجازة زمنية'}[record.type]||'سجل حضور';
      const stamp=record.type==='excused'?'':new Date(record.timestamp).toLocaleTimeString('ar',{timeZone:COMPANY_INFO.timeZone||'UTC',hour:'2-digit',minute:'2-digit'});
      card.textContent=`${record.dateKey||BasmaReports.dateAt(record.timestamp,COMPANY_INFO.timeZone||'UTC')} — ${label} ${stamp}`;container.appendChild(card);
    }
    if(!records.length){const empty=document.createElement('p');empty.textContent='لا توجد سجلات بعد';container.appendChild(empty);}
  }catch(error){showToast(window.BasmaErrors?.message(error)??error.message,'error');}
};

serverNow=()=>{const value=secureAttendanceWindows.now();return new Date(Number.isFinite(value)?value:Date.now()+SERVER_TIME_OFFSET);};
updateClock=function(){
  const value=secureAttendanceWindows.now();
  if(!Number.isFinite(value)){document.getElementById('main-clock').textContent='مزامنة الوقت…';return;}
  const now=new Date(value),timeZone=COMPANY_INFO.timeZone||'UTC';
  document.getElementById('main-clock').textContent=now.toLocaleTimeString('ar-SA',{timeZone,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  document.getElementById('main-date').textContent=now.toLocaleDateString('ar-SA',{timeZone,weekday:'long',year:'numeric',month:'long',day:'numeric'});
};

// Delay uses the same own-day projection; no extra read on home open.
loadMonthlyDelay=async function(){
  const raw=secureAttendanceWindows.today,day=raw.dateKey===secureEmployeeDate()?raw:{};
  const card=document.getElementById('delay-card');card.style.display=day.checkIn&&day.delayMins>0?'flex':'none';
  if(day.delayMins>0){document.getElementById('monthly-delay-val').textContent=day.delayMins;document.getElementById('monthly-delay-label').textContent=`${Math.floor(day.delayMins/60)} ساعة و${day.delayMins%60} دقيقة`;}
};
const secureNotificationPage=loadNotifPage;
loadNotifPage=function(){loadNotifBadge();return secureNotificationPage();};
// v5.11: notifications page from the employeeList server call (newest 100), 20 s limit, Arabic error + retry,
// empty text; shown unread items are marked read through the server. Text only (no HTML from data).
let notifTicket=0;
loadNotifPage=async function(){
  const container=document.getElementById('main-tab-notifs');if(!container)return;
  const ticket=++notifTicket,header=document.createElement('div');header.className='page-header';header.appendChild(Object.assign(document.createElement('h2'),{textContent:'🔔 الإشعارات'}));
  const list=document.createElement('div');list.className='notif-list';list.id='notif-list';list.style.paddingBottom='90px';container.replaceChildren(header,list);
  list.replaceChildren(Basma.stateBox('loading',{text:'جاري تحميل الإشعارات...'}));
  try{loadNotifBadge();}catch{}
  let result;
  try{result=await Basma.timeout(Basma.call('employeeList',{kind:'notifications'}),Number(window.BASMA_LIST_TIMEOUT_MS)||20000,'employeeList');}
  catch(error){if(ticket!==notifTicket)return;list.replaceChildren(Basma.stateBox('error',{text:'تعذر تحميل الإشعارات. '+(window.BasmaErrors?.message(error,'')||error?.message||''),error,retry:()=>loadNotifPage()}));return;}
  if(ticket!==notifTicket)return;
  const items=(result.order||[]).slice().reverse().map(key=>({key,...result.items?.[key]})).filter(n=>n&&typeof n==='object'&&n.message!==undefined);
  if(!items.length){list.replaceChildren(Basma.stateBox('empty',{text:'🔕 لا توجد إشعارات'}));return;}
  const icon={approved:'✅',rejected:'❌',excuse_res:'📝',leave_res:'🌴',private_msg:'💬',broadcast:'🔔',loc_rejected:'📍',checkin:'⏰',checkout:'🚪',mission_assigned:'📋',mission:'📋'};
  list.replaceChildren(...items.map(n=>{
    const item=document.createElement('div');item.className='notif-item'+(n.read?'':' unread')+(n.type==='private_msg'?' private':'');
    const head=document.createElement('div');head.className='notif-head';
    head.append(Object.assign(document.createElement('span'),{className:'notif-icon-type',textContent:`${icon[n.type]||'🔔'}${n.type==='private_msg'?' رسالة خاصة':''}`}),Object.assign(document.createElement('span'),{className:'notif-date',textContent:n.timestamp?new Date(n.timestamp).toLocaleString('ar'):''}));
    item.append(head,Object.assign(document.createElement('div'),{className:'notif-msg',textContent:String(n.message||'')}));return item;}));
  const updates={};for(const n of items)if(!n.read)updates[`${n.key}/read`]=true;
  if(Object.keys(updates).length)DB.ref(`companies/${COMPANY_ID}/notifications/${EMP.id}`).update(updates).catch(()=>{});
};
// v6.8 (owner, 27 Nov 2026): readable address of a check-in/out, AFTER it is saved. One request at most (cache first),
// 3 s timeout, ONE retry 20 s later. While it loads: «جارٍ تحديد العنوان…». No address: the distance from the branch.
let geocoderConfig=null;
window.basmaCheckinAddress=async function(type,date,point){
  const box=document.getElementById('gps-address');if(!box||!window.BasmaAddress)return;
  const show=(text,href,credit)=>{box.replaceChildren();box.style.display='block';box.append(document.createTextNode('📍 '+text));
    if(href){const a=document.createElement('a');a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.textContent=' (الخريطة)';box.append(a);}
    if(credit){const c=document.createElement('a');c.href='https://www.openstreetmap.org/copyright';c.target='_blank';c.rel='noopener noreferrer';c.textContent=' '+credit;c.style.cssText='font-size:10px;opacity:.7';box.append(c);}};
  show('جارٍ تحديد العنوان…');
  const config=geocoderConfig,branch=WAREHOUSE_GEO_ZONE?{name:document.getElementById('main-wh-name')?.textContent||'الفرع',geoZone:WAREHOUSE_GEO_ZONE}:null;
  const fallback=()=>{const p=BasmaAddress.place({lat:point.lat,lng:point.lng},branch);show(p?.text||'تم التسجيل',p?.href);};
  let found=config?await BasmaAddress.lookup(config,point):null;
  if(!found&&config){fallback();await new Promise(r=>setTimeout(r,20000));found=await BasmaAddress.lookup(config,point);} // one retry later
  if(!found){fallback();return;}
  show(found.text,BasmaAddress.mapUrl({lat:point.lat,lng:point.lng}),config.credit||'');
  try{await Basma.call('employeeList',{kind:'setAddress',type,date,text:found.text,lang:found.lang});}catch(error){Basma.trace?.('حفظ عنوان الحضور',Basma.clock?.()||0,false,error?.code||'error');}
};

