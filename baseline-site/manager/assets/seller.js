'use strict';
async function secureSellerOpen(profile) {
  DB = guardDb(Basma.db());
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
  let result;
  try {
    result = await callWithTimeout('createCompany', { nameAr: get('nc-name-ar'), nameEn: get('nc-name-en'), logo: get('nc-logo') || selectedEmoji, industry: get('nc-industry'), timeZone: get('nc-timezone'), plan: get('nc-plan'), maxEmployees: Number(get('nc-max-employees')), expiresAt: new Date(get('nc-expiry')).getTime(), warehouses: defaultWHs, settings: { checkIn: { from: get('nc-ci-from'), to: get('nc-ci-to') }, checkOut: { from: get('nc-co-from'), to: get('nc-co-to') } } }, 60000);
    lastCreatedCID = result.companyId; lastCreatedData = { nameAr: get('nc-name-ar') };
  } catch (error) { diagNote('createCompany', error); showToast(friendlyError(error), 'error'); return; }
  finally { hideLoading(); }
  for (const id of ['nc-admin-username', 'nc-admin-password']) { const el = document.getElementById(id); if (el) el.textContent = SELLER_CREDENTIALS_SHOWN; }
  const card = document.getElementById('nc-success'); if (card) card.style.display = 'block';
  showToast('تم إنشاء الشركة. بيانات الدخول تظهر مرة واحدة فقط.', 'success');
  await sellerShowCredentials('بيانات دخول مدير الشركة الجديدة', result.username, result.password);
};
async function secureCompanyStatus(cid, status) {
  showLoading(status === 'suspended' ? 'جاري تعليق الشركة...' : 'جاري تفعيل الشركة...');
  try {
    await callWithTimeout('companyStatus', { companyId: cid, status });
    showToast(status === 'suspended' ? 'عُلّقت الشركة' : 'فُعّلت الشركة', 'success');
    await loadAllCompanies(); filterCompanies();
  } catch (error) { diagNote('companyStatus', error); showToast(friendlyError(error), 'error'); }
  finally { hideLoading(); }
}
suspendCompany = cid => secureCompanyStatus(cid, 'suspended');
activateCompany = cid => secureCompanyStatus(cid, 'active');
resetManagerCredentials = doResetManagerCredentials = async function(cid) {
  const ok = await sellerConfirm('إعادة تعيين بيانات المدير', 'ستُنشأ كلمة مرور جديدة للمدير وتُلغى جميع جلساته القديمة. هل تريد المتابعة؟', 'إعادة التعيين');
  if (!ok) return;
  showLoading('جاري إعادة التعيين...');
  let result;
  try { result = await callWithTimeout('resetManager', { companyId: cid }); }
  catch (error) { diagNote('resetManager', error); showToast(friendlyError(error), 'error'); return; }
  finally { hideLoading(); }
  await sellerShowCredentials('بيانات دخول المدير الجديدة', result.username, result.password);
};
confirmDeleteCompany = async cid => { if (await sellerConfirm('تعليق الشركة', 'ستُعلَّق الشركة مع الاحتفاظ بجميع سجلاتها. هل تريد المتابعة؟', 'تعليق')) return suspendCompany(cid); };
resetAdminPin = changeSellerPin;
window.countCompanyEmployees = async function() { for (const company of Object.values(allCompanies)) company.empCount = Object.keys(company.employees || {}).length; };
refreshLiveEmployeeCounts = async () => {};
loadAllCompanies = async function() {
  const next = {}; let cursor;
  do { const page = await callWithTimeout('listCompanies', cursor ? { cursor } : {}); Object.assign(next, page.companies); cursor = page.cursor; } while (cursor);
  allCompanies = next;
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
  showLoading('جاري حفظ الخطة...');
  try { await callWithTimeout('updatePlan', { companyId: cid, maxEmployees, expiresAt, plan: answer.plan || 'manual' }); showToast('حُفظت الخطة', 'success'); await loadAllCompanies(); hideLoading(); await openPanel(cid); }
  catch (error) { diagNote('updatePlan', error); showToast(friendlyError(error), 'error'); }
  finally { hideLoading(); }
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
    const requestId=prior?.days===days&&prior.requestId?prior.requestId:newRequestId();
    try{sessionStorage.setItem(operationKey,JSON.stringify({days,requestId}));}catch{}
    button.disabled=true;showLoading('جاري تجديد الاشتراك...');
    const renew=async()=>callWithTimeout('renewSubscription',{companyId:cid,days,requestId});
    try{let result;try{result=await renew();}catch(error){if(!['functions/unavailable','functions/deadline-exceeded'].includes(error.code))throw error;result=await renew();}
      try{sessionStorage.removeItem(operationKey);}catch{}
      const company=allCompanies[cid];
      if(company){company.expiresAt=result.expiresAt;if(company.info)company.info.expiresAt=result.expiresAt;if(company.info?.status!=='suspended')company.status='active';}
      hideLoading();
      showToast(`جُدد الاشتراك إلى ${new Date(result.expiresAt).toLocaleDateString('ar')}`,'success');await openPanel(cid);
    }catch(error){diagNote('renewSubscription',error);showToast(friendlyError(error),'error');}finally{hideLoading();button.disabled=false;}
  });document.getElementById('panel-content').appendChild(button);
};
// ==================== v5.2.1 seller reliability helpers ====================
// Every server call and every direct read has a time limit, so a blocked network,
// App Check or browser can never leave the page waiting silently.
window.BASMA_SELLER_BUILD = 'v5.2.1-seller-r3';
function sellerTimeoutMs() { return Number(window.BASMA_SELLER_TIMEOUT_MS) || 25000; }
function sellerDbTimeoutMs() { return Number(window.BASMA_SELLER_DB_TIMEOUT_MS) || 15000; }
function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'basma/timeout', label, seconds: Math.round(ms / 1000) })), ms); });
  return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
}
function callWithTimeout(name, data = {}, ms = sellerTimeoutMs()) { return withTimeout(Basma.call(name, data), ms, name); }
function guardDb(db) {
  return { ref: location => {
    const ref = db.ref(location);
    return {
      once: (...args) => withTimeout(ref.once(...args), sellerDbTimeoutMs(), 'db:' + location),
      push: value => withTimeout(ref.push(value), sellerDbTimeoutMs(), 'db:' + location),
      update: value => withTimeout(ref.update(value), sellerDbTimeoutMs(), 'db:' + location)
    };
  } };
}
function newRequestId() {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}
function friendlyError(error) {
  if (error?.code === 'basma/timeout') return `لم يرد الخادم خلال ${error.seconds} ثانية. تحقق من الاتصال، أو افتح صفحة التشخيص: /manager/diagnostics.html`;
  if (error?.code === 'functions/unauthenticated') return 'انتهت الجلسة أو تعذر التحقق من التطبيق. سجّل الدخول من جديد، أو افتح صفحة التشخيص.';
  if (error?.code === 'functions/permission-denied') return error.message || 'لا تملك صلاحية هذه العملية.';
  return error?.message || 'تعذر تنفيذ العملية';
}
// A small local log for /manager/diagnostics.html: operation name, error code and time only. Never data or credentials.
function diagNote(operation, error) {
  try {
    const key = 'basma_diag_events', list = JSON.parse(localStorage.getItem(key) || '[]');
    list.push({ at: new Date().toISOString(), page: 'seller', operation, code: String(error?.code || 'error'), message: String(error?.code === 'basma/timeout' ? 'timeout' : (error?.message || '')).slice(0, 160) });
    localStorage.setItem(key, JSON.stringify(list.slice(-30)));
  } catch {}
}
function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = String(value); }

// ==================== DASHBOARD (server list first, slow extras later) ====================
loadDashboard = async function() {
  showLoading('جاري التحميل...');
  try { await loadAllCompanies(); }
  catch (error) { hideLoading(); diagNote('dashboard', error); showToast(friendlyError(error), 'error'); return; }
  const companies = Object.values(allCompanies);
  setText('ds-active', companies.filter(c => c.status === 'active').length);
  setText('ds-expired', companies.filter(c => c.status === 'expired').length);
  setText('ds-emps', companies.reduce((sum, c) => sum + (Number(c.empCount) || 0), 0));
  renderDashAlerts(companies);
  renderDashMini(companies);
  hideLoading();
  setText('ds-mrr', '…');
  try {
    const snap = await DB.ref('seller/transactions').once('value');
    const now = new Date(), startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let mrr = 0;
    snap.forEach(c => { const t = c.val() || {}; if ((t.date || 0) >= startOfMonth || new Date(t.dateStr || '').getTime() >= startOfMonth) mrr += Number(t.amount) || 0; });
    setText('ds-mrr', '$' + mrr);
  } catch (error) { setText('ds-mrr', '—'); diagNote('revenue', error); }
};
if (typeof pageLoaders === 'object' && pageLoaders) pageLoaders.dash = () => loadDashboard();
function sellerCompanyName(c) { return c?.info?.nameAr || 'شركة'; }
function renderDashAlerts(companies) {
  const box = document.getElementById('dash-alerts'); if (!box) return;
  box.replaceChildren();
  const add = (kind, icon, title, sub) => {
    const card = document.createElement('div'); card.className = 'alert-card ' + kind;
    const i = document.createElement('div'); i.className = 'alert-icon'; i.textContent = icon;
    const body = document.createElement('div'); body.className = 'alert-body';
    const t = document.createElement('div'); t.className = 'alert-title'; t.textContent = title;
    const s = document.createElement('div'); s.className = 'alert-sub'; s.textContent = sub;
    body.append(t, s); card.append(i, body); box.appendChild(card);
  };
  const soon = Date.now() + 7 * 86400000;
  for (const c of companies) {
    const expiry = Number(c.expiresAt) || 0;
    if (c.status === 'active' && expiry && expiry < soon) add('expiry', '⏰', `${sellerCompanyName(c)} — اشتراك ينتهي خلال ${Math.ceil((expiry - Date.now()) / 86400000)} يوم`, new Date(expiry).toLocaleDateString('ar-SA'));
    if (c.status === 'expired') add('expiry', '⌛', `${sellerCompanyName(c)} — انتهى الاشتراك`, 'افتح الشركة واضغط «تجديد الاشتراك» أسفل اللوحة');
    if (c.status === 'suspended') add('suspended', '⛔', `${sellerCompanyName(c)} — معلّقة`, 'بحاجة لمراجعة');
  }
  if (!box.children.length) { const ok = document.createElement('div'); ok.style.cssText = 'color:var(--green);font-size:14px;padding:10px'; ok.textContent = '✅ لا توجد تنبيهات'; box.appendChild(ok); }
}
function renderDashMini(companies) {
  const mini = document.getElementById('dash-companies-mini'); if (!mini) return;
  mini.replaceChildren();
  for (const c of companies.slice(0, 8)) {
    const row = document.createElement('div');
    row.style.cssText = 'background:var(--surface);border-radius:12px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;border:1px solid var(--border)';
    const left = document.createElement('div'); left.style.cssText = 'display:flex;align-items:center;gap:10px';
    const logo = document.createElement('span'); logo.style.fontSize = '24px'; logo.textContent = c.info?.logo || '🏢';
    const text = document.createElement('div');
    const name = document.createElement('div'); name.style.cssText = 'font-size:14px;font-weight:700'; name.textContent = sellerCompanyName(c);
    const plan = document.createElement('div'); plan.style.cssText = 'font-size:11px;color:var(--text2)'; plan.textContent = `${c.info?.plan || 'manual'} | حد ${c.info?.maxEmployees ?? '-'} موظف`;
    text.append(name, plan); left.append(logo, text);
    const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:8px;align-items:center';
    const count = document.createElement('span'); count.style.cssText = 'font-size:12px;color:var(--gold)'; count.textContent = `${Number(c.empCount) || 0} موظف`;
    const badge = document.createElement('span');
    badge.className = 'badge ' + (c.status === 'active' ? 'badge-green' : c.status === 'suspended' ? 'badge-red' : 'badge-gray');
    badge.textContent = c.status === 'active' ? 'نشطة' : c.status === 'suspended' ? 'معلّقة' : 'منتهية';
    right.append(count, badge); row.append(left, right); mini.appendChild(row);
  }
}

// ==================== IN-PAGE BOXES (shared: /manager/assets/dialogs.js) ====================
function sellerForm(title, fields) { return BasmaDialogs.form(title, fields); }
function sellerConfirm(title, message, okLabel = 'متابعة') { return BasmaDialogs.confirm(title, message, okLabel); }
function sellerShowCredentials(title, username, password) { return BasmaDialogs.credentials(title, { username, password }); }

// New-company success card: the manager's login is shown once, only inside the in-page box.
// The card on the page and the WhatsApp message never contain the username or password.
const SELLER_CREDENTIALS_SHOWN = 'عُرضت مرة واحدة في المربع وأُغلقت';
shareWhatsapp = function() {
  const name = lastCreatedData?.nameAr || 'الشركة';
  const msg = `🎉 مرحباً!\n\nتم تفعيل نظام الحضور الذكي لشركة *${name}*\n\n📲 حمّل تطبيق "المدير" من متجر التطبيقات.\n🔐 سأرسل لك اسم المستخدم والرقم السري بشكل منفصل وآمن.`;
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
};
