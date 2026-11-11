'use strict';
async function secureSellerOpen(profile) {
  DB = Basma.db();
  for (const id of ['setup-screen', 'pin-screen']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
  Basma.controls(); initEmojiGrid();
  document.getElementById('trans-date').value = new Date().toISOString().slice(0, 10);
  await loadDashboard();
}
async function secureSellerLogin() {
  try { await secureSellerOpen(await Basma.login(document.getElementById('seller-email').value, document.getElementById('seller-password').value, 'seller')); document.getElementById('seller-password').value = ''; }
  catch (error) { document.getElementById('seller-error').textContent = 'تعذر الدخول. تحقق من الحساب وصلاحيات المورّد.'; }
}
window.onload = async () => {
  document.getElementById('pin-screen').style.display = 'none';
  const panel = document.getElementById('setup-screen');
  panel.innerHTML = '<div style="max-width:420px;padding:30px;direction:rtl"><h2>دخول المورّد</h2><input id="seller-email" type="email" placeholder="البريد الإلكتروني" autocomplete="username"><input id="seller-password" type="password" placeholder="كلمة المرور" autocomplete="current-password"><button id="seller-login">دخول</button><p id="seller-error"></p></div>';
  document.getElementById('seller-login').addEventListener('click', secureSellerLogin);
  try { const profile = await Basma.session('seller'); if (profile) await secureSellerOpen(profile); else panel.style.display = 'flex'; }
  catch (error) { panel.style.display = 'flex'; Basma.banner(error.message); }
};
lockSeller = resetSellerFirebase = () => Basma.logout();
changeSellerPin = () => Basma.changePassword ? Basma.changePassword() : showToast('استخدم زر تغيير كلمة المرور أسفل الصفحة', 'info');
createCompany = async function() {
  const get = id => document.getElementById(id)?.value;
  showLoading('جاري إنشاء الشركة...');
  try {
    const result = await Basma.call('createCompany', { nameAr: get('nc-name-ar'), nameEn: get('nc-name-en'), logo: get('nc-logo') || selectedEmoji, industry: get('nc-industry'), timeZone: get('nc-timezone'), plan: get('nc-plan'), maxEmployees: Number(get('nc-max-employees')), expiresAt: new Date(get('nc-expiry')).getTime(), warehouses: defaultWHs, settings: { checkIn: { from: get('nc-ci-from'), to: get('nc-ci-to') }, checkOut: { from: get('nc-co-from'), to: get('nc-co-to') } } });
    lastCreatedCID = result.companyId; lastCreatedData = { nameAr: get('nc-name-ar') };
    document.getElementById('nc-admin-username').textContent = result.username;
    document.getElementById('nc-admin-password').textContent = result.password;
    document.getElementById('nc-success').style.display = 'block';
    showToast('تم الإنشاء. بيانات الدخول تظهر مرة واحدة.', 'success');
  } catch (error) { showToast(error.message, 'error'); } finally { hideLoading(); }
};
async function secureCompanyStatus(cid, status) { await Basma.call('companyStatus', { companyId: cid, status }); await loadAllCompanies(); filterCompanies(); }
suspendCompany = cid => secureCompanyStatus(cid, 'suspended');
activateCompany = cid => secureCompanyStatus(cid, 'active');
resetManagerCredentials = doResetManagerCredentials = async function(cid) {
  if (!confirm('إعادة تعيين كلمة المرور وإلغاء جميع الجلسات القديمة؟')) return;
  try { const result = await Basma.call('resetManager', { companyId: cid }); alert(`اسم المستخدم: ${result.username}\nكلمة المرور: ${result.password}\nانسخها الآن؛ لن تُحفظ في قاعدة البيانات.`); }
  catch (error) { showToast(error.message, 'error'); }
};
confirmDeleteCompany = cid => { if (confirm('تعليق الشركة مع الاحتفاظ بالسجلات؟')) return suspendCompany(cid); };
resetAdminPin = changeSellerPin;
window.countCompanyEmployees = async function() { for (const company of Object.values(allCompanies)) company.empCount = Object.keys(company.employees || {}).length; };
refreshLiveEmployeeCounts = async () => {};
loadAllCompanies = async function() {
  allCompanies = {}; let cursor;
  do { const page = await Basma.call('listCompanies', cursor ? { cursor } : {}); Object.assign(allCompanies, page.companies); cursor = page.cursor; } while (cursor);
};
async function secureEditPlan(cid) {
  const maxEmployees = Number(prompt('الحد الأقصى للموظفين:'));
  const expiry = prompt('تاريخ الصلاحية بصيغة YYYY-MM-DD:'); if (!expiry) return;
  const plan = prompt('اسم الخطة:') || 'manual';
  await Basma.call('updatePlan', { companyId: cid, maxEmployees, expiresAt: new Date(expiry).getTime(), plan });
  await loadAllCompanies(); openPanel(cid);
}
const secureSellerPanel=openPanel;
openPanel=async function(cid){
  await secureSellerPanel(cid);
  const button=document.createElement('button');button.className='action-btn-full';button.textContent='تجديد الاشتراك';
  button.addEventListener('click',async()=>{
    const value=prompt('عدد أيام التجديد:','30');if(value==null)return;
    const days=Number(value),operationKey=`basma_shared_renew_${cid}`;
    let prior;try{prior=JSON.parse(sessionStorage.getItem(operationKey)||'null');}catch{}
    const requestId=prior?.days===days?prior.requestId:crypto.randomUUID();
    sessionStorage.setItem(operationKey,JSON.stringify({days,requestId}));button.disabled=true;
    const renew=async()=>Basma.call('renewSubscription',{companyId:cid,days,requestId});
    try{let result;try{result=await renew();}catch(error){if(!['functions/unavailable','functions/deadline-exceeded'].includes(error.code))throw error;result=await renew();}
      sessionStorage.removeItem(operationKey);
      const company=allCompanies[cid];company.expiresAt=result.expiresAt;company.info.expiresAt=result.expiresAt;
      if(company.info.status!=='suspended')company.status='active';
      showToast(`جُدد الاشتراك إلى ${new Date(result.expiresAt).toLocaleDateString('ar')}`,'success');await openPanel(cid);
    }catch(error){showToast(error.message,'error');}finally{button.disabled=false;}
  });document.getElementById('panel-content').appendChild(button);
};
