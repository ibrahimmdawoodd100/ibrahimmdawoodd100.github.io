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
  function build({records={},employees={},leaves={},excuses={},settings={},from,to,employeeId='all',warehouseId='all',timeZone='UTC'}) {
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
    for(const [eid,employee]of Object.entries(employees)) {
      if(employee.status!=='approved'||(employeeId!=='all'&&eid!==employeeId))continue;
      for(const date of days) {
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
  return {dateAt,dates,summary,build,payroll};
});
