'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString } = require('firebase-functions/params');
const webauthn = require('@simplewebauthn/server');
const p = require('./policy');
initializeApp();
const db = getDatabase(), auth = getAuth();
const rpID = defineString('WEBAUTHN_RP_ID');
const originList = defineString('WEBAUTHN_ORIGINS');
const backupBucket = defineString('BACKUP_BUCKET', { default: '' });
const region = 'us-central1';
const read = async path => (await db.ref(path).get()).val();
const audit = (actor, action, target, details = {}) => db.ref('audit').push({ actor, action, target, details, at: Date.now() });
function endpoint(roles, handler) {
  return onCall({ region, enforceAppCheck: true, maxInstances: 10, timeoutSeconds: 60 }, async req => {
    try {
      if (!req.auth) p.fail('سجّل الدخول', 'unauthenticated');
      const member = await read(`access/${req.auth.uid}`);
      const info = member?.companyId ? await read(`companies/${member.companyId}/info`) : null;
      p.authorize(member, req.auth.token, info, roles);
      const employee = member.role === 'employee' ? await employeeContext(req.auth.uid, member) : null;
      const now = Date.now(), bucket = Math.floor(now / 60000);
      const rate = await db.ref(`rateLimits/${req.auth.uid}`).transaction(old => {
        const state = old?.bucket === bucket ? old : { bucket, count: 0, expiresAt: now + 120000 };
        return state.count >= 90 ? undefined : { ...state, count: state.count + 1 };
      });
      if (!rate.committed) p.fail('طلبات كثيرة، حاول لاحقًا', 'resource-exhausted');
      return await handler({ uid: req.auth.uid, token: req.auth.token, member, info, employee, data: req.data || {} });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      if (error instanceof p.PolicyError) throw new HttpsError(error.code, error.message, error.details);
      console.error('operation_failed', { code: error.code || 'internal' });
      throw new HttpsError('internal', 'تعذرت العملية. راجع سجل التشغيل.');
    }
  });
}
const allRoles = ['seller', 'manager', 'employee'];
exports.profile = endpoint(allRoles, async ({ member, info }) => ({ role: member.role, companyId: member.companyId || null, employeeId: member.employeeId || null, name: info?.nameAr || 'بصمة', timeZone:info?.timeZone || 'UTC', serverTime:Date.now() }));
exports.serverClock = endpoint(allRoles, async () => ({ serverTime:Date.now() }));
// Narrow home projection: never return coworkers, request history or notifications.
exports.employeeHome = endpoint(['employee'], async ({member,info,employee}) => {
  const cid=member.companyId,eid=member.employeeId,stamp=Date.now();
  const date=p.dateParts(new Date(stamp),info.timeZone).date;
  const [settings,warehouse,today,fullLeave]=await Promise.all([
    read(`companies/${cid}/settings`),read(`companies/${cid}/warehouses/${p.key(employee.warehouseId)}`),read(`companies/${cid}/today/${eid}`),
    read(`fullDayLeaveIndex/${cid}/${eid}/${date}`)
  ]);
  const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
  return {serverTime:Date.now(),date,employee,
    info:pick(info,['nameAr','nameEn','name','logo','timeZone','status']),
    settings:pick(settings,['checkIn','checkOut','weekendDays','holidays','geoZone']),
    warehouse:pick(warehouse,['name','active','schedule','geoZone']),today:today?.dateKey===date?today:{},
    onLeave:fullLeave === true};
});
exports.listCompanies = endpoint(['seller'], async ({ data }) => {
  let query = db.ref('companyDirectory').orderByKey().limitToFirst(100);
  if (data.cursor) query = query.startAfter(p.key(data.cursor));
  const snapshot = await query.get(), companies = {}; let cursor = null;
  for (const [id, info] of Object.entries(snapshot.val() || {})) {
    cursor = id;
    companies[id] = { id, info, status: info.status === 'suspended' ? 'suspended' : info.expiresAt <= Date.now() ? 'expired' : 'active', expiresAt: info.expiresAt, empCount: await read(`employeeIndex/${id}/count`) || 0 };
  }
  // Manager USERNAME for the seller panel (not secret). It lives only in the linked Auth account's email;
  // passwords are never stored or returned. Read-only; a missing link or Auth error leaves the field out.
  await Promise.all(Object.keys(companies).map(async id => {
    const managerUid = await read(`accountLinks/${id}/manager`);
    if (typeof managerUid !== 'string' || !managerUid) return;
    try {
      const email = String((await auth.getUser(managerUid))?.email || '');
      if (email.endsWith('@basma.app')) companies[id].managerUsername = email.slice(0, -'@basma.app'.length);
    } catch {}
  }));
  return { companies, cursor: snapshot.numChildren() === 100 ? cursor : null };
});
exports.projectCompanyDirectory = onValueWritten({ ref:'/companies/{cid}/info', region, retry:true }, async event => {
  const info = await read(`companies/${event.params.cid}/info`);
  await db.ref(`companyDirectory/${event.params.cid}`).set(info);
});
async function createAccount(member) {
  const username = `${member.role}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const password = p.password();
  const user = await auth.createUser({ email: `${username}@basma.app`, password });
  try {
    await auth.setCustomUserClaims(user.uid, { version: 1 });
    await db.ref(`access/${user.uid}`).set({ ...member, enabled: true, version: 1, createdAt: Date.now() });
    return { uid: user.uid, username, password };
  } catch (error) { await auth.deleteUser(user.uid); throw error; }
}
function companyInfo(data) {
  const maxEmployees = Number(data.maxEmployees), expiresAt = Number(data.expiresAt);
  if (!Number.isInteger(maxEmployees) || maxEmployees < 1 || maxEmployees > 10000) p.fail('حد الموظفين بين 1 و10000', 'invalid-argument');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) p.fail('تاريخ الصلاحية مطلوب', 'invalid-argument');
  p.dateParts(new Date(), data.timeZone);
  return { nameAr: p.text(data.nameAr, 'اسم الشركة'), nameEn: p.text(data.nameEn, 'الاسم الإنجليزي'), logo: data.logo ? p.text(data.logo, 'الشعار', 30) : '🏭', industry: data.industry ? p.text(data.industry, 'النشاط') : '', plan: p.text(data.plan || 'manual', 'الخطة', 50), maxEmployees, expiresAt, status: 'active', timeZone: data.timeZone, createdAt: Date.now() };
}
function schedule(data) {
  for (const name of ['checkIn', 'checkOut']) { p.minutes(data?.[name]?.from); p.minutes(data?.[name]?.to); }
  return { checkIn: { from: data.checkIn.from, to: data.checkIn.to }, checkOut: { from: data.checkOut.from, to: data.checkOut.to } };
}
// Seller notifications are written only by the server; the seller page reads and marks them read.
const sellerNote = (type, message) => db.ref('seller/notifications').push({ type, message, timestamp: new Date().toISOString(), read: false });
exports.createCompany = endpoint(['seller'], async ({ uid, data }) => {
  const info = companyInfo(data), settings = schedule(data.settings), cid = db.ref('companies').push().key;
  const names = Array.isArray(data.warehouses) && data.warehouses.length ? data.warehouses : ['الفرع الرئيسي'];
  if (names.length > 100) p.fail('عدد الفروع كبير', 'invalid-argument');
  const warehouses = Object.fromEntries(names.map(name => [db.ref().push().key, { name: p.text(name, 'الفرع'), active: true }]));
  const account = await createAccount({ role: 'manager', companyId: cid });
  try {
    await db.ref(`companies/${cid}`).set({ info, settings, warehouses });
    await db.ref(`accountLinks/${cid}/manager`).set(account.uid);
    await audit(uid, 'company.create', cid);
    await sellerNote('new_company', `🏢 تم إنشاء شركة جديدة: ${info.nameAr}`).catch(() => {});
    return { companyId: cid, ...account };
  } catch (error) { await db.ref(`access/${account.uid}`).remove(); await auth.deleteUser(account.uid); throw error; }
});
exports.companyStatus = endpoint(['seller'], async ({ uid, data }) => {
  const cid = p.key(data.companyId);
  if (!await read(`companies/${cid}/info`)) p.fail('الشركة غير موجودة', 'not-found');
  if (!['active', 'suspended'].includes(data.status)) p.fail('حالة غير صالحة', 'invalid-argument');
  await db.ref(`companies/${cid}/info/status`).set(data.status);
  await audit(uid, 'company.status', cid, { status: data.status });
  return { ok: true };
});
exports.updatePlan = endpoint(['seller'], async ({ uid, data }) => {
  const cid = p.key(data.companyId), old = await read(`companies/${cid}/info`);
  if (!old) p.fail('الشركة غير موجودة', 'not-found');
  const value = companyInfo({ ...old, ...data });
  if ((await read(`employeeIndex/${cid}/count`) || 0) > value.maxEmployees) p.fail('الحد الجديد أقل من عدد الموظفين الحالي');
  await db.ref(`companies/${cid}/info`).update({ maxEmployees: value.maxEmployees, expiresAt: value.expiresAt, plan: value.plan });
  await audit(uid, 'company.plan', cid, { maxEmployees: value.maxEmployees, expiresAt: value.expiresAt, plan: value.plan });
  return { ok: true };
});
// RTDB transactions run their handler first with the LOCAL cache, which is empty (null) on a cold instance. A handler
// that returns undefined for null then aborts at once and never sees the server value. serverTransaction() keeps a
// 'value' listener open while the transaction runs, so the cache already holds the server value and the FIRST call sees
// the real data (Firebase's documented approach). Handlers keep their original meaning: null really means "no data".
async function serverTransaction(ref, update) {
  let callback;
  await new Promise((resolve, reject) => { callback = ref.on('value', () => resolve(), reject); });
  try { return await ref.transaction(update); } finally { ref.off('value', callback); }
}
async function withLock(id, handler) {
  const owner = randomUUID(), lock = db.ref(`operationLocks/${p.key(id)}`);
  const acquired = await lock.transaction(value => !value || value.expiresAt <= Date.now() ? { owner, expiresAt: Date.now() + 60000 } : undefined);
  if (!acquired.committed) p.fail('توجد عملية أخرى على الحساب؛ أعد المحاولة', 'aborted');
  try { return await handler(); } finally { await serverTransaction(lock, value => value?.owner === owner ? null : undefined); }
}
async function rotateAccount(uid, member) {
  return withLock(uid, async () => {
  // Disable live authorization BEFORE changing credentials. Old ID tokens fail immediately.
  const password = p.password();
  const update = await serverTransaction(db.ref(`access/${uid}`), current => current ? { ...current, enabled: false, version: current.version + 1 } : undefined);
  if (!update.committed) p.fail('الحساب غير موجود', 'not-found');
  const nextVersion = update.snapshot.val().version;
  await auth.revokeRefreshTokens(uid);
  await auth.updateUser(uid, { password, disabled: false });
  await auth.setCustomUserClaims(uid, { version: nextVersion });
  await db.ref(`access/${uid}/enabled`).set(true);
  const user = await auth.getUser(uid);
  return { uid, username: user.email.split('@')[0], password };
  });
}
exports.resetManager = endpoint(['seller'], async ({ uid, data }) => {
  const cid = p.key(data.companyId), target = await read(`accountLinks/${cid}/manager`);
  if (!target) p.fail('الحساب غير موجود', 'not-found');
  const member = await read(`access/${target}`);
  if (member?.role !== 'manager' || member.companyId !== cid) p.fail('ربط حساب غير صالح');
  const account = await rotateAccount(target, member);
  await audit(uid, 'manager.reset', cid);
  return account;
});
exports.employeeAccount = endpoint(['manager'], async ({ uid, member, info, data }) => {
  const cid = member.companyId, eid = p.key(data.employeeId);
  return withLock(`${cid}_${eid}`, async () => {
  const old = await read(`companies/${cid}/employees/${eid}`);
  if (!old) p.fail('الموظف غير موجود', 'not-found');
  const link = `accountLinks/${cid}/employees/${eid}`;
  const target = await read(link);
  if (target) {
    const accountMember = await read(`access/${target}`);
    if (accountMember?.companyId !== cid || accountMember.employeeId !== eid || accountMember.role !== 'employee') p.fail('ربط غير صالح');
    const result = await rotateAccount(target, accountMember);
    if (data.resetBio === true) {
      await db.ref(`credentials/${target}`).remove();
      await db.ref(`companies/${cid}/employees/${eid}`).update({ status: 'pending_activation', credId: null, deviceFingerprint: null });
    }
    await audit(uid, 'employee.reset', `${cid}/${eid}`, { resetBio: data.resetBio === true });
    return result;
  }
  const result = await createAccount({ role: 'employee', companyId: cid, employeeId: eid });
  await db.ref(link).set(result.uid);
  await audit(uid, 'employee.account', `${cid}/${eid}`);
  return result;
  });
});
exports.addEmployee = endpoint(['manager'], async ({ uid, member, info, data }) => {
  const cid = member.companyId, eid = db.ref().push().key;
  const employee = { name: p.text(data.name, 'الاسم'), empId: p.text(data.empId, 'رقم الموظف', 50), role: p.text(data.role, 'المسمى'), warehouseId: p.key(data.warehouseId), status: 'pending_activation', createdAt: Date.now() };
  const payroll = p.payrollValues(data);
  const wh = await read(`companies/${cid}/warehouses/${employee.warehouseId}`);
  if (!wh?.active) p.fail('الفرع غير متاح');
  employee.warehouseName = wh.name;
  // Reservation transaction handles concurrent additions and unique business employee IDs.
  const hash = createHash('sha256').update(employee.empId).digest('hex');
  const reservation = await db.ref(`employeeIndex/${cid}`).transaction(old => {
    const index = old || { count: 0, ids: {} };
    if (index.count >= info.maxEmployees || index.ids?.[hash]) return;
    return { count: index.count + 1, ids: { ...index.ids, [hash]: eid } };
  });
  if (!reservation.committed) p.fail('بلغت حد الموظفين أو رقم الموظف مستخدم', 'resource-exhausted');
  let account;
  try {
    account = await createAccount({ role: 'employee', companyId: cid, employeeId: eid });
    await db.ref().update({ [`companies/${cid}/employees/${eid}`]: employee, [`privatePayroll/${cid}/${eid}`]: payroll, [`accountLinks/${cid}/employees/${eid}`]: account.uid });
  } catch (error) {
    await db.ref(`employeeIndex/${cid}`).transaction(index => {
      if (index?.ids?.[hash] === eid) { delete index.ids[hash]; index.count--; } return index;
    });
    if (account) { await db.ref(`access/${account.uid}`).remove(); await auth.deleteUser(account.uid); }
    throw error;
  }
  await audit(uid, 'employee.create', `${cid}/${eid}`);
  return { employeeId: eid, ...account };
});
exports.disableEmployee = endpoint(['manager'], async ({ uid, member, data }) => {
  const eid = p.key(data.employeeId), cid = member.companyId;
  const target = await read(`accountLinks/${cid}/employees/${eid}`);
  if (target) { await db.ref(`access/${target}/enabled`).set(false); await auth.updateUser(target, { disabled: true }); await auth.revokeRefreshTokens(target); }
  await db.ref(`companies/${cid}/employees/${eid}/status`).set('rejected');
  await audit(uid, 'employee.disable', `${cid}/${eid}`);
  return { ok: true };
});
exports.setEmployeePayroll = endpoint(['manager'], async ({ uid, member, data }) => {
  const cid = member.companyId, eid = p.key(data.employeeId), values = p.payrollValues(data);
  if (!await read(`companies/${cid}/employees/${eid}`)) p.fail('الموظف غير موجود', 'not-found');
  return withLock(`payroll_${createHash('sha256').update(`${cid}/${eid}`).digest('hex')}`, async () => {
    await db.ref(`privatePayroll/${cid}/${eid}`).set(values);
    await audit(uid, 'payroll.update', `${cid}/${eid}`);
    return { ok:true };
  });
});
exports.transferEmployee = endpoint(['manager'], async ({ uid, member, data }) => {
  const cid = member.companyId, eid = p.key(data.employeeId), warehouseId = p.key(data.warehouseId);
  const warehouse = await read(`companies/${cid}/warehouses/${warehouseId}`);
  if (!warehouse?.active) p.fail('الفرع غير متاح');
  const ref = db.ref(`companies/${cid}/employees/${eid}`), before = await ref.get();
  if (!before.exists()) p.fail('الموظف غير موجود', 'not-found');
  // Update only the live branch assignment. Attendance events retain their historical branch.
  await ref.update({ warehouseId, warehouseName:warehouse.name });
  await audit(uid, 'employee.transfer', `${cid}/${eid}`, { from:before.val().warehouseId, to:warehouseId });
  return { ok:true };
});
exports.renewSubscription = endpoint(['seller'], async ({ uid, data }) => {
  const cid = p.key(data.companyId), requestId = p.key(data.requestId);
  if (!Number.isInteger(data.days) || data.days < 1 || data.days > 3660) p.fail('مدة التجديد بين يوم و3660 يومًا', 'invalid-argument');
  let conflict;
  const result = await serverTransaction(db.ref(`companies/${cid}/info`), info => {
    if (!info) { conflict='الشركة غير موجودة'; return; }
    const previous = info.renewalMarkers?.[requestId];
    if (previous) {
      if (previous.days !== data.days || previous.actor !== uid) { conflict='معرّف العملية مستخدم لتجديد مختلف'; return; }
      return info;
    }
    const expiresAt = Math.max(Date.now(), Number.isFinite(info.expiresAt) ? info.expiresAt : 0) + data.days * 86400000;
    return { ...info, expiresAt, renewalMarkers:{ ...info.renewalMarkers, [requestId]:{days:data.days,actor:uid,expiresAt} } };
  });
  if (!result.committed) p.fail(conflict || 'تعذر التجديد');
  const expiresAt = result.snapshot.val().renewalMarkers[requestId].expiresAt;
  await audit(uid, 'company.renew', cid, { requestId, days:data.days, expiresAt });
  // A deliberate suspension remains suspended; renewal never implicitly reactivates it.
  return { ok:true, expiresAt };
});
function relyingParty() {
  const id = rpID.value(), origins = originList.value().split(',').map(x => x.trim());
  if (!id || !origins.length || origins.some(o => { try { const u = new URL(o); return u.protocol !== 'https:' || u.origin !== o || !(u.hostname === id || u.hostname.endsWith(`.${id}`)); } catch { return true; } })) p.fail('إعدادات نطاق البصمة غير صحيحة');
  return { id, origins };
}
async function employeeContext(uid, member) {
  const employee = await read(`companies/${member.companyId}/employees/${member.employeeId}`);
  if (!employee || !['approved', 'pending_activation'].includes(employee.status)) p.fail('الموظف غير مفعّل', 'permission-denied');
  return employee;
}
exports.beginWebAuthn = endpoint(['employee'], async ({ uid, member, data }) => {
  const employee = await employeeContext(uid, member), rp = relyingParty();
  const stored = await read(`credentials/${uid}`);
  if (!['register', 'authenticate'].includes(data.mode)) p.fail('عملية غير صالحة', 'invalid-argument');
  if (data.mode === 'register' && stored) p.fail('اطلب من المدير إعادة تعيين البصمة');
  if (data.mode === 'authenticate' && !stored) p.fail('سجّل البصمة أولًا');
  const intent = data.intent || 'login';
  if (!['login', 'in', 'out', 'departure', 'return', 'mission_start', 'mission_end'].includes(intent)) p.fail('عملية غير صالحة', 'invalid-argument');
  const missionKey = data.missionKey ? p.key(data.missionKey) : null;
  if (intent.startsWith('mission_') && !missionKey) p.fail('المهمة مطلوبة', 'invalid-argument');
  const options = data.mode === 'register' ? await webauthn.generateRegistrationOptions({ rpName: 'بصمة', rpID: rp.id, userID: Buffer.from(uid), userName: uid, userDisplayName: employee.name, attestationType: 'none', authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' } }) : await webauthn.generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required', allowCredentials: [{ id: stored.id, transports: stored.transports || [] }] });
  const challengeId = randomUUID();
  await db.ref(`challenges/${uid}/${challengeId}`).set({ challenge: options.challenge, mode: data.mode, intent, missionKey, version: member.version, expiresAt: Date.now() + 120000 });
  return { options, challengeId };
});
exports.finishWebAuthn = endpoint(['employee'], async ({ uid, member, data }) => {
  return withLock(uid, async () => {
  const currentMember = await read(`access/${uid}`), currentInfo = await read(`companies/${member.companyId}/info`);
  p.authorize(currentMember, { version: member.version }, currentInfo, ['employee']);
  await employeeContext(uid, member);
  const challengeId = p.key(data.challengeId), ref = db.ref(`challenges/${uid}/${challengeId}`), now = Date.now();
  let challenge;
  const consumed = await serverTransaction(ref, value => {
    if (!value || value.used || value.expiresAt <= now || value.version !== member.version) return;
    challenge = value; return { ...value, used: true };
  });
  if (!consumed.committed) p.fail('تحدي منتهي أو مستخدم', 'permission-denied');
  const rp = relyingParty();
  if (challenge.mode === 'register') {
    const result = await webauthn.verifyRegistrationResponse({ response: data.response, expectedChallenge: challenge.challenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true });
    if (!result.verified || !result.registrationInfo) p.fail('فشل التحقق', 'permission-denied');
    const credential = result.registrationInfo.credential;
    const saved = await db.ref(`credentials/${uid}`).transaction(old => old ? undefined : { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64'), counter: credential.counter, transports: credential.transports || [], deviceType: result.registrationInfo.credentialDeviceType, backedUp: result.registrationInfo.credentialBackedUp });
    if (!saved.committed) p.fail('البصمة مسجلة مسبقًا');
    const activated = await serverTransaction(db.ref(`companies/${member.companyId}/employees/${member.employeeId}`), current => {
      if (!current || current.status !== 'pending_activation') return;
      return { ...current, status: 'approved', credId: credential.id };
    });
    if (!activated.committed) { await db.ref(`credentials/${uid}`).remove(); p.fail('لم يعد التفعيل مسموحًا', 'permission-denied'); }
    await audit(uid, 'webauthn.register', member.companyId);
    return { registered: true, credentialId: credential.id };
  }
  const stored = await read(`credentials/${uid}`);
  if (!stored) p.fail('البصمة غير مسجلة');
  const result = await webauthn.verifyAuthenticationResponse({ response: data.response, expectedChallenge: challenge.challenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true, credential: { id: stored.id, publicKey: Buffer.from(stored.publicKey, 'base64'), counter: stored.counter, transports: stored.transports || [] } });
  if (!result.verified) p.fail('فشل التحقق', 'permission-denied');
  const advanced = await serverTransaction(db.ref(`credentials/${uid}`), current => {
    if (!current || current.id !== stored.id || current.counter !== stored.counter) return;
    return { ...current, counter: result.authenticationInfo.newCounter };
  });
  if (!advanced.committed) p.fail('تعارض التحقق، أعد المحاولة', 'aborted');
  const proof = randomUUID();
  await db.ref(`proofs/${uid}/${proof}`).set({ intent: challenge.intent, missionKey: challenge.missionKey || null, version: member.version, expiresAt: now + 60000 });
  return { proof };
  });
});
exports.recordAttendance = endpoint(['employee'], async ({ uid, member, info, data }) => {
  const cid = member.companyId, eid = member.employeeId, employee = await employeeContext(uid, member);
  if (employee.status !== 'approved') p.fail('سجّل البصمة أولًا');
  const type = data.type;
  if (!['in', 'out', 'departure', 'return', 'mission_start', 'mission_end'].includes(type)) p.fail('نوع غير صالح', 'invalid-argument');
  const missionKey = data.missionKey ? p.key(data.missionKey) : null;
  const settings = await read(`companies/${cid}/settings`), wh = await read(`companies/${cid}/warehouses/${p.key(employee.warehouseId)}`);
  if (!wh?.active) p.fail('الفرع غير متاح');
  const now = new Date(), clock = p.dateParts(now, info.timeZone), stamp = now.toISOString();
  const sched = employee.schedule || wh.schedule || settings;
  let delayMins = 0;
  if (type === 'in' || type === 'out') {
    const day = new Date(`${clock.date}T12:00:00Z`).getUTCDay();
    const weekends = settings?.weekendDays || [5];
    if (Object.values(weekends).includes(day) || Object.values(settings?.holidays || {}).some(h => h.active !== false && h.date === clock.date)) p.fail('اليوم عطلة');
    if (!p.insideWindow(clock.minutes, sched[type === 'in' ? 'checkIn' : 'checkOut'])) throw new p.PolicyError('failed-precondition', 'انتهت نافذة التسجيل أو لم تبدأ بعد. تمت إعادة مزامنة وقت الخادم؛ راجع الوقت المعروض.', { reason:'attendance-window', serverTime:Date.now(), timeZone:info.timeZone });
    if (type === 'in') delayMins = (clock.minutes - p.minutes(sched.checkIn.from) + 1440) % 1440;
  }
  let mission;
  if (type.startsWith('mission_')) {
    mission = await read(`companies/${cid}/missions/${missionKey}`);
    if (!mission || mission.empId !== eid || mission.date !== clock.date || (type === 'mission_start' ? !['assigned', 'pending'].includes(mission.status) : mission.status !== 'started')) p.fail('المهمة غير متاحة');
  }
  if (type === 'departure' || type === 'return') {
    const leave = await read(`companies/${cid}/todayPartialLeave/${eid}`);
    if (!leave || leave.status !== 'approved' || leave.date !== clock.date || !p.insideWindow(clock.minutes, { from: leave.fromTime, to: leave.toTime })) p.fail('لا توجد إجازة زمنية معتمدة لهذا الوقت');
  }
  const zone = wh.geoZone && wh.geoZone.enabled !== false ? wh.geoZone : settings?.geoZone?.enabled ? settings.geoZone : null;
  // Missions do not implicitly bypass a geofence. Configure their approved coordinates explicitly.
  const coords = p.location(data.location, mission?.geoZone || zone);
  const proofRef = db.ref(`proofs/${uid}/${p.key(data.proof)}`);
  const used = await serverTransaction(proofRef, proof => {
    if (!proof || proof.used || proof.expiresAt <= Date.now() || proof.version !== member.version || proof.intent !== type || (proof.missionKey || null) !== missionKey) return;
    return { ...proof, used: true };
  });
  if (!used.committed) p.fail('إثبات البصمة غير صالح أو مستخدم', 'permission-denied');
  const eventId = type.startsWith('mission_') ? `${type}_${missionKey}` : type;
  const event = { empId: eid, empName: employee.name, warehouseId: employee.warehouseId, warehouseName: wh.name, type, timestamp: stamp, dateKey: clock.date, ...coords, delayMins, locStatus: 'approved', locationValidation:'server_geofence', actor: uid, ...(missionKey ? { missionKey } : {}) };
  let conflict;
  const ledger = await serverTransaction(db.ref(`attendanceLedger/${cid}/${eid}/${clock.date}`), state => {
    if (state?.events?.[eventId]) { conflict = new p.PolicyError('already-exists', 'العملية مسجلة مسبقًا'); return; }
    try { if (!type.startsWith('mission_')) p.transition(state, type); } catch (error) { conflict = error; return; }
    if (Object.keys(state?.events || {}).length >= 64) return;
    return { ...state, revision: (state?.revision ?? Object.keys(state?.events || {}).length) + 1, events: { ...state?.events, [eventId]: event } };
  });
  if (!ledger.committed) throw conflict || new p.PolicyError('resource-exhausted', 'حد العمليات اليومية');
  return { ok: true, timestamp: stamp, date: clock.date };
});
// The ledger is authoritative. Trigger retries rebuild projections after interrupted writes.
exports.projectAttendance = onValueWritten({ ref: '/attendanceLedger/{cid}/{eid}/{date}', region, retry: true }, async event => {
  const { cid, eid, date } = event.params;
  const state = await read(`attendanceLedger/${cid}/${eid}/${date}`);
  if (!state) return;
  const revision = state.revision || Object.keys(state.events || {}).length;
  const updates = {}, today = { dateKey: date, empId: eid, ledgerRevision: revision, ...p.attendanceSummary(state) };
  for (const [id, value] of Object.entries(state.events || {})) {
    const recordId = `${date}_${eid}_${id}`;
    // Existing reviewed records are not overwritten on subsequent events or trigger retries.
    const existing = await read(`companies/${cid}/records/${recordId}`);
    if (!existing) updates[`companies/${cid}/records/${recordId}`] = value;
    if (value.type === 'in') Object.assign(today, { checkIn: value.timestamp, empName: value.empName, warehouseId: value.warehouseId, warehouseName: value.warehouseName, locationName: value.locationName, delayMins: value.delayMins });
    if (value.type === 'out') today.checkOut = value.timestamp;
    if (['departure', 'return'].includes(value.type)) updates[`companies/${cid}/partialLeaveRecords/${eid}/${date}/${value.type === 'departure' ? 'departureAt' : 'returnAt'}`] = value.timestamp;
    if (value.missionKey) {
      await serverTransaction(db.ref(`companies/${cid}/missions/${value.missionKey}`), mission => {
        if (!mission || (mission.status === 'completed' && value.type === 'mission_start')) return;
        return { ...mission, status:value.type === 'mission_start' ? 'started' : 'completed', [value.type === 'mission_start' ? 'startedAt' : 'completedAt']:value.timestamp };
      });
    }
    updates[`audit/attendance_${cid}_${recordId}`] = { actor: value.actor, action: 'attendance.record', target: `${cid}/${eid}`, at: Date.parse(value.timestamp), type: value.type };
  }
  // Prevent a delayed previous-day trigger from overwriting the current day.
  await db.ref(`companies/${cid}/today/${eid}`).transaction(old => {
    if (old?.dateKey && old.dateKey > date) return;
    if (old?.dateKey === date && old.ledgerRevision > revision) return;
    return today;
  });
  await db.ref().update(updates);
});
exports.submitRequest = endpoint(['employee'], async ({ uid, member, info, data }) => {
  const employee = await employeeContext(uid, member), cid = member.companyId, eid = member.employeeId;
  const record = { empId: eid, empName: employee.name, warehouseId: employee.warehouseId, warehouseName: employee.warehouseName, status: 'pending', createdAt: Date.now() };
  let collection;
  if (data.kind === 'leave') {
    if (!['paid', 'unpaid', 'sick', 'emergency', 'partial'].includes(data.leaveType) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date || '') || Number.isNaN(Date.parse(data.date))) p.fail('طلب غير صالح', 'invalid-argument');
    p.validateLeaveDate(data.date, data.leaveType === 'partial', record.createdAt, info.timeZone);
    Object.assign(record, { date: data.date, reason: p.text(data.reason, 'السبب', 2000), leaveType: data.leaveType, isPartial: data.leaveType === 'partial' });
    if (record.isPartial) { if (p.minutes(data.fromTime) >= p.minutes(data.toTime)) p.fail('فترة غير صالحة'); Object.assign(record, { fromTime: data.fromTime, toTime: data.toTime }); }
    collection = 'leaves';
  } else if (data.kind === 'excuse') {
    collection = 'excuses';
    if (!['no_checkin','no_checkout','no_both'].includes(data.type)) p.fail('نوع عذر غير صالح', 'invalid-argument');
    Object.assign(record, { reason: p.text(data.reason, 'السبب', 2000), type: data.type, date: p.dateParts(new Date(record.createdAt), info.timeZone).date, dateSource:'server', dateTimeZone:info.timeZone });
  } else p.fail('طلب غير صالح', 'invalid-argument');
  const id = collection === 'excuses' ? `excuse_${eid}_${record.date}` : db.ref().push().key;
  if (collection === 'excuses') {
    const created = await db.ref(`companies/${cid}/${collection}/${id}`).transaction(old => old ? undefined : record);
    if (!created.committed) p.fail('لديك طلب عذر لهذا اليوم بالفعل', 'already-exists');
  } else await db.ref(`companies/${cid}/${collection}/${id}`).set(record);
  await audit(uid, `request.${collection}`, `${cid}/${id}`);
  return { ok: true };
});
// Employee notifications (private message, broadcast, new mission) are server-written:
// the rules keep notification text immutable for every client, including the manager.
function messageText(value) {
  if (typeof value !== 'string') p.fail('اكتب نص الرسالة', 'invalid-argument');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text || text.length > 1000 || /[<>\u0000-\u0009\u000b-\u001f]/u.test(text)) p.fail('نص الرسالة غير صالح (حتى 1000 حرف، بدون < أو >)', 'invalid-argument');
  return text;
}
exports.sendNotification = endpoint(['manager'], async ({ uid, member, data }) => {
  const cid = member.companyId, kind = data.kind;
  if (!['private_msg', 'broadcast', 'mission'].includes(kind)) p.fail('نوع غير صالح', 'invalid-argument');
  const message = messageText(data.message);
  const employees = (await read(`companies/${cid}/employees`)) || {};
  let targets;
  if (kind === 'broadcast') targets = Object.keys(employees).filter(id => employees[id]?.status === 'approved');
  else { const eid = p.key(data.employeeId); if (employees[eid]?.status !== 'approved') p.fail('الموظف غير موجود أو غير مفعّل', 'not-found'); targets = [eid]; }
  if (!targets.length) p.fail('لا يوجد موظفون مفعّلون', 'failed-precondition');
  if (targets.length > 10000) p.fail('عدد الموظفين كبير', 'invalid-argument');
  const timestamp = new Date().toISOString(), updates = {};
  for (const eid of targets) updates[`companies/${cid}/notifications/${eid}/${db.ref().push().key}`] = { type: kind, message, timestamp, read: false };
  if (kind === 'private_msg') updates[`companies/${cid}/private_messages/${db.ref().push().key}`] = { empId: targets[0], empName: employees[targets[0]].name || '', message, createdAt: Date.now(), read: false };
  await db.ref().update(updates);
  await audit(uid, `notify.${kind}`, cid, { count: targets.length });
  return { ok: true, count: targets.length };
});
exports.changePassword = endpoint(allRoles, async ({ uid, token, member, data }) => {
  return withLock(uid, async () => {
  if (!Number.isFinite(token.auth_time) || Date.now() / 1000 - token.auth_time > 300) p.fail('سجّل الدخول مجددًا قبل تغيير كلمة المرور', 'unauthenticated');
  if (typeof data.password !== 'string' || data.password.length < 14 || data.password.length > 128) p.fail('كلمة المرور 14 حرفًا على الأقل', 'invalid-argument');
  const advanced = await serverTransaction(db.ref(`access/${uid}`), current => current?.enabled === true && current.version === member.version ? { ...current, enabled:false, version:current.version + 1 } : undefined);
  if (!advanced.committed) p.fail('تغيّرت الجلسة. سجّل الدخول مجددًا', 'unauthenticated');
  await auth.updateUser(uid, { password: data.password });
  await auth.revokeRefreshTokens(uid);
  await auth.setCustomUserClaims(uid, { version: member.version + 1 });
  await db.ref(`access/${uid}/enabled`).set(true);
  await audit(uid, 'password.change', uid);
  return { ok: true };
  });
});
exports.reviewRequest = endpoint(['manager'], async ({ uid, member, data }) => {
  const cid = member.companyId, id = p.key(data.id);
  if (!['leaves', 'excuses'].includes(data.collection) || !['approved', 'rejected'].includes(data.status)) p.fail('طلب غير صالح', 'invalid-argument');
  return withLock(`review_${createHash('sha256').update(`${cid}/${data.collection}/${id}`).digest('hex')}`, async () => {
  const request = await read(`companies/${cid}/${data.collection}/${id}`);
  if (!request) p.fail('الطلب غير موجود', 'not-found');
  if (request.status !== 'pending' && request.status !== data.status) p.fail('الطلب محسوم؛ تعديل القرار يتطلب إجراء تصحيح مستقل');
  if (data.collection === 'excuses' && data.status === 'approved') {
    if (request.dateSource !== 'server' || !Number.isFinite(request.createdAt) || !['no_checkin','no_checkout','no_both'].includes(request.type)) p.fail('العذر القديم يحتاج إلى إعادة تقديم من النسخة الآمنة');
    const date = p.dateParts(new Date(request.createdAt), request.dateTimeZone).date;
    const eid = p.key(request.empId), employee = await read(`companies/${cid}/employees/${eid}`);
    if (!employee) p.fail('الموظف غير موجود', 'not-found');
    const now = new Date().toISOString();
    let denial;
    const approved = await serverTransaction(db.ref(`attendanceLedger/${cid}/${eid}/${date}`), state => {
      if (state?.events?.excused) { denial='يوجد عذر معتمد لهذا اليوم'; return state.events.excused.requestId === id ? state : undefined; }
      if (state?.events?.in && ['no_checkin','no_both'].includes(request.type)) { denial='الحضور الفعلي مسجل؛ نوع العذر لا يطابق السجل'; return; }
      if (state?.events?.out && ['no_checkout','no_both'].includes(request.type)) { denial='الانصراف الفعلي مسجل؛ نوع العذر لا يطابق السجل'; return; }
      if (request.type === 'no_checkout' && !state?.events?.in) { denial='عذر عدم الانصراف يتطلب حضورًا مسجلًا'; return; }
      const event = { type:'excused', excuseType:request.type, requestId:id, actor:uid, empId:eid, empName:employee.name, warehouseId:request.warehouseId, warehouseName:request.warehouseName, timestamp:now, dateKey:date };
      return { ...state, revision:(state?.revision ?? Object.keys(state?.events || {}).length) + 1, events:{ ...state?.events, excused:event } };
    });
    if (!approved.committed) p.fail(denial || 'تعذر اعتماد العذر');
  }
  const updates = { [`companies/${cid}/${data.collection}/${id}/status`]: data.status };
  // Server-private, date-scoped projection. Commit together with the decision;
  // retries are idempotent, other dates/employees cannot overwrite this flag.
  if (data.collection === 'leaves' && data.status === 'approved' && !request.isPartial && request.leaveType !== 'partial') {
    const date = request.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) p.fail('تاريخ إجازة غير صالح', 'invalid-argument');
    updates[`fullDayLeaveIndex/${cid}/${p.key(request.empId)}/${date}`] = true;
  }
  if (data.collection === 'leaves' && request.isPartial) {
    updates[`companies/${cid}/todayPartialLeave/${request.empId}`] = data.status === 'approved' ? { status: 'approved', date: request.date, fromTime: request.fromTime, toTime: request.toTime, leaveKey: id, approvedAt: Date.now() } : null;
  }
  const note = { type: `${data.collection}_res`, message: data.status === 'approved' ? 'تم قبول طلبك' : 'تم رفض طلبك', read: false, timestamp: new Date().toISOString() };
  updates[`companies/${cid}/notifications/${request.empId}/${db.ref().push().key}`] = note;
  await db.ref().update(updates);
  await audit(uid, 'request.review', `${cid}/${id}`, { status: data.status });
  return { ok: true };
  });
});
exports.manualAttendance = endpoint(['manager'], async ({ uid, member, info, data }) => {
  const cid = member.companyId, eid = p.key(data.employeeId), reason = p.text(data.reason, 'سبب التعديل', 1000);
  const employee = await read(`companies/${cid}/employees/${eid}`);
  if (!employee) p.fail('الموظف غير موجود', 'not-found');
  if (!['present', 'absent'].includes(data.status)) p.fail('حالة غير صالحة', 'invalid-argument');
  const date = p.dateParts(new Date(), info.timeZone).date;
  await db.ref(`companies/${cid}/adjustments/${date}/${eid}`).set({ status: data.status, reason, actor: uid, at: Date.now() });
  await audit(uid, 'attendance.adjust', `${cid}/${eid}/${date}`, { status: data.status, reason });
  return { ok: true };
});
exports.cleanupSecurityState = onSchedule({ schedule: 'every 24 hours', region }, async () => {
  for (const root of ['challenges', 'proofs']) {
    // Cursor batches bound memory. Expired proofs are retained briefly for diagnosing replay attempts.
    let cursor;
    do {
      let query = db.ref(root).orderByKey().limitToFirst(100);
      if (cursor) query = query.startAfter(cursor);
      const users = await query.get();
      if (!users.exists()) break;
      const updates = {};
      users.forEach(user => { cursor = user.key; user.forEach(item => { if (item.val().expiresAt < Date.now() - 86400000) updates[`${root}/${user.key}/${item.key}`] = null; }); });
      if (Object.keys(updates).length) await db.ref().update(updates);
      if (users.numChildren() < 100) break;
    } while (cursor);
  }
  // Seller reminder: one notification per company and expiry date, during the last 7 days.
  // Create-if-absent: a plain transaction is safe here (null start → create; existing → abort).
  const now = Date.now(), soon = now + 7 * 86400000;
  let cursor;
  do {
    let query = db.ref('companyDirectory').orderByKey().limitToFirst(100);
    if (cursor) query = query.startAfter(cursor);
    const page = (await query.get()).val() || {}, ids = Object.keys(page);
    for (const cid of ids) {
      cursor = cid; const info = page[cid] || {};
      if (info.status === 'suspended' || !Number.isFinite(info.expiresAt) || info.expiresAt <= now || info.expiresAt > soon) continue;
      const day = new Date(info.expiresAt).toISOString().slice(0, 10);
      await db.ref(`seller/notifications/expiry_${cid}_${info.expiresAt}`).transaction(old => old ? undefined : { type: 'expiry', message: `⏰ اشتراك «${info.nameAr || cid}» ينتهي في ${day}`, timestamp: new Date().toISOString(), read: false });
    }
    if (ids.length < 100) break;
  } while (cursor);
});
exports.dailyBackup = onSchedule({ schedule: 'every day 02:00', timeZone: 'UTC', region, timeoutSeconds: 540, memory: '1GiB', maxInstances: 1 }, async () => {
  const name = backupBucket.value();
  if (!name) throw new Error('BACKUP_BUCKET must reference a private bucket.');
  const bucket = getStorage().bucket(name), [metadata] = await bucket.getMetadata();
  if (metadata.iamConfiguration?.publicAccessPrevention !== 'enforced' || metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) throw new Error('Backup bucket must enforce public access prevention and uniform bucket-level IAM.');
  const prefix = `basma/${new Date().toISOString().slice(0,10)}/${randomUUID()}`, files = [];
  for (const collection of ['companies','privatePayroll','attendanceLedger','fullDayLeaveIndex','access','credentials','employeeIndex','accountLinks','audit']) {
    let cursor, pageNumber = 0;
    do {
      let query = db.ref(collection).orderByKey().limitToFirst(100);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      if (!snapshot.exists()) break;
      const bytes = Buffer.from(JSON.stringify(snapshot.val())), fileName = `${prefix}/${collection}-${pageNumber++}.json`;
      await bucket.file(fileName).save(bytes, { resumable: false, gzip: true, metadata: { contentType:'application/json', cacheControl:'no-store' } });
      files.push({ fileName, sha256:createHash('sha256').update(bytes).digest('hex'), collection });
      snapshot.forEach(item => { cursor = item.key; });
      if (snapshot.numChildren() < 100) break;
    } while (cursor);
  }
  // A manifest exists only for a completed backup. Firebase Auth must be exported separately.
  await bucket.file(`${prefix}/manifest.json`).save(JSON.stringify({ format:'basma-backup-v1', at:new Date().toISOString(), files, authIncluded:false }), { resumable:false, metadata:{contentType:'application/json',cacheControl:'no-store'} });
  console.info('backup_complete', { prefix, files:files.length });
});
