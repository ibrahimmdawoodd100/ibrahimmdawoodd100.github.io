'use strict';
async function secureManagerOpen(profile) {
  clearManagerData();
  COMPANY_ID = profile.companyId; DB = Basma.db();
  // No direct database read before the page opens: name and time zone come from the profile call;
  // the rest (logo, settings, staff, today's attendance) from the managerHome call in loadDashboard.
  COMPANY_INFO = { nameAr: profile.name || '', timeZone: profile.timeZone || 'UTC' };
  for (const id of ['setup-screen', 'pin-screen']) { const el = document.getElementById(id); if (el) { el.style.display = 'none'; el.classList.add('hidden'); } }
  document.getElementById('sb-company').textContent = COMPANY_INFO.nameAr;
  document.getElementById('sb-logo').textContent = '🏭';
  Basma.controls();
  await loadAllData();
  // A live status listener closes a suspended tenant's UI immediately; database rules already deny it.
  const query=DB.ref(`companies/${COMPANY_ID}/info/status`),token=managerData.capture(false);
  const handler=query.on('value',snap=>{try{token.check();if(snap.val()!=='active')Basma.logout();}catch{}},()=>Basma.logout());
  managerStatusSubscription=[query,handler];
}
window.onload = async () => {
  try { const profile = await Basma.session('manager'); if (profile) await secureManagerOpen(profile); else document.getElementById('setup-screen').style.display = 'flex'; }
  catch (error) { Basma.banner(window.BasmaErrors?.message(error) ?? error.message); document.getElementById('setup-screen').style.display = 'flex'; }
};
directoryLogin = async function() {
  const btn = document.getElementById('dl-submit-btn'); btn.disabled = true;
  try { await secureManagerOpen(await Basma.login(document.getElementById('dl-username').value, document.getElementById('dl-password').value, 'manager')); document.getElementById('dl-password').value = ''; }
  catch (error) { const node = document.getElementById('setup-error'); node.textContent = error?.code === 'basma/timeout' ? error.message : 'تعذر الدخول. تحقق من بيانات الحساب وحالة الشركة.'; node.style.display = 'block'; }
  finally { btn.disabled = false; }
};
resetFirebaseConfig = resetFbCfg = lockAdmin = () => Basma.logout();
addEmployee = async function() {
  const value = id => document.getElementById(id).value;
  showLoading('جاري إضافة الموظف...');
  try {
    const account = await Basma.call('addEmployee', { name: value('ae-name'), empId: value('ae-empid'), role: value('ae-role'), warehouseId: value('ae-wh'), salary: Number(value('ae-salary')), deductionPercent: value('ae-deduction') === '' ? 100 : Number(value('ae-deduction')) });
    toggleAddEmpPanel(); await loadEmployees();
    showActLinkModal('تم إضافة الموظف', 'سلّم بيانات الدخول عبر قناة خاصة.', account.username, account.password, value('ae-name'));
  } catch (error) { showToast(window.BasmaErrors?.message(error) ?? error.message, 'error'); } finally { hideLoading(); }
};
createEmployeeDirectoryAccount = (eid) => Basma.call('employeeAccount', { employeeId: eid });
resetEmployeeBio = async function(eid) {
  if (!await BasmaDialogs.confirm('إعادة تعيين حساب الموظف', 'ستُلغى البصمة والجلسات القديمة وتُنشأ كلمة مرور جديدة. هل تريد المتابعة؟', 'إعادة التعيين')) return;
  showLoading('جاري إعادة التعيين...');
  let account;
  try { account = await Basma.call('employeeAccount', { employeeId: eid, resetBio: true }); }
  catch (error) { showToast(window.BasmaErrors?.message(error) ?? error.message, 'error'); return; }
  finally { hideLoading(); }
  await showActLinkModal('إعادة تعيين الحساب', 'أُلغيت الجلسات والبصمة القديمة.', account.username, account.password, ALL_EMPLOYEES[eid]?.name || '');
};
confirmDeleteEmp = function(eid) { showConfirm('تعطيل الموظف', 'سيُمنع دخول الموظف مع الاحتفاظ بسجلاته للمراجعة.', () => doDeleteEmp(eid)); };
doDeleteEmp = async function(eid) {
  try { await Basma.call('disableEmployee', { employeeId: eid }); closeConfirm(); closeEmpModal(); await loadAllData(); showToast('تم تعطيل الحساب', 'success'); }
  catch (error) { showToast(window.BasmaErrors?.message(error) ?? error.message, 'error'); }
};
overrideAttendance = async function(eid, status) {
  const answer = await BasmaDialogs.form('تعديل الحضور يدويًا', [{ id: 'reason', label: 'سبب التعديل (يُحفظ في سجل التدقيق)' }]);
  const reason = answer?.reason; if (!reason) return;
  try { await Basma.call('manualAttendance', { employeeId: eid, status, reason }); showToast('حُفظ التعديل منفصلًا عن إثبات البصمة', 'success'); closeEmpModal(); }
  catch (error) { showToast(window.BasmaErrors?.message(error) ?? error.message, 'error'); }
};
for (const [name, collection, status] of [['approveExcuse', 'excuses', 'approved'], ['rejectExcuse', 'excuses', 'rejected'], ['approveLeave', 'leaves', 'approved'], ['rejectLeave', 'leaves', 'rejected']]) {
  window[name] = async id => { try { await Basma.call('reviewRequest', { id, collection, status }); if (collection === 'leaves') loadLeaves(); else loadExcuses(); loadBadges(); showToast('تم تحديث الطلب', 'success'); } catch (error) { showToast(window.BasmaErrors?.message(error) ?? error.message, 'error'); } };
}
rejectPartialLeave = () => Promise.resolve();
rejectLocation = async function(key, empId, type) {
  try { await DB.ref(`companies/${COMPANY_ID}/records/${key}`).update({ locStatus: 'rejected' }); showToast('تم رفض الموقع مع حفظ السجل الأصلي', 'info'); loadLocReview(); loadBadges(); }
  catch (error) { showToast(window.BasmaErrors?.message(error) ?? error.message, 'error'); }
};
function securePrint(title, headers, rows) {
  const win = window.open('', '_blank');
  if (!win) { showToast('اسمح بفتح نافذة الطباعة', 'error'); return; }
  win.opener = null;
  win.document.documentElement.lang = 'ar'; win.document.documentElement.dir = 'rtl';
  win.document.title = title;
  const heading = win.document.createElement('h1'); heading.textContent = title; win.document.body.appendChild(heading);
  const button = win.document.createElement('button'); button.textContent = 'طباعة / حفظ PDF'; button.addEventListener('click', () => win.print()); win.document.body.appendChild(button);
  const table = win.document.createElement('table'); table.style.cssText = 'width:100%;border-collapse:collapse;font-family:sans-serif';
  for (const [index, row] of [headers, ...rows].entries()) {
    const tr = win.document.createElement('tr');
    for (const value of row) { const cell = win.document.createElement(index === 0 ? 'th' : 'td'); cell.textContent = String(value ?? ''); cell.style.cssText = 'padding:8px;border:1px solid #ddd;text-align:right'; tr.appendChild(cell); }
    table.appendChild(tr);
  }
  win.document.body.appendChild(table);
}
generatePDF = () => securePrint(`${COMPANY_INFO.nameAr} — تقرير الحضور`, ['الموظف','التاريخ','الحضور','الانصراف','الساعات','التأخير','ملاحظات'], reportData.map(row => [row.emp,row.date,row.in,row.out,row.hrs,row.delay,row.note]));
generatePayrollPDF = () => securePrint(`${COMPANY_INFO.nameAr} — كشف الرواتب`, ['الموظف','الرقم','الراتب','الغياب','نسبة الاستقطاع','الاستقطاع','الصافي'], (payrollData.rows || []).map(row => [row.name,row.empId,row.salary,row.absentDays,row.deductPct,row.deduction,row.net]));
for (const name of ['editWH','showWhScheduleModal','whSetGeoZone']) {
  const original = window[name];
  window[name] = id => original(id, ALL_WAREHOUSES[id]?.name || 'الفرع');
}
for (const name of ['approveEmp','rejectEmp']) {
  const original = window[name];
  window[name] = id => original(id, ALL_EMPLOYEES[id]?.name || 'الموظف');
}
// ==================== In-page dialogs (no window.alert/confirm/prompt) ====================
// Employee credentials are shown once in the shared in-page box and cleared on close.
// They are never written to the old modal, the URL (no WhatsApp text with a password), storage, or logs.
showActLinkModal = function(title, desc, username, password) {
  for (const id of ['act-link-username', 'act-link-password']) { const el = document.getElementById(id); if (el) el.textContent = ''; }
  return BasmaDialogs.credentials(title, { username, password, note: `${desc || ''} انسخ البيانات الآن وسلّمها للموظف عبر قناة خاصة. لن تظهر مرة أخرى.`.trim() });
};
clearAdminNotifs = async function() {
  if (!await BasmaDialogs.confirm('حذف الإشعارات', 'هل تريد حذف جميع الإشعارات؟', 'حذف')) return;
  try { await DB.ref(`companies/${COMPANY_ID}/notifications/admin`).remove(); adminNotifCount = 0; showToast('تم مسح الإشعارات', 'success'); }
  catch (e) { showToast('خطأ: ' + e.message, 'error'); }
};
clearEmpSchedule = async function() {
  const eid = document.getElementById('sched-emp-sel').value;
  if (!eid) return;
  if (!await BasmaDialogs.confirm('إزالة الجدول الخاص', 'هل تريد إزالة الجدول الخاص وإعادة الموظف للمواعيد الافتراضية؟', 'إزالة')) return;
  try {
    await DB.ref(`companies/${COMPANY_ID}/employees/${eid}/schedule`).remove();
    if (ALL_EMPLOYEES[eid]) delete ALL_EMPLOYEES[eid].schedule;
    for (const id of ['sched-ci-from', 'sched-ci-to', 'sched-co-from', 'sched-co-to']) document.getElementById(id).value = '';
    showToast('تم إزالة الجدول الخاص', 'info');
  } catch (e) { showToast('خطأ: ' + e.message, 'error'); }
};
editWH = async function(id, name) {
  const answer = await BasmaDialogs.form('تعديل اسم الفرع', [{ id: 'name', label: 'اسم الفرع', value: name || '' }]);
  const newName = answer?.name; if (!newName) return;
  try { await DB.ref(`companies/${COMPANY_ID}/warehouses/${id}`).update({ name: newName }); showToast('تم التعديل', 'success'); loadWarehouses(); }
  catch (e) { showToast('خطأ', 'error'); }
};
fallbackCopy = function(text) { return BasmaDialogs.notice('نسخ', 'تعذر النسخ التلقائي. اضغط مطولًا على النص لنسخه.', text); };
