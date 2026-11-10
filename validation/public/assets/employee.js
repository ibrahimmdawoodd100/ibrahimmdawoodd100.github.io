'use strict';
async function secureEmployeeOpen(profile) {
  COMPANY_ID = profile.companyId; DB = Basma.db(); ACTIVATION_UID = profile.employeeId;
  const home=await Basma.call('employeeHome');
  const employee=home.employee;
  if(!employee||!['approved','pending_activation'].includes(employee.status))throw new Error('حساب الموظف غير مفعّل');
  secureAttendanceWindows.seed(home);
  CRED_ID=employee.credId||null;
  Basma.controls();
  if (employee.status === 'approved' && employee.credId) { await setupMainScreen(); }
  else {
    for (const [id, value] of [['act-emp-name', employee.name], ['act-emp-id', employee.empId], ['act-emp-role', employee.role], ['act-emp-wh', employee.warehouseName]]) document.getElementById(id).textContent = value || '';
    showScreen('s-activate');
  }
  DB.ref(`companies/${COMPANY_ID}/info/status`).on('value', snap => { if (snap.val() !== 'active') Basma.logout(); }, () => Basma.logout());
}
initFirebase = async function() {
  try { const profile = await Basma.session('employee'); if (profile) await secureEmployeeOpen(profile); else showScreen('s-dirlogin'); }
  catch (error) { showScreen('s-dirlogin'); Basma.banner(error.message); }
};
directoryEmployeeLogin = async function() {
  const button = document.getElementById('dl-emp-submit'); button.disabled = true;
  try { await secureEmployeeOpen(await Basma.login(document.getElementById('dl-emp-username').value, document.getElementById('dl-emp-password').value, 'employee')); document.getElementById('dl-emp-password').value = ''; }
  catch (error) { const node = document.getElementById('dl-emp-error'); node.textContent = 'تعذر الدخول. تحقق من بيانات الحساب وحالة الشركة.'; node.style.display = 'block'; }
  finally { button.disabled = false; }
};
activateBio = async function() {
  const node = document.getElementById('act-bio-status'); node.textContent = 'جاري تسجيل البصمة...';
  try { const result = await Basma.biometric('register'); CRED_ID = result.credentialId; await secureEmployeeOpen(Basma.profile); }
  catch (error) { node.textContent = error.message || 'تعذر تسجيل البصمة'; }
};
verifyBio = async () => Basma.biometric('authenticate', 'login');
async function secureRecord(type, missionKey) {
  showLoading('جاري التحقق والتسجيل...');
  try { await Basma.attendance(type, GPS_DATA, missionKey); showToast('تم التسجيل بتوقيت الخادم', 'success'); await loadTodayStats(); if (missionKey) { loadMissionsPage(); checkActiveMissions(); } }
  catch (error) { if(error.details?.reason==='attendance-window'){let synced=false;try{await secureAttendanceWindows.sync();synced=true;}catch{}showToast(synced?'التسجيل خارج النافذة حسب وقت الخادم. أُعيدت مزامنة الوقت؛ حاول داخل النافذة المعروضة.':'التسجيل خارج النافذة حسب الخادم؛ تعذرت إعادة المزامنة. تحقق من الاتصال وحاول مجددًا.','error');}else showToast(error.message || 'تعذر التحقق', 'error'); }
  finally { secureAttendanceWindows.evaluate();hideLoading(); }
}
recBio = type => secureRecord(type);
startMission = id => secureRecord('mission_start', id);
endMission = id => secureRecord('mission_end', id);
recPartialLeave = type => secureRecord(type);
doLogout = () => Basma.logout();
const accountRegistrationDisabled = () => showToast('إنشاء الحساب واستبدال البصمة يتمان بواسطة مدير الشركة.', 'error');
registerBio = submitRegistration = recoverBio = doReBioReg = searchByEmpId = handleActivation = accountRegistrationDisabled;
restoreSession = () => secureEmployeeOpen(Basma.profile);
loadWarehouses = () => showScreen('s-dirlogin');
submitLeave = async function() {
  const get = id => document.getElementById(id)?.value;
  try { await Basma.call('submitRequest', { kind: 'leave', date: get('leave-date'), reason: get('leave-reason'), leaveType: get('leave-type'), fromTime: get('leave-from-time'), toTime: get('leave-to-time') }); showToast('تم إرسال الطلب', 'success'); loadLeavePage(); }
  catch (error) { showToast(error.message, 'error'); }
};
submitExcuse = async function() {
  try { await Basma.call('submitRequest', { kind: 'excuse', reason: document.getElementById('excuse-reason').value, type: document.querySelector('input[name="excuse-type"]:checked')?.value }); showToast('تم إرسال الطلب', 'success'); loadExcusePage(); }
  catch (error) { showToast(error.message, 'error'); }
};
window.onload = () => initFirebase();
