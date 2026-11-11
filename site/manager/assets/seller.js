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
  const info = allCompanies[cid]?.info || {};
  const answer = await sellerForm('تعديل الخطة والصلاحية', [
    { id: 'maxEmployees', label: 'الحد الأقصى للموظفين', value: String(info.maxEmployees ?? ''), numeric: true },
    { id: 'expiry', label: 'تاريخ الصلاحية', type: 'date', value: Number.isFinite(info.expiresAt) ? new Date(info.expiresAt).toISOString().slice(0, 10) : '' },
    { id: 'plan', label: 'اسم الخطة', value: info.plan || 'manual' }
  ]);
  if (!answer) return;
  const maxEmployees = Number(answer.maxEmployees), expiresAt = new Date(answer.expiry).getTime();
  if (!Number.isInteger(maxEmployees) || maxEmployees < 1) { showToast('اكتب حدًا صحيحًا للموظفين', 'error'); return; }
  if (!Number.isFinite(expiresAt)) { showToast('اختر تاريخ صلاحية صحيحًا', 'error'); return; }
  try { await Basma.call('updatePlan', { companyId: cid, maxEmployees, expiresAt, plan: answer.plan || 'manual' }); showToast('حُفظت الخطة', 'success'); await loadAllCompanies(); openPanel(cid); }
  catch (error) { showToast(error.message, 'error'); }
}
const secureSellerPanel=openPanel;
openPanel=async function(cid){
  await secureSellerPanel(cid);
  const button=document.createElement('button');button.className='action-btn-full';button.textContent='تجديد الاشتراك';
  button.addEventListener('click',async()=>{
    const answer=await sellerForm('تجديد الاشتراك',[{id:'days',label:'عدد أيام التجديد (1 إلى 3660)',value:'30',numeric:true}]);if(!answer)return;
    const days=Number(answer.days),operationKey=`basma_shared_renew_${cid}`;
    if(!Number.isInteger(days)||days<1||days>3660){showToast('اكتب عدد أيام صحيحًا بين 1 و3660','error');return;}
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
const toLatinDigits = s => s.replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
function sellerForm(title, fields) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:#000a;z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface,#1a1a1a);border-radius:14px;padding:18px;width:100%;max-width:360px;direction:rtl;display:grid;gap:10px';
    const heading = document.createElement('h3'); heading.textContent = title; heading.style.margin = '0'; box.appendChild(heading);
    const inputs = {};
    for (const f of fields) {
      const label = document.createElement('label'); label.textContent = f.label; label.style.cssText = 'display:grid;gap:4px;font-size:14px';
      const input = document.createElement('input'); input.type = f.type || 'text'; input.value = f.value ?? ''; input.className = 'form-input';
      if (f.numeric) input.inputMode = 'numeric';
      label.appendChild(input); box.appendChild(label); inputs[f.id] = input;
    }
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px';
    const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = 'موافق'; ok.className = 'action-btn-sm btn-gold';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'إلغاء'; cancel.className = 'action-btn-sm';
    row.append(ok, cancel); box.appendChild(row); overlay.appendChild(box); document.body.appendChild(overlay);
    const done = value => { overlay.remove(); resolve(value); };
    ok.addEventListener('click', () => { const out = {}; for (const [k, el] of Object.entries(inputs)) out[k] = toLatinDigits(el.value.trim()); done(out); });
    cancel.addEventListener('click', () => done(null));
    Object.values(inputs)[0]?.focus();
  });
}
