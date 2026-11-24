'use strict';
// v6.1 (owner, 25 Nov 2026): every value Basma keeps in this browser has a name starting with "basma" (shared site).
// Small page preferences live under "basma.<name>" (kept across logout). Old unprefixed values move over once.
function basmaPref(name) {
  try { const key = `basma.${name}`, value = localStorage.getItem(key); if (value !== null) return value;
    const old = localStorage.getItem(name); if (old !== null) { localStorage.setItem(key, old); localStorage.removeItem(name); } return old; } catch { return null; }
}
function basmaPrefSet(name, value) { try { localStorage.setItem(`basma.${name}`, value); localStorage.removeItem(name); } catch {} }
function basmaPrefDel(name) { try { localStorage.removeItem(`basma.${name}`); localStorage.removeItem(name); } catch {} }
window.Basma = (() => {
  let app, profile, ready, selectedRole, persistenceMode;
  function init(role) {
    if (ready && role && role !== selectedRole) throw new Error('استخدم صفحة الحساب المناسبة');
    if (ready) return ready;
    if (!['employee','manager','seller'].includes(role)) throw new Error('يجب تحديد نوع الحساب قبل الاتصال');
    selectedRole = role;
    // App-shell cache for the manager and employee pages ONLY. Never the seller page (site root): a root
    // service worker would control every app on this shared site, including Golden Cart.
    if ((role === 'manager' || role === 'employee') && typeof navigator === 'object' && navigator.serviceWorker?.register) {
      navigator.serviceWorker.register(`/${role}/sw.js`, { scope: `/${role}/` }).catch(() => {});
    }
    ready = (async () => {
      const config = window.BASMA_CONFIG;
      if (!config || JSON.stringify(config).includes('REPLACE_ME')) throw new Error('يلزم إكمال إعدادات النشر في ملف config.js');
      const appName = `secure-${selectedRole}`;
      app = firebase.apps.find(x => x.name === appName) || firebase.initializeApp(config.firebase, appName);
      // E2E only: the local test server's config.js adds {emulators:{host,auth,database,functions}}. The published
      // config.js never has it, and it is ignored unless the page itself is served from localhost/127.0.0.1.
      const emu = config.emulators;
      if (emu && typeof emu === 'object' && /^(localhost|127\.0\.0\.1)$/.test(window.location?.hostname || '')) {
        app.auth().useEmulator(`http://${emu.host}:${emu.auth}`, { disableWarnings: true });
        app.database().useEmulator(emu.host, emu.database);
        app.functions(config.region).useEmulator(emu.host, emu.functions);
      }
      // v5.16 cost: no background auto-refresh. Each App Check refresh is a paid reCAPTCHA assessment; the SDK still
      // fetches a fresh token on demand when a call needs one and the old one has expired (no security change).
      app.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(config.appCheckSiteKey), false);
      // LOCAL for every role (owner's choice): the session survives closing and reopening the app. Explicit «خروج»
      // still signs out; sensitive actions stay protected server-side (changePassword needs a sign-in < 5 min old).
      persistenceMode = 'LOCAL';
      try { await app.auth().setPersistence(firebase.auth.Auth.Persistence[persistenceMode]); }
      catch (error) {
        if (persistenceMode !== 'LOCAL') throw error;
        await app.auth().setPersistence(firebase.auth.Auth.Persistence.SESSION);
        persistenceMode = 'SESSION';
        banner('تعذر حفظ الجلسة على هذا الجهاز؛ ستنتهي عند إغلاق التبويب. اسمح بتخزين الموقع لتفعيل الدخول الدائم.');
      }
      await new Promise(resolve => { const stop = app.auth().onAuthStateChanged(() => { stop(); resolve(); }); });
      return app;
    })();
    return ready;
  }
  async function call(name, data = {}) {
    await init();
    try { const result=(await app.functions(window.BASMA_CONFIG.region).httpsCallable(name, { limitedUseAppCheckTokens: false })(data)).data;
      if(selectedRole==='manager'&&!['profile','serverClock','managerHome','managerRecords','managerList'].includes(name))window.dispatchEvent?.(new CustomEvent('basma-manager-mutated'));
      return result; }
    finally { if(name==='recordAttendance') window.dispatchEvent?.(new CustomEvent('basma-attendance-settled')); }
  }
  const HOME_CALL = { employee: 'employeeHome', manager: 'managerHome' };
  let pendingHome = null;
  // The home data fetched while opening the session, handed to the page ONCE (no second call).
  function takeHome(name) { const value = pendingHome?.name === name ? pendingHome.value : null; pendingHome = null; return value; }
  // Warm-up: start the given functions' instances in the background (server answers {warm:true} after its checks).
  // Not through call(): no page events, no retries; failures are only recorded as step timings.
  function warm(names) {
    if (!app || !app.auth().currentUser) return;
    for (const name of names) {
      const t0 = clock();
      app.functions(window.BASMA_CONFIG.region).httpsCallable(name, { limitedUseAppCheckTokens: false })({ warm: true })
        .then(() => trace(`تسخين ${name}`, t0), error => trace(`تسخين ${name}`, t0, false, error?.code || 'error'));
    }
  }
  async function session(role) {
    await init(role);
    if (!app.auth().currentUser) return null;
    rememberUser(app.auth().currentUser.uid);
    try {
      traceStart(`فتح صفحة ${role}`);
      // App Check token and the forced ID-token refresh (fresh claims) are independent: run them in parallel.
      const t0 = clock();
      await Promise.all([
        Promise.resolve(app.appCheck().getToken?.(false)).then(() => trace('رمز App Check', t0), error => trace('رمز App Check', t0, false, error?.code || 'error')),
        app.auth().currentUser.getIdToken(true).then(() => trace('تجديد رمز الدخول', t0))
      ]);
      // Employee and manager pages open with their home call, which also carries the profile fields:
      // ONE server call (one cold start) instead of profile + home.
      const homeName = HOME_CALL[role], t1 = clock();
      let candidate;
      try {
        const openHome = () => timeout(call(homeName), Number(window.BASMA_HOME_TIMEOUT_MS) || 25000, homeName);
        if (homeName) {
          let home;
          try { home = await openHome(); }
          catch (error) { if (role !== 'manager' || error?.details?.reason !== 'consent-required') throw error; if (!(await consentGate())) return null; home = await openHome(); }
          pendingHome = { name: homeName, value: home }; candidate = { ...home.profile, serverTime: home.serverTime };
        }
        else candidate = await call('profile');
        trace(`الدالة ${homeName || 'profile'} (فتح الصفحة)`, t1);
      } catch (error) { trace(`الدالة ${homeName || 'profile'} (فتح الصفحة)`, t1, false, error?.code || 'error'); throw error; }
      if (candidate.role !== role) throw Object.assign(new Error('هذا الحساب غير مخوّل لهذه الواجهة'), { code:'functions/permission-denied' });
      profile = {...candidate,clockOffset:Number.isFinite(candidate.serverTime)?candidate.serverTime-Date.now():0};
      return profile;
    } catch (error) {
      profile = null;
      // Sign out only when the account itself is refused or its token is invalid. NOT on 'functions/unauthenticated':
      // a callable also returns it when the App Check token is briefly unavailable (e.g. right after reopening),
      // which used to throw the user out of a valid session.
      if (['functions/permission-denied','auth/user-token-expired','auth/invalid-user-token','auth/user-disabled'].includes(error.code)) await app.auth().signOut();
      throw error;
    }
  }
  // v6.1 (owner, 25 Nov 2026): one-time written consent before a manager can use the app. The server stores who/when
  // and refuses company data until then. Refusing signs out.
  async function consentGate() {
    const status = await call('managerList', { kind: 'consentStatus' });
    if (status.accepted) return true;
    const message = `${status.text}\n\nلا يمكن استخدام البرنامج قبل الموافقة. «إلغاء» يسجّل خروجك.`;
    const ok = window.BasmaDialogs ? await window.BasmaDialogs.confirm('موافقة على حفظ البيانات', message, 'أوافق', 'btn-gold') : false;
    if (!ok) { await logout(); return false; }
    await call('managerList', { kind: 'consentAccept', version: status.version });
    return true;
  }
  async function login(username, password, role) {
    await init(role);
    const email = username.includes('@') ? username.trim() : `${username.trim()}@basma.app`;
    const signed = await app.auth().signInWithEmailAndPassword(email, password);
    rememberUser(signed.user.uid);
    return session(role);
  }
  async function logout() {
    window.dispatchEvent?.(new CustomEvent('basma-session-ended'));
    if (app) { app.database().goOffline(); await app.auth().signOut(); }
    clearLocalState();
    location.reload();
  }
  // v5.15: every Basma value this browser keeps for a user (session hints, step timings, cached flags) is removed on
  // logout AND when a different account signs in on the same phone, so employee B never sees employee A's state.
  // Firebase's own sign-in record is removed by signOut(); page memory is cleared by the reload.
  function clearLocalState(keep = []) {
    try { indexedDB.deleteDatabase('basma-month-cache'); } catch {} // the manager's closed-month cache
    // v6.0: the company's records on this phone are KEPT (the only copy after 45 days); only the decryption key is removed,
    // so nobody can read them until the manager signs in again. Never delete basma-local-v1 here.
    try { if (indexedDB.databases) indexedDB.databases().then(list => { if (!list.some(x => x.name === 'basma-local-v1')) return; const r = indexedDB.open('basma-local-v1'); r.onsuccess = () => { const db = r.result; try { if (db.objectStoreNames.contains('keys')) db.transaction('keys', 'readwrite').objectStore('keys').clear(); } catch {} db.close(); }; }).catch(() => {}); } catch {}
    for (const storage of [localStorage, sessionStorage]) {
      try { for (const key of Object.keys(storage)) if (/^basma_/.test(key) && !keep.includes(key)) storage.removeItem(key); } catch {}
    }
  }
  function rememberUser(uid) {
    let last = null; try { last = localStorage.getItem('basma_last_uid'); } catch {}
    if (last && last !== uid) clearLocalState();
    try { localStorage.setItem('basma_last_uid', uid); } catch {}
  }
  // ---- Step timings for /manager/diagnostics.html: step name, ms, ok/code only. Never data or credentials. ----
  const TRACE_KEY = 'basma_diag_trace';
  const clock = () => (typeof performance === 'object' ? performance.now() : Date.now());
  function trace(step, startedAt, ok = true, code = '') {
    try {
      const list = JSON.parse(localStorage.getItem(TRACE_KEY) || '[]');
      list.push({ at: new Date().toISOString(), page: selectedRole || '', step: String(step).slice(0, 60), ms: Math.round(clock() - startedAt), ok: !!ok, code: String(code || '').slice(0, 60) });
      localStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(-40)));
    } catch {}
  }
  function traceStart(label) { try { const list = JSON.parse(localStorage.getItem(TRACE_KEY) || '[]'); list.push({ at: new Date().toISOString(), page: selectedRole || '', step: `— ${label} —`, ms: 0, ok: true, code: '' }); localStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(-40))); } catch {} }
  // A promise with a visible limit: rejects with code basma/timeout and a plain Arabic message.
  function timeout(promise, ms, label) {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`لم يرد الخادم خلال ${Math.round(ms / 1000)} ثانية. تحقق من الإنترنت ثم اضغط «إعادة المحاولة».`), { code: 'basma/timeout', label })), ms); });
    return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
  }
  // ---- Database connection watchdog ----
  // Long polling is NOT used: the SDK's long-polling transport loads <script> tags and an iframe from
  // *.firebaseio.com, which this site's CSP (script-src/frame-src) blocks on purpose. Forcing it (v5.7–v5.10) turned
  // a slow first WebSocket into a tab that could never reach the database. Now: if '.info/connected' is not true
  // within CONNECT_MS, try ONE fresh WebSocket (goOffline/goOnline). Page data comes from server calls anyway.
  const CONNECT_MS = 5000, POLL_KEY = 'basma_db_long_polling';
  const connection = { state: 'idle', transport: 'websocket', since: 0 };
  let watched = false;
  function watchConnection(database) {
    if (watched) return; watched = true;
    const t0 = clock(); connection.state = 'connecting'; connection.since = Date.now();
    try { sessionStorage.removeItem(POLL_KEY); } catch {}
    let done = false;
    const ref = database.ref('.info/connected');
    const handler = ref.on('value', snap => {
      if (snap.val() !== true || done) return;
      done = true; connection.state = 'connected'; trace(`اتصال قاعدة البيانات (${connection.transport})`, t0, true);
    });
    setTimeout(() => {
      if (done) return;
      trace('اتصال قاعدة البيانات (websocket) لم يكتمل', t0, false, 'db/connect-timeout');
      connection.state = 'reconnecting';
      try { database.goOffline(); database.goOnline(); } catch {}
      setTimeout(() => { if (!done) { connection.state = 'stalled'; trace('اتصال قاعدة البيانات (websocket، محاولة ثانية) لم يكتمل', t0, false, 'db/connect-timeout'); } }, CONNECT_MS);
    }, CONNECT_MS);
    void handler;
  }
  function db() { if (!profile) throw new Error('الجلسة غير متحققة'); const database = app.database(); watchConnection(database); return database; }
  function decode(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), x => x.charCodeAt(0)); }
  function encode(value) { return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  // The server's per-user lock answers 'aborted' while another request for the same account is running.
  // Begin/finish are safe to repeat on 'aborted' (the lock refuses before the challenge is consumed).
  async function callRetryingAborted(name, data) {
    const delay = Number(typeof window === 'object' && window.BASMA_RETRY_DELAY_MS) || 2000;
    for (let attempt = 0; ; attempt++) {
      try { return await call(name, data); }
      catch (error) { if (error?.code !== 'functions/aborted' || attempt >= 3) throw error; await new Promise(resolve => setTimeout(resolve, delay)); }
    }
  }
  // Only one fingerprint operation at a time: a double tap must never start a second begin/finish.
  let biometricRunning = false;
  function deviceLabel() {
    const ua = navigator.userAgent || '', os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'جهاز';
    const browser = /SamsungBrowser/.test(ua) ? 'Samsung' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'متصفح';
    return `${os} · ${browser}`;
  }
  async function biometric(mode, intent = 'login', missionKey) {
    if (biometricRunning) throw Object.assign(new Error('عملية بصمة جارية بالفعل'), { code: 'basma/busy' });
    biometricRunning = true;
    try { return await biometricOnce(mode, intent, missionKey); }
    finally { biometricRunning = false; }
  }
  async function biometricOnce(mode, intent, missionKey) {
    const start = await callRetryingAborted('beginWebAuthn', { mode, intent, ...(missionKey ? { missionKey } : {}) });
    const options = start.options;
    options.challenge = decode(options.challenge);
    for (const list of ['allowCredentials', 'excludeCredentials']) if (options[list]) options[list] = options[list].map(x => ({ ...x, id: decode(x.id) }));
    if (options.user) options.user.id = decode(options.user.id);
    const credential = mode === 'register' ? await navigator.credentials.create({ publicKey: options }) : await navigator.credentials.get({ publicKey: options });
    if (!credential) throw new Error('لم يتم التحقق');
    const response = { id: credential.id, rawId: encode(credential.rawId), type: credential.type, clientExtensionResults: credential.getClientExtensionResults(), response: { clientDataJSON: encode(credential.response.clientDataJSON) } };
    if (mode === 'register') Object.assign(response.response, { attestationObject: encode(credential.response.attestationObject), transports: credential.response.getTransports ? credential.response.getTransports() : [] });
    else Object.assign(response.response, { authenticatorData: encode(credential.response.authenticatorData), signature: encode(credential.response.signature), userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : null });
    // Registration sends a short device label for the manager's approval notice (display only; the server checks the credential).
    return callRetryingAborted('finishWebAuthn', { challengeId: start.challengeId, response, ...(mode === 'register' ? { deviceLabel: deviceLabel() } : {}) });
  }
  async function attendance(type, locationData, missionKey) {
    const point = await getGPS();
    point.name = locationData?.name || 'موقع الجهاز';
    const verified = await biometric('authenticate', type, missionKey);
    return call('recordAttendance', { type, proof: verified.proof, location: point, ...(missionKey ? { missionKey } : {}) });
  }
  function getGPS() {
    if (!navigator.geolocation) return Promise.reject(new Error('تحديد الموقع غير متاح على هذا الجهاز'));
    return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(position => {
      resolve({ lat:position.coords.latitude, lng:position.coords.longitude, accuracy:position.coords.accuracy });
    }, error => reject(new Error(error.code === 1 ? 'اسمح بالوصول إلى الموقع لتسجيل الحضور' : 'تعذر تحديد الموقع؛ حاول مجددًا')), {enableHighAccuracy:true,maximumAge:0,timeout:20000}));
  }
  const snapshot = value => ({ val: () => value, exists: () => value !== null, forEach(fn) { for (const [key, item] of Object.entries(value || {})) if (fn({ key, ...snapshot(item) }) === true) return true; return false; } });
  async function records(database, cid, from, to, timeZone = profile?.timeZone || 'UTC') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error('نطاق التاريخ غير صالح');
    const result = {}; let scanned = 0;
    let cursor,cursorKey,count;
    do {
      let query=database.ref(`companies/${cid}/records`).orderByChild('dateKey');
      query=(cursorKey ? query.startAfter(cursor,cursorKey) : query.startAt(from)).endAt(to).limitToFirst(1000);
      const page=await query.once('value');count=page.numChildren();
      page.forEach(item=>{const value=item.val();cursor=value.dateKey;cursorKey=item.key;scanned++;if(value.locStatus!=='rejected')result[item.key]=value;});
      if(scanned>200000)throw new Error('نطاق التقرير كبير. اختر فترة أقصر.');
    } while(count===1000);
    return snapshot(Object.keys(result).length ? result : null);
  }
  // In-page form (window.BasmaDialogs): phones may block window.prompt/alert silently.
  async function changePassword() {
    const dialogs = window.BasmaDialogs;
    if (!dialogs) { banner('تعذر فتح نافذة تغيير كلمة المرور. أعد تحميل الصفحة.'); return; }
    const answer = await dialogs.form('تغيير كلمة المرور', [
      { id: 'password', label: 'كلمة المرور الجديدة (14 حرفًا على الأقل)', type: 'password' },
      { id: 'again', label: 'أعد كتابة كلمة المرور', type: 'password' }
    ]);
    if (!answer || !answer.password) return;
    if (answer.password !== answer.again) { await dialogs.notice('تغيير كلمة المرور', 'كلمتا المرور غير متطابقتين. لم يتغير شيء.'); return; }
    try { await call('changePassword', { password: answer.password }); }
    catch (error) { await dialogs.notice('تغيير كلمة المرور', error.message || 'تعذر تغيير كلمة المرور.'); return; }
    await dialogs.notice('تم تغيير كلمة المرور', 'أُلغيت الجلسات القديمة. سجّل الدخول بالكلمة الجديدة.');
    await logout();
  }
  // Opening failed but the saved session is still there (e.g. no network or a slow server): explain and offer a retry
  // instead of the sign-in form, so a reopened app never asks for the password because of a temporary problem.
  function reopenError(error) {
    banner('تعذر فتح الحساب الآن: ' + (window.BasmaErrors?.message(error) ?? error?.message ?? '') + ' — الجلسة محفوظة.');
    const node = document.getElementById('secure-status');
    if (node && !node.querySelector?.('button')) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'إعادة المحاولة';
      retry.style.cssText = 'margin-inline-start:10px;padding:6px 14px;border-radius:50px;border:0;background:#fff;color:#7f1d1d;font-weight:700;cursor:pointer';
      retry.addEventListener('click', () => location.reload()); node.appendChild(retry);
    }
  }
  function banner(message) {
    let node = document.getElementById('secure-status');
    if (!node) { node = document.createElement('div'); node.id = 'secure-status'; node.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;padding:14px;background:#7f1d1d;color:white;text-align:center;direction:rtl'; document.body.appendChild(node); }
    node.textContent = message;
  }
  // Account menu: one 👤 button inside the page's own top header (the side opposite the title in RTL) that opens a
  // small themed menu with «تغيير كلمة المرور» and «خروج». Same handlers as before. Nothing is fixed at the bottom,
  // so the bottom navigation is never covered. Screens without a header get the button at the TOP-left corner.
  let controlsCleanup = null;
  function controls() {
    controlsCleanup?.(); controlsCleanup = null;
    for (const id of ['basma-controls', 'basma-account-btn', 'basma-account-menu']) document.getElementById(id)?.remove();
    const header = document.querySelector('#s-main .top-bar-left, .top-header > div:last-child');
    const button = document.createElement('button');
    button.id = 'basma-account-btn'; button.type = 'button'; button.textContent = '👤';
    button.setAttribute('aria-label', 'الحساب'); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
    Object.assign(button.style, { width: '38px', height: '38px', borderRadius: '50%', border: '1px solid var(--border,#2a3050)', background: 'var(--surface,#1e2438)', color: 'var(--text,#e8eaf0)', fontSize: '18px', lineHeight: '1', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0', padding: '0' });
    if (header) header.appendChild(button);
    else { Object.assign(button.style, { position: 'fixed', top: 'calc(10px + env(safe-area-inset-top, 0px))', left: 'calc(10px + env(safe-area-inset-left, 0px))', zIndex: '1000' }); document.body.appendChild(button); }
    const menu = document.createElement('div');
    menu.id = 'basma-account-menu'; menu.setAttribute('role', 'menu'); menu.dir = 'rtl'; menu.hidden = true;
    Object.assign(menu.style, { position: 'fixed', zIndex: '100001', minWidth: '190px', background: 'var(--card,#161b2e)', border: '1px solid var(--border,#2a3050)', borderRadius: 'var(--radius-card,16px)', boxShadow: '0 12px 32px rgba(0,0,0,.45)', padding: '6px', fontFamily: "'Cairo',sans-serif" });
    const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    for (const [text, handler, color] of [['تغيير كلمة المرور', changePassword, 'var(--text,#e8eaf0)'], ['خروج', logout, 'var(--red,#ef4444)']]) {
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.textContent = text;
      Object.assign(item.style, { display: 'block', width: '100%', textAlign: 'right', background: 'transparent', border: '0', borderRadius: '10px', padding: '12px 14px', color, fontSize: '14px', fontWeight: '700', fontFamily: "'Cairo',sans-serif", cursor: 'pointer' });
      item.addEventListener('click', () => { close(); Promise.resolve(handler()).catch(error => banner(window.BasmaErrors?.message(error) ?? error.message)); });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const place = () => {
      const r = button.getBoundingClientRect(), width = Math.max(menu.offsetWidth || 190, 190);
      menu.style.top = `${Math.round(r.bottom + 8)}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, (window.innerWidth || 360) - width - 8)))}px`;
    };
    button.addEventListener('click', event => { event.stopPropagation?.(); if (menu.hidden) { menu.hidden = false; place(); button.setAttribute('aria-expanded', 'true'); menu.querySelector('button')?.focus?.(); } else close(); });
    const outside = event => { if (!menu.hidden && !menu.contains(event.target) && event.target !== button) close(); };
    const escape = event => { if (event.key === 'Escape' && !menu.hidden) { close(); button.focus?.(); } };
    const resize = () => { if (!menu.hidden) place(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape); window.addEventListener?.('resize', resize);
    controlsCleanup = () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); window.removeEventListener?.('resize', resize); };
  }
  // A list or screen state: loading (spinner + text), error (plain Arabic, the code in small text, retry button) or empty.
  function stateBox(kind, { text = '', error = null, retry = null } = {}) {
    const wrap = document.createElement('div'); wrap.className = `basma-state basma-state-${kind}`;
    wrap.style.cssText = 'text-align:center;padding:24px 12px;color:var(--text2);grid-column:1/-1';
    if (kind === 'loading') { const spin = document.createElement('div'); spin.className = 'spinner-sm'; wrap.appendChild(spin); }
    const line = document.createElement('div'); line.style.marginTop = '8px'; line.textContent = text || (kind === 'loading' ? 'جاري التحميل...' : ''); wrap.appendChild(line);
    if (kind === 'error') {
      const code = error?.code; if (code) { const small = document.createElement('div'); small.textContent = String(code); small.style.cssText = 'font-size:11px;opacity:.7;margin-top:4px;direction:ltr'; wrap.appendChild(small); }
      if (retry) { const button = document.createElement('button'); button.type = 'button'; button.className = 'modal-btn'; button.textContent = 'إعادة المحاولة'; button.style.marginTop = '10px'; button.addEventListener('click', () => { button.disabled = true; retry(); }); wrap.appendChild(button); }
    }
    return wrap;
  }
  // Every visible spinner gets a limit: still spinning after 20 s, it is hidden and replaced by an Arabic message and a
  // retry button (the page's refresh, otherwise a reload). The spinner node is kept, so the overlay can be reused.
  const SPINNERS = '.spinner-sm,.spinner,.spinner-lg,.lo-spinner', spinnerSeen = new WeakMap(), stoppedSpinners = new Map();
  const spinnerLimit = () => Number(window.BASMA_SPINNER_TIMEOUT_MS) || 20000;
  function retryPage() { if (typeof window.refreshCurrentPage === 'function') window.refreshCurrentPage(); else window.location.reload(); }
  function sweepSpinners(now = Date.now()) {
    if (typeof document?.querySelectorAll !== 'function') return 0;
    let stopped = 0;
    // A stopped overlay spinner comes back once the page hides the overlay, so the next showLoading() spins again.
    for (const [node, restore] of stoppedSpinners) { const overlay = node.closest?.('.loading-overlay'); if (!node.isConnected || (overlay && !overlay.classList.contains('active'))) restore(); }
    for (const node of document.querySelectorAll(SPINNERS)) {
      const overlay = node.closest?.('.loading-overlay');
      const visible = node.style.display !== 'none' && (overlay ? overlay.classList.contains('active') : node.offsetParent !== null);
      if (!visible) { spinnerSeen.delete(node); continue; }
      if (!spinnerSeen.has(node)) { spinnerSeen.set(node, now); continue; }
      if (now - spinnerSeen.get(node) < spinnerLimit()) continue;
      spinnerSeen.delete(node); stopped++;
      const error = Object.assign(new Error('تأخر الرد أكثر من 20 ثانية'), { code: 'basma/timeout' });
      const text = overlay ? 'تأخر الرد أكثر من 20 ثانية. قد تكتمل العملية لاحقًا؛ تحقق منها قبل تكرارها.' : 'تأخر التحميل أكثر من 20 ثانية. تحقق من الإنترنت ثم اضغط «إعادة المحاولة».';
      const restore = () => { stoppedSpinners.delete(node); box.remove(); node.style.display = ''; for (const t of hiddenText) t.style.display = ''; };
      const box = stateBox('error', { text, error, retry: () => { restore(); if (overlay) overlay.classList.remove('active'); retryPage(); } });
      const hiddenText = [];
      // The "loading" words next to the spinner would contradict the message.
      for (const sibling of [...(node.parentElement?.children || [])]) if (sibling !== node && /تحميل|الاتصال|جاري/.test(sibling.textContent || '') && !sibling.querySelector?.('button')) { sibling.style.display = 'none'; hiddenText.push(sibling); }
      for (const child of [...(node.parentElement?.childNodes || [])]) if (child.nodeType === 3 && /تحميل|جاري/.test(child.textContent)) child.textContent = '';
      if (overlay) { const close = document.createElement('button'); close.type = 'button'; close.className = 'modal-btn'; close.textContent = 'إغلاق'; close.style.margin = '10px 6px 0'; close.addEventListener('click', () => { restore(); overlay.classList.remove('active'); }); box.appendChild(close); }
      node.style.display = 'none'; node.after(box); stoppedSpinners.set(node, restore);
    }
    return stopped;
  }
  if (typeof setInterval === 'function' && typeof document?.querySelectorAll === 'function' && !window.BASMA_NO_SPINNER_GUARD) setInterval(() => sweepSpinners(), 1000);
  // Direct writes still used by some manager actions get a visible 20 s limit (the realtime channel stalls on the
  // owner's network for writes as for reads). Only set/update/remove/push are limited; reads and listeners pass through.
  const WRITE_CALLS = new Set(['set', 'update', 'remove', 'push', 'setWithPriority']);
  function limitWrites(database) {
    const limit = () => Number(window.BASMA_WRITE_TIMEOUT_MS) || 20000;
    const limited = promise => { let timer; const stop = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`لم يُؤكَّد الحفظ خلال ${Math.round(limit() / 1000)} ثانية. تحقق من الإنترنت ثم أعد المحاولة.`), { code: 'basma/write-timeout' })), limit()); }); return Promise.race([Promise.resolve(promise), stop]).finally(() => clearTimeout(timer)); };
    const wrapRef = ref => new Proxy(ref, { get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (prop === 'child') return (...args) => wrapRef(value.apply(target, args));
      if (WRITE_CALLS.has(prop)) return (...args) => { const result = value.apply(target, args); return prop === 'push' && args.length === 0 ? result : limited(result); };
      return value.bind(target);
    } });
    return new Proxy(database, { get(target, prop) {
      const value = target[prop];
      if (prop === 'ref') return (...args) => wrapRef(value.apply(target, args));
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  // ---- Server-routed database (v5.11) ----
  // Pages keep their database-style code (ref().once/on/update/push/remove), but each ROUTED path is answered by a
  // server call (HTTPS + App Check, 20 s limit) instead of the realtime connection, which stalls on some networks.
  // route(path, op, {query, value}) returns {name, data} or null; null = the real database (traced as unrouted).
  function snapshotOf(value, key = null) {
    const list = value && Array.isArray(value.__order) ? value.__order : null;
    const plainValue = list ? (list.length ? Object.fromEntries(list) : null) : (value === undefined ? null : value);
    const entries = () => list || (plainValue && typeof plainValue === 'object' ? Object.entries(plainValue) : []);
    return { key, val: () => plainValue, exists: () => plainValue !== null, numChildren: () => entries().length,
      forEach(fn) { for (const [k, v] of entries()) if (fn(snapshotOf(v, k)) === true) return true; return false; },
      child(part) { return snapshotOf(plainValue && typeof plainValue === 'object' ? plainValue[part] ?? null : null, part); } };
  }
  const resultValue = result => (result && Array.isArray(result.order) ? { __order: result.order.filter(k => result.items && Object.hasOwn(result.items, k)).map(k => [k, result.items[k]]) } : result?.value ?? null);
  function serverDb(getReal, route, { ttl = 10000, pollMs = 120000, limitMs = () => Number(window.BASMA_LIST_TIMEOUT_MS) || 20000 } = {}) {
    let real = null; const realDb = () => (real ||= getReal());
    const cache = new Map(), listeners = new Set();
    const fetchRoute = (plan, { fresh = false } = {}) => {
      const key = plan.name + JSON.stringify(plan.data), hit = cache.get(key), now = Date.now();
      if (!fresh && hit && now - hit.at < ttl) return hit.promise;
      const t0 = clock(), promise = timeout(call(plan.name, plan.data), limitMs(), plan.name)
        .then(value => { trace(`الدالة ${plan.name} ${plan.data.kind || plan.data.action || ''}`, t0, true); return value; },
          error => { cache.delete(key); trace(`الدالة ${plan.name} ${plan.data.kind || plan.data.action || ''}`, t0, false, error?.code || 'error'); throw error; });
      cache.set(key, { at: now, promise }); return promise;
    };
    const poll = () => { for (const l of listeners) l.poll(); };
    window.addEventListener?.('focus', poll); window.addEventListener?.('basma-attendance-settled', () => { cache.clear(); });
    window.addEventListener?.('basma-manager-mutated', () => { cache.clear(); });
    document.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
    if (typeof setInterval === 'function' && pollMs) setInterval(() => { if (document.visibilityState !== 'hidden' && listeners.size) { cache.clear(); poll(); } }, pollMs);
    const QUERY = ['orderByChild', 'orderByKey', 'orderByValue', 'equalTo', 'startAt', 'startAfter', 'endAt', 'endBefore', 'limitToFirst', 'limitToLast'];
    function makeRef(path, calls = []) {
      const query = Object.fromEntries(calls.map(([m, a]) => [m, a.length > 1 ? a : a[0]]));
      const plan = (op, value) => route(path, op, { query, value });
      const realRef = () => { trace(`قراءة/كتابة مباشرة غير محوّلة: ${path.replace(/\/[A-Za-z0-9_-]{12,}/g, '/…')}`, clock(), true, 'unrouted'); let r = realDb().ref(path); for (const [m, a] of calls) r = r[m](...a); return r; };
      const ref = { key: path.split('/').pop() || null, get ref() { return ref; },
        child: part => makeRef(`${path}/${part}`), toString: () => path };
      for (const m of QUERY) ref[m] = (...a) => makeRef(path, [...calls, [m, a]]);
      const pickOf = (p, r) => resultValue(p.pick ? p.pick(r || {}) : r);
      const read = () => { const p = plan('read'); return p ? fetchRoute(p).then(r => snapshotOf(pickOf(p, r))) : null; };
      ref.once = (type = 'value', cb) => { const r = read(); if (!r) return realRef().once(type, cb); return r.then(snap => { cb?.(snap); return snap; }); };
      ref.get = () => read() || realRef().get();
      ref.on = (type, cb, errorCb) => {
        const p = plan('read'); if (!p) return realRef().on(type, cb, errorCb);
        let last;
        const listener = { path, cb, poll: () => fetchRoute(p).then(r => { const value = pickOf(p, r), sig = JSON.stringify(value); if (sig === last) return; last = sig; cb(snapshotOf(value)); }).catch(error => { if (/permission-denied/.test(String(error?.code || ''))) errorCb?.(error); }) }; // network/timeout errors: kept, retried on the next refresh (no logout)
        listeners.add(listener); listener.poll(); return cb;
      };
      ref.off = (type, cb) => { let routed = false; for (const l of [...listeners]) if (l.path === path && (!cb || l.cb === cb)) { listeners.delete(l); routed = true; } if (!routed && real) realRef().off(type, cb); };
      for (const op of ['set', 'update', 'remove', 'push']) ref[op] = (...args) => {
        const p = plan(op, args[0]);
        if (!p) return realRef()[op](...args);
        if (op === 'push' && args.length === 0) throw new Error('push() بدون قيمة غير مدعوم في المسار المحوّل');
        return timeout(call(p.name, p.data), limitMs(), p.name).then(result => { cache.clear(); poll(); return result; });
      };
      return ref;
    }
    return { ref: path => makeRef(String(path || '').replace(/^\/+|\/+$/g, '')), prime(name, data, result) { cache.set(name + JSON.stringify(data), { at: Date.now(), promise: Promise.resolve(result) }); }, poll,
      get real() { return real; }, goOffline() { real?.goOffline(); }, goOnline() { real?.goOnline(); } };
  }
  return { stateBox, limitWrites, serverDb, snapshotOf, sweepSpinners, init, call, session, login, logout, db, trace, timeout, clock, takeHome, warm, get connection() { return { ...connection }; }, biometric, attendance, records, getGPS, banner, controls, changePassword, get profile() { return profile; }, get signedIn() { return !!app?.auth().currentUser; }, reopenError, get persistenceMode() { return persistenceMode; } };
})();
