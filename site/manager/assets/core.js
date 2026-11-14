'use strict';
window.Basma = (() => {
  let app, profile, ready, selectedRole, persistenceMode;
  function init(role) {
    if (ready && role && role !== selectedRole) throw new Error('استخدم صفحة الحساب المناسبة');
    if (ready) return ready;
    if (!['employee','manager','seller'].includes(role)) throw new Error('يجب تحديد نوع الحساب قبل الاتصال');
    selectedRole = role;
    ready = (async () => {
      const config = window.BASMA_CONFIG;
      if (!config || JSON.stringify(config).includes('REPLACE_ME')) throw new Error('يلزم إكمال إعدادات النشر في ملف config.js');
      const appName = `secure-${selectedRole}`;
      app = firebase.apps.find(x => x.name === appName) || firebase.initializeApp(config.firebase, appName);
      app.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(config.appCheckSiteKey), true);
      persistenceMode = selectedRole === 'employee' ? 'LOCAL' : 'SESSION';
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
      if(selectedRole==='manager'&&!['profile','serverClock'].includes(name))window.dispatchEvent?.(new CustomEvent('basma-manager-mutated'));
      return result; }
    finally { if(name==='recordAttendance') window.dispatchEvent?.(new CustomEvent('basma-attendance-settled')); }
  }
  async function session(role) {
    await init(role);
    if (!app.auth().currentUser) return null;
    try {
      const t0 = clock(); traceStart(`فتح صفحة ${role}`);
      await app.auth().currentUser.getIdToken(true); trace('تجديد رمز الدخول', t0);
      const t1 = clock(); const candidate = await call('profile'); trace('الدالة profile', t1);
      if (candidate.role !== role) throw Object.assign(new Error('هذا الحساب غير مخوّل لهذه الواجهة'), { code:'functions/permission-denied' });
      profile = {...candidate,clockOffset:Number.isFinite(candidate.serverTime)?candidate.serverTime-Date.now():0};
      return profile;
    } catch (error) {
      profile = null;
      if (['functions/permission-denied','functions/unauthenticated','auth/user-token-expired','auth/invalid-user-token','auth/user-disabled'].includes(error.code)) await app.auth().signOut();
      throw error;
    }
  }
  async function login(username, password, role) {
    await init(role);
    const email = username.includes('@') ? username.trim() : `${username.trim()}@basma.app`;
    await app.auth().signInWithEmailAndPassword(email, password);
    return session(role);
  }
  async function logout() {
    window.dispatchEvent?.(new CustomEvent('basma-session-ended'));
    if (app) { app.database().goOffline(); await app.auth().signOut(); }
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage)) if (/^basma_shared_/.test(key)) storage.removeItem(key);
    }
    location.reload();
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
  // The SDK uses WebSocket ONLY when the browser supports it and it has not failed before. On some networks and
  // browsers the WebSocket stalls without failing, so the connection never establishes and every read waits forever.
  // If '.info/connected' is not true within CONNECT_MS, switch this tab to long polling (forceLongPolling, then a
  // fresh connection via goOffline/goOnline creates a new transport choice) and remember it for this tab.
  const CONNECT_MS = 5000, POLL_KEY = 'basma_db_long_polling';
  const connection = { state: 'idle', transport: 'websocket', since: 0 };
  let watched = false;
  function forcePolling(database) {
    const internal = database?.INTERNAL || window.firebase?.database?.INTERNAL;
    if (typeof internal?.forceLongPolling !== 'function') return false;
    internal.forceLongPolling(); connection.transport = 'long-polling'; return true;
  }
  function watchConnection(database) {
    if (watched) return; watched = true;
    const t0 = clock(); connection.state = 'connecting'; connection.since = Date.now();
    let remembered = false; try { remembered = sessionStorage.getItem(POLL_KEY) === '1'; } catch {}
    if (remembered) forcePolling(database);
    let done = false;
    const ref = database.ref('.info/connected');
    const handler = ref.on('value', snap => {
      if (snap.val() !== true || done) return;
      done = true; connection.state = 'connected'; trace(`اتصال قاعدة البيانات (${connection.transport})`, t0, true);
    });
    setTimeout(() => {
      if (done) return;
      trace('اتصال قاعدة البيانات (websocket) لم يكتمل', t0, false, 'db/connect-timeout');
      if (connection.transport === 'long-polling' || !forcePolling(database)) { connection.state = 'stalled'; return; }
      try { sessionStorage.setItem(POLL_KEY, '1'); } catch {}
      const t1 = clock(); database.goOffline(); database.goOnline();
      const stop = ref.on('value', snap => { if (snap.val() === true) { ref.off('value', stop); connection.state = 'connected'; trace('اتصال قاعدة البيانات (long-polling)', t1, true); } });
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
    return callRetryingAborted('finishWebAuthn', { challengeId: start.challengeId, response });
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
  function banner(message) {
    let node = document.getElementById('secure-status');
    if (!node) { node = document.createElement('div'); node.id = 'secure-status'; node.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;padding:14px;background:#7f1d1d;color:white;text-align:center;direction:rtl'; document.body.appendChild(node); }
    node.textContent = message;
  }
  function controls() {
    document.getElementById('basma-controls')?.remove();
    const bar = document.createElement('div'); bar.id = 'basma-controls'; bar.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:1000;display:flex;gap:8px';
    for (const [text, handler] of [['تغيير كلمة المرور', changePassword], ['خروج', logout]]) {
      const button = document.createElement('button'); button.textContent = text; button.style.cssText = 'padding:8px;border-radius:8px;cursor:pointer'; button.addEventListener('click', () => Promise.resolve(handler()).catch(error => banner(window.BasmaErrors?.message(error) ?? error.message))); bar.appendChild(button);
    }
    document.body.appendChild(bar);
  }
  return { init, call, session, login, logout, db, trace, timeout, clock, get connection() { return { ...connection }; }, biometric, attendance, records, getGPS, banner, controls, changePassword, get profile() { return profile; }, get persistenceMode() { return persistenceMode; } };
})();
