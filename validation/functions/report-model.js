'use strict';
((root,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BasmaReports=api;})(typeof window==='object'?window:globalThis,()=>{
  function dateAt(value,timeZone='UTC') {
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)).map(x=>[x.type,x.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function dates(from,to) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw Error('نطاق التاريخ غير صالح');
    const start=Date.parse(`${from}T00:00:00Z`),end=Date.parse(`${to}T00:00:00Z`);
    if(!Number.isFinite(start)||!Number.isFinite(end)||(end-start)/86400000>366)throw Error('اختر فترة لا تتجاوز سنة');
    const result=[];for(let time=start;time<=end;time+=86400000)result.push(new Date(time).toISOString().slice(0,10));return result;
  }
  // ---- v5.17 business rules (owner, 22 Nov 2026). They apply from RULES_FROM on; earlier months keep v1. ----
  const RULES_FROM='2026-12-01';
  const ALL_DAYS=[0,1,2,3,4,5,6];
  // Work days: employee override, else branch, else every day that is not a company weekend (0=Sunday ... 6=Saturday).
  function workDaysOf(settings={},warehouse,employee){
    const own=employee?.workDays??warehouse?.workDays;
    if(own&&typeof own==='object'){const list=Object.values(own).map(Number).filter(d=>ALL_DAYS.includes(d));if(list.length)return [...new Set(list)].sort();}
    const weekends=Object.values(settings.weekendDays??[5]).map(Number);return ALL_DAYS.filter(d=>!weekends.includes(d));
  }
  // Shift start time (HH:MM): employee, else branch, else company. null = not set = nobody is late.
  function startTimeOf(settings={},warehouse,employee){return employee?.schedule?.startTime||warehouse?.schedule?.startTime||settings.startTime||null;}
  const dayOfWeek=date=>new Date(`${date}T12:00:00Z`).getUTCDay();
  const isHoliday=(settings={},date)=>Object.values(settings.holidays||{}).some(h=>h.active!==false&&h.date===date);
  const isWorkDay=(settings,warehouse,employee,date)=>workDaysOf(settings,warehouse,employee).includes(dayOfWeek(date))&&!isHoliday(settings,date);
  // Employment period from createdAt to disabledAt, as company dates.
  function employedOn(employee,date,timeZone){
    if(Number.isFinite(employee?.createdAt)&&date<dateAt(employee.createdAt,timeZone))return false;
    if(Number.isFinite(employee?.disabledAt)&&date>dateAt(employee.disabledAt,timeZone))return false;
    return true;
  }
  // v5.18: the branch an employee belonged to on a date (transfers are permanent; history keeps the old branch).
  function branchOn(employee,date,timeZone){
    const moves=Object.values(employee?.branchHistory||{}).filter(m=>Number.isFinite(m?.at)).sort((a,b)=>a.at-b.at);
    if(!moves.length)return employee?.warehouseId;
    let branch=moves[0].from||employee.warehouseId;
    for(const move of moves)if(dateAt(move.at,timeZone)<=date)branch=move.to;
    return branch;
  }
  function monthDates(month){const [y,m]=month.split('-').map(Number);return dates(`${month}-01`,new Date(Date.UTC(y,m,0)).toISOString().slice(0,10));}
  function summary(events={}) {
    const excuse=events.excused;
    const checkInExcused=!events.in&&!!excuse&&['no_checkin','no_both'].includes(excuse.excuseType);
    const checkOutExcused=!events.out&&!!excuse&&['no_checkout','no_both'].includes(excuse.excuseType);
    const excusedOut=(!!events.out&&checkInExcused)||(!events.out&&checkOutExcused);
    return {checkIn:events.in?.timestamp||null,checkOut:events.out?.timestamp||null,checkInExcused,checkOutExcused,
      attendanceStatus:excusedOut?'excused_out':events.out?'out':events.in?'present':checkInExcused?'excused_present':'absent',
      statusLabel:excusedOut?'انصرف (بعذر)':events.out?'انصرف':events.in?'حاضر':checkInExcused?'حاضر (بعذر)':'غائب',
      actualWorkMinutes:events.in&&events.out?Math.max(0,(Date.parse(events.out.timestamp)-Date.parse(events.in.timestamp))/60000):null};
  }
  function build({records={},employees={},leaves={},excuses={},settings={},warehouses={},from,to,employeeId='all',warehouseId='all',timeZone='UTC',today=null}) {
    const groups={},rows=[],days=dates(from,to);
    for(const record of Object.values(records)) {
      if(!record.empId||record.locStatus==='rejected'||!['in','out','excused'].includes(record.type))continue;
      const date=record.dateKey,key=`${record.empId}/${date}`;
      const events=groups[key]||={};
      if(!events[record.type]||(record.type==='in'?record.timestamp<events.in.timestamp:record.timestamp>events[record.type].timestamp))events[record.type]=record;
    }
    const leaveMap={};
    const employeeCount=Object.entries(employees).filter(([eid,e])=>e.status==='approved'&&(employeeId==='all'||employeeId===eid)).length;
    if(employeeCount*days.length>50000)throw Error('عدد التفاصيل كبير؛ اختر موظفًا أو فترة أقصر');
    for(const leave of Object.values(leaves))if(leave.status==='approved'&&!leave.isPartial&&leave.leaveType!=='partial')leaveMap[`${leave.empId}/${leave.date}`]=leave;
    const lateExcused={};for(const excuse of Object.values(excuses))if(excuse?.status==='approved'&&excuse.type==='late')lateExcused[`${excuse.empId}/${excuse.date}`]=true;
    for(const [eid,employee]of Object.entries(employees)) {
      if(employeeId!=='all'&&eid!==employeeId)continue;
      // v1: approved employees only. v2 dates: a disabled employee still counts for the days he was employed.
      const disabledV2=employee.status==='rejected'&&Number.isFinite(employee.disabledAt);
      if(employee.status!=='approved'&&!disabledV2)continue;
      for(const date of days) {
        if(date>=RULES_FROM){const row=dayV2({eid,employee,date,events:groups[`${eid}/${date}`]||{},leave:leaveMap[`${eid}/${date}`],lateExcuse:!!lateExcused[`${eid}/${date}`],settings,warehouses,warehouseId,timeZone,today});if(row)rows.push(row);continue;}
        if(employee.status!=='approved')continue;
        const key=`${eid}/${date}`,events={...groups[key]};
        const anchor=events.in||events.out||events.excused;
        const branch=anchor?.warehouseId||employee.warehouseId;
        if(warehouseId!=='all'&&branch!==warehouseId)continue;
        const value=summary(events),weekends=Object.values(settings.weekendDays??[5]);
        const holiday=weekends.includes(new Date(`${date}T12:00:00Z`).getUTCDay())||Object.values(settings.holidays||{}).some(h=>h.active!==false&&h.date===date);
        const leave=leaveMap[key];
        let classification=value.attendanceStatus==='absent'?'absent':value.checkInExcused||value.checkOutExcused?'excused':'present';
        if(classification==='absent'&&holiday){classification='holiday';value.statusLabel='عطلة';}
        else if(classification==='absent'&&leave){classification='leave';value.statusLabel='إجازة معتمدة';}
        rows.push({employeeId:eid,name:employee.name,empId:employee.empId||'',role:employee.role||'',date,warehouseId:branch,warehouseName:anchor?.warehouseName||employee.warehouseName||'',...value,classification,holiday,locationName:events.in?.locationName||events.out?.locationName||'',delayMins:events.in?.delayMins||0});
      }
    }
    return rows;
  }
  // v2 day: present (with "late"/"no check-out" marks), approved leave (paid or unpaid), non-work day, or absent.
  // Absence cannot be excused; only an approved full-day leave covers it. Late = display only.
  function dayV2({eid,employee,date,events,leave,lateExcuse,settings,warehouses,warehouseId,timeZone,today}){
    if(!employedOn(employee,date,timeZone))return null;
    const anchor=events.in||events.out,home=branchOn(employee,date,timeZone),branch=anchor?.warehouseId||home;
    if(warehouseId!=='all'&&branch!==warehouseId)return null;
    const warehouse=warehouses[home]||warehouses[employee.warehouseId],workDay=isWorkDay(settings,warehouse,employee,date);
    const checkIn=events.in?.timestamp||null,checkOut=events.out?.timestamp||null,delayMins=events.in?.delayMins||0;
    let classification,statusLabel,late=null;
    if(events.in){
      classification='present';statusLabel=checkOut?'انصرف':today&&date<today?'لم يسجل انصرافًا':'حاضر';
      if(delayMins>0){late=lateExcuse?'متأخر (بعذر)':'متأخر';statusLabel=`${statusLabel} — ${late}`;}
    } else if(leave){classification=leave.leaveType==='unpaid'?'unpaid_leave':'leave';statusLabel=leave.leaveType==='unpaid'?'إجازة بدون راتب':'إجازة معتمدة';}
    else if(!workDay){classification='holiday';statusLabel='عطلة';}
    else {classification='absent';statusLabel='غائب';}
    return {employeeId:eid,name:employee.name,empId:employee.empId||'',role:employee.role||'',date,warehouseId:branch,warehouseName:anchor?.warehouseName||(home===employee.warehouseId?employee.warehouseName:warehouses[home]?.name)||employee.warehouseName||'',
      checkIn,checkOut,checkInExcused:false,checkOutExcused:false,attendanceStatus:classification,statusLabel,late,noCheckout:!!events.in&&!checkOut&&!!today&&date<today,
      actualWorkMinutes:checkIn&&checkOut?Math.max(0,(Date.parse(checkOut)-Date.parse(checkIn))/60000):null,classification,holiday:!workDay,workDay,
      locationName:events.in?.locationName||events.out?.locationName||'',delayMins,rules:'v2'};
  }
  // v2 payroll (months from RULES_FROM): daily rate = salary / work days of the WHOLE month (same base as v1, whole month),
  // pay only for employed work days, deduction for absences and unpaid leave days. Late never deducts.
  function payrollV2(rows,employees,privatePayroll,{month,settings={},warehouses={},timeZone='UTC'}){
    const result=[],missing=[];
    for(const eid of new Set(rows.map(row=>row.employeeId))){
      const employee=employees[eid],financial=privatePayroll[eid];
      if(!financial||!Number.isFinite(financial.salary)||!Number.isFinite(financial.deductionPercent)){missing.push(eid);continue;}
      const all=monthDates(month).filter(d=>isWorkDay(settings,warehouses[branchOn(employee,d,timeZone)]||warehouses[employee.warehouseId],employee,d));
      const workingDays=all.length,employedDays=all.filter(d=>employedOn(employee,d,timeZone)).length,days=rows.filter(row=>row.employeeId===eid);
      const absentDays=days.filter(day=>day.classification==='absent'||day.classification==='unpaid_leave').length,rate=workingDays?financial.salary/workingDays:0;
      const due=Math.round(rate*employedDays),deduction=Math.round(rate*absentDays*financial.deductionPercent/100);
      result.push({employeeId:eid,name:employee.name,empId:employee.empId||'',salary:financial.salary,due,deductPct:financial.deductionPercent,absentDays,workingDays,employedDays,deduction,net:Math.max(0,due-deduction),days,rules:'v2'});
    }
    return {rows:result,missing};
  }
  function payroll(rows,employees,privatePayroll) {
    const result=[];
    for(const eid of new Set(rows.map(row=>row.employeeId))) {
      const days=rows.filter(row=>row.employeeId===eid),financial=privatePayroll[eid];
      if(!financial||!Number.isFinite(financial.salary)||!Number.isFinite(financial.deductionPercent))throw Error(`بيانات الراتب غير مكتملة للموظف ${employees[eid]?.name||eid}`);
      const workingDays=days.filter(day=>!day.holiday).length,absentDays=days.filter(day=>day.classification==='absent').length;
      const deduction=Math.round(workingDays?financial.salary/workingDays*absentDays*financial.deductionPercent/100:0);
      result.push({employeeId:eid,name:employees[eid].name,empId:employees[eid].empId||'',salary:financial.salary,deductPct:financial.deductionPercent,absentDays,workingDays,deduction,net:Math.max(0,Math.round(financial.salary-deduction)),days});
    }
    return result;
  }
  return {dateAt,dates,summary,build,payroll,payrollV2,workDaysOf,startTimeOf,isWorkDay,employedOn,monthDates,branchOn,RULES_FROM};
});
