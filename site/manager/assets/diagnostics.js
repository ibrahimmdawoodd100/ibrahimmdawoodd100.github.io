'use strict';
// Basma diagnostics: one line per step with result and elapsed time.
// Never prints passwords, tokens, the App Check site key, or full account identifiers.
window.BasmaDiagnostics = (() => {
  const ROLES = ['seller', 'manager', 'employee'];
  const STEP_MS = 10000;
  const activated = new Set();
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  function withTimeout(promise, ms) {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'diag/timeout' })), ms); });
    return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
  }
  const mask = id => (typeof id === 'string' && id.length > 4 ? id.slice(0, 4) + '…' : '…');
  const describe = e => String(e?.code || 'error') + (e?.code === 'diag/timeout' ? '' : (e?.message ? ': ' + String(e.message).slice(0, 120) : ''));

  async function run({ firebase, config, document, storage, region } = {}) {
    const results = [];
    const list = document.getElementById('diag-lines');
    const summary = document.getElementById('diag-summary');
    list.replaceChildren(); if (summary) summary.textContent = 'جاري الفحص...';
    const add = (step, status, ms, detail) => {
      const row = { step, status, ms: Math.round(ms), detail: detail || '' };
      results.push(row);
      const li = document.createElement('li');
      li.className = { OK: 'ok', WARN: 'warn', SKIP: 'skip' }[status] || 'fail';
      const icon = { OK: '✅', WARN: '⚠️', SKIP: '⏭️' }[status] || '❌';
      li.textContent = `${icon} ${step} — ${status}${row.detail ? ' — ' + row.detail : ''} `;
      const t = document.createElement('span'); t.className = 'ms'; t.textContent = `(${row.ms} ms)`; li.appendChild(t);
      list.appendChild(li);
      return row;
    };
    const step = async (name, fn, ms = STEP_MS) => {
      const t0 = now();
      try { const r = await withTimeout(fn(), ms); return add(name, r?.status || 'OK', now() - t0, r?.detail); }
      catch (e) { return add(name, e?.code === 'diag/timeout' ? 'TIMEOUT' : 'FAIL', now() - t0, e?.code === 'diag/timeout' ? `لا رد خلال ${Math.round(ms / 1000)} ثانية` : describe(e)); }
    };

    if (!firebase?.initializeApp || !config?.firebase) {
      add('تحميل مكتبات Firebase', 'FAIL', 0, 'المكتبات أو الإعدادات لم تُحمَّل (قد يكون المتصفح أو مانع الإعلانات يحجبها)');
      if (summary) summary.textContent = 'تعذر بدء الفحص.';
      return results;
    }
    add('تحميل مكتبات Firebase', 'OK', 0, 'المكتبات والإعدادات موجودة');

    // 1. Auth state: the same app names the Basma pages use, so their saved session is visible here.
    let app = null, user = null, role = null;
    await step('حالة تسجيل الدخول', async () => {
      const found = [];
      for (const r of ROLES) {
        const name = `secure-${r}`;
        const a = firebase.apps.find(x => x.name === name) || firebase.initializeApp(config.firebase, name);
        const u = await withTimeout(new Promise(resolve => { const stop = a.auth().onAuthStateChanged(x => { stop(); resolve(x); }); }), STEP_MS);
        if (u && !user) { app = a; user = u; role = r; }
        if (u) found.push(`${r} (${mask(u.uid)})`);
      }
      if (!app) app = firebase.apps.find(x => x.name === 'secure-seller');
      return found.length ? { detail: 'مسجّل: ' + found.join('، ') } : { status: 'WARN', detail: 'لا يوجد حساب مسجّل في هذا المتصفح. سجّل الدخول في لوحة المورّد ثم افتح هذه الصفحة.' };
    });

    if (!app) app = firebase.apps.find(x => x.name === 'secure-seller') || firebase.initializeApp(config.firebase, 'secure-seller');
    // 2. App Check token: only whether it exists. The token and the site key are never printed.
    await step('رمز App Check', async () => {
      if (!config.appCheckSiteKey) throw Object.assign(new Error('appCheckSiteKey missing'), { code: 'config/missing' });
      if (!activated.has(app.name)) { app.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(config.appCheckSiteKey), true); activated.add(app.name); }
      const result = await app.appCheck().getToken(false);
      if (!result?.token) throw Object.assign(new Error('no token'), { code: 'appcheck/empty' });
      return { detail: 'الرمز موجود (لا يُعرض)' };
    });

    const callable = name => app.functions(region).httpsCallable(name, { limitedUseAppCheckTokens: false });
    // 3. profile callable.
    await step('الدالة profile', async () => {
      if (!user) return { status: 'SKIP', detail: 'يحتاج تسجيل الدخول' };
      const p = (await callable('profile')({})).data || {};
      return { detail: `الدور: ${p.role || '؟'}` };
    }, 20000);
    // 4. listCompanies callable (seller accounts only).
    await step('الدالة listCompanies', async () => {
      if (!user) return { status: 'SKIP', detail: 'يحتاج تسجيل دخول المورّد' };
      if (role !== 'seller') return { status: 'SKIP', detail: 'متاحة لحساب المورّد فقط' };
      const page = (await callable('listCompanies')({})).data || {};
      return { detail: `عدد الشركات في الصفحة الأولى: ${Object.keys(page.companies || {}).length}` };
    }, 20000);

    // 5. One small database read (10 s). A permission refusal still proves the server answered.
    const db = app.database();
    await step('قراءة صغيرة من قاعدة البيانات', async () => {
      const path = user ? `access/${user.uid}/enabled` : '.info/serverTimeOffset';
      try { await db.ref(path).once('value'); return { detail: 'وصلت القراءة' }; }
      catch (e) {
        if (/permission/i.test(String(e?.code || e?.message))) return { status: 'WARN', detail: 'الخادم ردّ برفض الصلاحية (الاتصال يعمل)' };
        throw e;
      }
    }, 10000);
    // 6. Realtime connection state.
    await step('حالة اتصال قاعدة البيانات', () => new Promise(resolve => {
      const ref = db.ref('.info/connected');
      const handler = ref.on('value', snap => { if (snap.val() === true) { ref.off('value', handler); resolve({ detail: 'متصل' }); } });
    }), 10000);

    // 7. Recent errors recorded by the seller page (operation, code, time only).
    try {
      const events = JSON.parse(storage?.getItem('basma_diag_events') || '[]').slice(-5);
      add('آخر أخطاء لوحة المورّد', events.length ? 'WARN' : 'OK', 0, events.length ? events.map(e => `${e.at?.slice(11, 19) || ''} ${e.operation}: ${e.code}`).join(' | ') : 'لا توجد أخطاء مسجلة');
    } catch { add('آخر أخطاء لوحة المورّد', 'SKIP', 0, 'التخزين المحلي غير متاح'); }

    const bad = results.filter(r => r.status === 'FAIL' || r.status === 'TIMEOUT').length;
    if (summary) summary.textContent = bad ? `انتهى الفحص: ${bad} خطوة فشلت. انسخ النتيجة وأرسلها.` : 'انتهى الفحص: لا توجد أخطاء.';
    return results;
  }
  function reportText(results) { return results.map(r => `${r.status}\t${r.ms}ms\t${r.step}\t${r.detail}`).join('\n'); }
  return Object.freeze({ run, reportText, withTimeout, mask });
})();

if (typeof document !== 'undefined' && document.getElementById?.('diag-lines')) {
  let last = [];
  const start = () => window.BasmaDiagnostics.run({ firebase: window.firebase, config: window.BASMA_CONFIG, document, storage: (() => { try { return localStorage; } catch { return null; } })(), region: window.BASMA_CONFIG?.region }).then(r => { last = r; });
  document.getElementById('diag-run').addEventListener('click', start);
  document.getElementById('diag-copy').addEventListener('click', async () => {
    const text = `Basma diagnostics ${new Date().toISOString()}\n${navigator.userAgent}\n` + window.BasmaDiagnostics.reportText(last);
    try { await navigator.clipboard.writeText(text); document.getElementById('diag-summary').textContent = 'نُسخت النتيجة.'; }
    catch { document.getElementById('diag-summary').textContent = 'تعذر النسخ التلقائي. خذ لقطة شاشة بدلًا من ذلك.'; }
  });
  start();
}
