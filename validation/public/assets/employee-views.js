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
  catch(error){GPS_DATA={lat:null,lng:null,accuracy:null,name:null};dot.className='gps-dot gps-err';label.textContent=error.message;}
  secureZoneCheck();secureAttendanceWindows.evaluate();
};
checkHoliday=function(date,settings){const day=BasmaReports.dateAt(date,COMPANY_INFO.timeZone||'UTC');return Object.values(settings?.weekendDays??[5]).includes(new Date(`${day}T12:00:00Z`).getUTCDay())||Object.values(settings?.holidays||{}).some(h=>h.date===day&&h.active!==false);};
const secureAttendanceWindows=(()=>{
  let anchor=null,clockPending=null,view=null,seeded=null,current=null;
  const mono=()=>performance.now();
  function now(){return anchor&&mono()-anchor.at<600000?anchor.server+mono()-anchor.at:NaN;}
  async function sync(){
    if(clockPending)return clockPending;
    clockPending=(async()=>{const before=mono(),result=await Basma.call('serverClock'),after=mono();if(!Number.isFinite(result.serverTime))throw Error('تعذرت مزامنة وقت الخادم');anchor={server:result.serverTime+(after-before)/2,at:after};SERVER_TIME_OFFSET=anchor.server-Date.now();})();
    try{await clockPending;}finally{clockPending=null;}
  }
  function apply(home,before=mono()){
    const after=mono();
    if(!Number.isFinite(home.serverTime))throw Error('تعذرت مزامنة وقت الخادم');
    anchor={server:home.serverTime+(after-before)/2,at:after};SERVER_TIME_OFFSET=anchor.server-Date.now();
    COMPANY_INFO=home.info;SETTINGS=home.settings||{};EMP={...home.employee,id:ACTIVATION_UID||EMP.id};
    const wh=home.warehouse||{};WAREHOUSE_GEO_ZONE=wh.geoZone||null;WAREHOUSE_SCHEDULE=wh.schedule||null;
    current={today:home.today||{},date:home.date,onLeave:home.onLeave,schedule:EMP.schedule||wh.schedule||SETTINGS};
    for(const id of ['main-wh-name','profile-wh'])document.getElementById(id).textContent=wh.name||EMP.warehouseName||'';
    for(const id of ['splash-company-name','wh-company-name','reg-company-name','main-company-name']){const el=document.getElementById(id);if(el)el.textContent=COMPANY_INFO.nameAr||COMPANY_INFO.name||'الشركة';}
    for(const id of ['splash-logo','wh-logo','reg-logo','login-logo','main-logo']){const el=document.getElementById(id);if(el)el.textContent=COMPANY_INFO.logo||'🏭';}
    return current;
  }
  async function load(){
    if(seeded){const home=seeded;seeded=null;return apply(home);}
    const before=mono(),home=await Basma.call('employeeHome');return apply(home,before);
  }
  function updateToday(snapshot){if(current){current.today=snapshot.val()||{};view?.evaluate();}}
  function render(cache,stamp){
    const inButton=document.getElementById('btn-checkin'),outButton=document.getElementById('btn-checkout');
    inButton.disabled=true;outButton.disabled=true;
    if(!cache||!Number.isFinite(stamp)){document.getElementById('win-msg').textContent='بانتظار مزامنة وقت الخادم والجدول؛ تحقق من الاتصال';return 60000;}
    const zone=COMPANY_INFO.timeZone||'UTC',day=BasmaClock.parts(stamp,zone).date,state=cache.today.dateKey===day?cache.today:{};
    if(cache.date!==day){get().refresh();return 1000;}
    const onLeave=cache.onLeave===true;
    const holiday=checkHoliday(new Date(stamp),SETTINGS),schedule=cache.schedule;
    document.getElementById('leave-banner').style.display=onLeave?'block':'none';document.getElementById('holiday-banner').style.display=holiday?'block':'none';document.getElementById('fp-card').style.display=onLeave||holiday?'none':'block';
    const incoming=BasmaClock.windowState(stamp,zone,schedule.checkIn),outgoing=BasmaClock.windowState(stamp,zone,schedule.checkOut);
    const geo=secureZoneCheck();
    inButton.disabled=onLeave||holiday||!geo||!incoming.open||!!state.checkIn||!!state.checkOut;
    outButton.disabled=onLeave||holiday||!geo||!outgoing.open||!!state.checkOut||!(state.checkIn||state.checkInExcused);
    setProfileStatus(onLeave?'في إجازة':holiday?'عطلة':state.statusLabel||'بانتظار الحضور',state.attendanceStatus==='excused_out'?'badge-blue':'badge-gray');
    document.getElementById('win-msg').textContent=state.checkInExcused&&!state.checkOut?'العذر معتمد؛ يمكنك تسجيل الانصراف ضمن وقته وبالتحقق من البصمة والموقع':state.statusLabel||'سجّل حضورك ضمن نافذة الدوام';
    document.getElementById('tw-in-range').textContent=`${schedule.checkIn.from} — ${schedule.checkIn.to}`;document.getElementById('tw-out-range').textContent=`${schedule.checkOut.from} — ${schedule.checkOut.to}`;
    document.getElementById('tw-in-status').textContent=incoming.label;document.getElementById('tw-out-status').textContent=outgoing.label;
    window.basmaRenderPartial?.();
    return Math.min(incoming.nextMs,outgoing.nextMs);
  }
  function get(){if(!view)view=BasmaClock.controller({now,load,render,onError:error=>{document.getElementById('btn-checkin').disabled=true;document.getElementById('btn-checkout').disabled=true;document.getElementById('win-msg').textContent=error.message;}});return view;}
  function foreground(){if(EMP?.id&&view)get().foreground();}
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')foreground();});
  for(const event of ['focus','pageshow','basma-attendance-settled'])window.addEventListener(event,foreground);
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
  try{await Basma.call('submitRequest',{kind:'excuse',reason:document.getElementById('excuse-reason').value,type:document.querySelector('input[name="excuse-type"]:checked')?.value});showToast('أُرسل العذر بتاريخ الخادم','success');loadExcusePage();}catch(error){showToast(error.message,'error');}
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
  }catch(error){showToast(error.message,'error');}
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
