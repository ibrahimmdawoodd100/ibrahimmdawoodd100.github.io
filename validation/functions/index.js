'use strict';
const { randomUUID, createHash, randomBytes, generateKeyPairSync, createPrivateKey, sign: edSign } = require('node:crypto');
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
const rules = require('./report-model'); // same file as public/assets/report-model.js (test-checked)
initializeApp();
const db = getDatabase(), auth = getAuth();
const rpID = defineString('WEBAUTHN_RP_ID');
const originList = defineString('WEBAUTHN_ORIGINS');
const backupBucket = defineString('BACKUP_BUCKET', { default: '' });
const region = 'us-central1';
const read = async path => (await db.ref(path).get()).val();
const audit = (actor, action, target, details = {}) => db.ref('audit').push({ actor, action, target, details, at: Date.now() });
function endpoint(roles, handler) {
  // v5.16 cost guards: explicit 1 vCPU / 256 MiB / 80 concurrent requests (as live), max 10 instances, no min
  // instances, 30 s timeout (calls take 30-500 ms; a stuck call no longer bills 60 s).
  return onCall({ region, enforceAppCheck: true, maxInstances: 10, concurrency: 80, cpu: 1, memory: '256MiB', timeoutSeconds: 30 }, async req => {
    try {
      if (!req.auth) p.fail('سجّل الدخول', 'unauthenticated');
      const member = await read(`access/${req.auth.uid}`);
      const info = member?.companyId ? await read(`companies/${member.companyId}/info`) : null;
      p.authorize(member, req.auth.token, info, roles);
      const employee = member.role === 'employee' ? await employeeContext(req.auth.uid, member) : null;
      const now = Date.now(), bucket = Math.floor(now / 60000);
      // Per login: 90 calls per minute AND 600 per hour (same counter record), so a stolen account cannot run up costs.
      const hour = Math.floor(now / 3600000);
      const rate = await db.ref(`rateLimits/${req.auth.uid}`).transaction(old => {
        const state = old?.bucket === bucket ? old : { bucket, count: 0, hour: old?.hour, hourCount: old?.hourCount, expiresAt: now + 3700000 };
        const hourCount = state.hour === hour ? state.hourCount || 0 : 0;
        return state.count >= 90 || hourCount >= 600 ? undefined : { ...state, count: state.count + 1, hour, hourCount: hourCount + 1, expiresAt: now + 3700000 };
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
// The same session fields as the profile endpoint, so a page can open with ONE call (one cold start, not two).
const sessionOf = (member, info) => ({ role: member.role, companyId: member.companyId || null, employeeId: member.employeeId || null, name: info?.nameAr || 'بصمة', timeZone: info?.timeZone || 'UTC' });
exports.profile = endpoint(allRoles, async ({ member, info }) => ({ role: member.role, companyId: member.companyId || null, employeeId: member.employeeId || null, name: info?.nameAr || 'بصمة', timeZone:info?.timeZone || 'UTC', serverTime:Date.now() }));
exports.serverClock = endpoint(allRoles, async () => ({ serverTime:Date.now() }));
// Narrow home projection: never return coworkers, request history or notifications.
exports.employeeHome = endpoint(['employee'], async ({uid,member,info,employee}) => {
  const cid=member.companyId,eid=member.employeeId,stamp=Date.now();
  const date=p.dateParts(new Date(stamp),info.timeZone).date;
  const [settings,warehouse,today,fullLeave,credential,scheduleVersion]=await Promise.all([
    read(`companies/${cid}/settings`),read(`companies/${cid}/warehouses/${p.key(employee.warehouseId)}`),read(`companies/${cid}/today/${eid}`),
    read(`fullDayLeaveIndex/${cid}/${eid}/${date}`),read(`credentials/${uid}`),read(`scheduleVersions/${cid}`)
  ]);
  const device=credential?{status:await deviceState(cid,eid,credential.id)}:{status:'none'};
  const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
  return {serverTime:Date.now(),date,employee:pick(employee,['name','empId','role','warehouseId','warehouseName','status','credId','schedule','workDays','geoZone']),
    workDays:rules.workDaysOf(settings||{},warehouse,employee),startTime:rules.startTimeOf(settings||{},warehouse,employee),
    info:pick(info,['nameAr','nameEn','name','logo','timeZone','status']),
    settings:pick(settings,['checkIn','checkOut','weekendDays','holidays','geoZone']),
    warehouse:pick(warehouse,['name','active','schedule','geoZone']),today:today?.dateKey===date?today:{},
    onLeave:fullLeave === true,device,scheduleVersion:scheduleVersion??0,profile:sessionOf(member,info)};
});
// Manager dashboard in ONE call (like listCompanies for the seller): the page no longer depends on many direct
// database reads, which stall forever on networks where the database connection does not establish.
// Company isolation: everything is read from member.companyId (the server-side access record), never from data.
const MANAGER_EMPLOYEE_FIELDS = ['name', 'empId', 'role', 'warehouseId', 'warehouseName', 'status', 'schedule', 'createdAt', 'workDays', 'disabledAt', 'geoZone', 'branchHistory'];
// Badge counts as keys only (no content) plus company status: pending leaves/excuses, assigned/started missions,
// unread activity notifications. Sent inside managerHome (no extra call on open) and by managerList 'badges'.
async function badgesOf(cid) {
  const keys = (collection, field, value) => db.ref(`companies/${cid}/${collection}`).orderByChild(field).equalTo(value).limitToFirst(5000).get().then(snap => { const order = []; snap.forEach(child => { order.push(child.key); }); return order; });
  const [leaves, excuses, assigned, started, unread, status] = await Promise.all([keys('leaves', 'status', 'pending'), keys('excuses', 'status', 'pending'), keys('missions', 'status', 'assigned'), keys('missions', 'status', 'started'), keys('notifications/admin', 'read', false), read(`companies/${cid}/info/status`)]);
  const devices = Object.entries((await read(`deviceApprovals/${cid}`)) || {}).filter(([, d]) => d?.status === 'pending').map(([eid]) => eid);
  return { status: status ?? null, leaves, excuses, assigned, started, unread, devices };
}
exports.managerHome = endpoint(['manager'], async ({ member, info }) => {
  const cid = member.companyId, stamp = Date.now(), date = p.dateParts(new Date(stamp), info.timeZone).date;
  const sameDay = (collection, field) => db.ref(`companies/${cid}/${collection}`).orderByChild(field).equalTo(date).limitToFirst(20000).get().then(s => s.val() || {});
  const [settings, warehouses, employees, records, leaves, excuses, badges] = await Promise.all([
    read(`companies/${cid}/settings`), read(`companies/${cid}/warehouses`), read(`companies/${cid}/employees`),
    sameDay('records', 'dateKey'), sameDay('leaves', 'date'), sameDay('excuses', 'date'), badgesOf(cid)
  ]);
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
  const staff = Object.fromEntries(Object.entries(employees || {}).map(([eid, e]) => [eid, pick(e, MANAGER_EMPLOYEE_FIELDS)]));
  return { serverTime: Date.now(), date, companyId: cid,
    info: pick(info, ['nameAr', 'nameEn', 'logo', 'industry', 'timeZone', 'status', 'expiresAt', 'maxEmployees', 'plan']),
    settings: settings || {}, warehouses: warehouses || {}, employees: staff, records: Object.fromEntries(Object.entries(records || {}).map(([id, r]) => [id, pick(r, RECORD_FIELDS)])), leaves, excuses, badges, profile: sessionOf(member, info) };
});
// Manager attendance records, reports, payroll and request lists through ONE call per range (no direct database
// reads, which stall on networks where the realtime connection does not establish). Indexed queries only
// (records.dateKey, leaves/excuses.date and .status), the manager's own company only, compact record fields.
const RECORD_FIELDS = ['empId', 'empName', 'type', 'timestamp', 'dateKey', 'warehouseId', 'warehouseName', 'locStatus', 'excuseType', 'delayMins', 'locationName', 'missionKey'];
function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) p.fail('تاريخ غير صالح', 'invalid-argument');
  return value;
}
exports.managerRecords = endpoint(['manager'], async ({ member, data }) => {
  const cid = member.companyId, MAX = 20000;
  const query = (collection, field, from, to) => db.ref(`companies/${cid}/${collection}`).orderByChild(field).startAt(from).endAt(to).limitToFirst(MAX + 1).get().then(s => s.val() || {});
  const bounded = value => { if (Object.keys(value).length > MAX) p.fail('عدد السجلات كبير؛ اختر فترة أقصر', 'invalid-argument'); return value; };
  if (data.kind === 'requests') {
    if (!['leaves', 'excuses'].includes(data.collection) || !/^\d{4}-\d{2}$/.test(data.month || '')) p.fail('طلب غير صالح', 'invalid-argument');
    const from = isoDay(`${data.month}-01`), [y, m] = data.month.split('-').map(Number), to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const [history, pending] = await Promise.all([query(data.collection, 'date', from, to), query(data.collection, 'status', 'pending', 'pending')]);
    return { month: data.month, items: { ...bounded(history), ...bounded(pending) } };
  }
  const from = isoDay(data.from), to = isoDay(data.to);
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 30) p.fail('اختر فترة لا تتجاوز 31 يومًا', 'invalid-argument');
  const [records, leaves, excuses] = await Promise.all([query('records', 'dateKey', from, to), query('leaves', 'date', from, to), query('excuses', 'date', from, to)]);
  const pick = value => Object.fromEntries(RECORD_FIELDS.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
  return { from, to, records: Object.fromEntries(Object.entries(bounded(records)).map(([id, r]) => [id, pick(r)])), leaves: bounded(leaves), excuses: bounded(excuses) };
});
// Manager list pages (employees, branches, messages, missions, admin notifications, settings) through one small call
// per page instead of direct database reads. Own company only, compact fields, key cursor: employees and branches in
// key order (next page after the cursor), messages/missions/notifications newest first (next page before the cursor).
const LIST_PAGES = {
  employees: { path: 'employees', size: 200, fields: MANAGER_EMPLOYEE_FIELDS, newest: false },
  warehouses: { path: 'warehouses', size: 200, fields: ['name', 'active', 'schedule', 'geoZone', 'workDays'], newest: false },
  messages: { path: 'private_messages', size: 50, fields: ['empId', 'empName', 'message', 'read', 'createdAt'], newest: true },
  missions: { path: 'missions', size: 100, fields: ['empId', 'empName', 'location', 'description', 'date', 'expectedTime', 'status', 'assignedAt', 'startedAt', 'completedAt'], newest: true },
  notifications: { path: 'notifications/admin', size: 50, fields: ['type', 'message', 'timestamp', 'read'], newest: true }
};
// Owner decisions 2/4/5 + closed months: payroll for months from rules.RULES_FROM is computed HERE (same rules file as
// the pages). After the 5-day grace a closed month is saved once (payrollSnapshots) and never recalculated.
async function computePayrollMonth(cid, zone, month) {
  const today = companyToday(zone), [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const from = `${month}-01`, to = last < today ? last : today, range = (c, field) => db.ref(`companies/${cid}/${c}`).orderByChild(field).startAt(from).endAt(to).limitToFirst(40001).get().then(x => x.val() || {});
  const [employees, settings, warehouses, salaries, records, leaves, excuses] = await Promise.all([read(`companies/${cid}/employees`), read(`companies/${cid}/settings`), read(`companies/${cid}/warehouses`), read(`privatePayroll/${cid}`), range('records', 'dateKey'), range('leaves', 'date'), range('excuses', 'date')]);
  if (Object.keys(records).length > 40000) p.fail('عدد السجلات كبير جدًا لهذا الشهر', 'resource-exhausted');
  const staff = employees || {}, rows = rules.build({ records, employees: staff, leaves, excuses, settings: settings || {}, warehouses: warehouses || {}, from, to, timeZone: zone, today });
  const result = rules.payrollV2(rows, staff, salaries || {}, { month, settings: settings || {}, warehouses: warehouses || {}, timeZone: zone });
  const compact = r => ({ employeeId: r.employeeId, name: r.name, empId: r.empId, salary: r.salary, due: r.due, deductPct: r.deductPct, absentDays: r.absentDays, workingDays: r.workingDays, employedDays: r.employedDays, deduction: r.deduction, net: r.net,
    days: r.days.map(d => ({ date: d.date, statusLabel: d.statusLabel, delayMins: d.delayMins || 0 })) });
  return { month, rows: result.rows.map(compact), missing: result.missing.map(eid => staff[eid]?.name || eid), rules: 'v2', to };
}
async function payrollMonth(cid, info, month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) p.fail('اختر الشهر', 'invalid-argument');
  if (`${month}-01` < rules.RULES_FROM) throw new p.PolicyError('failed-precondition', 'رواتب هذا الشهر بالقواعد السابقة', { reason: 'v1-month' });
  const zone = info.timeZone, today = companyToday(zone);
  if (month > today.slice(0, 7)) p.fail('لا يمكن احتساب شهر مستقبلي', 'invalid-argument');
  const [py, pm] = month.split('-').map(Number);
  if (purgeActive(zone) && new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10) < purgeCutoff(zone)) throw new p.PolicyError('failed-precondition', 'رواتب هذا الشهر محفوظة على جهاز المدير فقط', { reason: 'device-only' });
  const frozen = month < today.slice(0, 7) && !inLeaveGrace(`${month}-01`, zone);
  if (frozen) { const saved = await read(`payrollSnapshots/${cid}/${month}`); if (saved) return { ...saved, frozen: true }; }
  const value = await computePayrollMonth(cid, zone, month);
  if (frozen) { await db.ref(`payrollSnapshots/${cid}/${month}`).transaction(old => old || { ...value, savedAt: Date.now() }); return { ...(await read(`payrollSnapshots/${cid}/${month}`)), frozen: true }; }
  return { ...value, frozen: false, closed: month < today.slice(0, 7), graceUntil: month < today.slice(0, 7) ? `${today.slice(0, 7)}-05` : null };
}
// One signed page of a collection, oldest first, from a date (cursor = last date + key). Own company only.
async function syncPage(cid, data) {
  const fields = { records: 'dateKey', leaves: 'date', excuses: 'date' };
  if (data.collection === 'payroll') return { items: signItems(cid, 'payroll', (await read(`payrollSnapshots/${cid}`)) || {}, await signingKey()), next: null };
  const field = fields[data.collection];
  if (!field) p.fail('طلب غير صالح', 'invalid-argument');
  const from = data.from == null ? '' : isoDay(data.from);
  let query = db.ref(`companies/${cid}/${data.collection}`).orderByChild(field);
  if (data.after) query = query.startAfter(String(data.after.date || ''), p.key(data.after.key)); else query = query.startAt(from);
  const raw = (await query.limitToFirst(SYNC_PAGE + 1).get()).val() || {};
  const entries = Object.entries(raw).sort(([ka, a], [kb, b]) => String(a?.[field] || '').localeCompare(String(b?.[field] || '')) || ka.localeCompare(kb));
  const page = entries.slice(0, SYNC_PAGE), more = entries.length > SYNC_PAGE, last = page.at(-1);
  const clean = data.collection === 'records' ? r => Object.fromEntries(RECORD_FIELDS.filter(k => r?.[k] !== undefined).map(k => [k, r[k]])) : r => r;
  const items = signItems(cid, data.collection, Object.fromEntries(page.map(([id, v]) => [id, clean(v)])), await signingKey());
  return { items, next: more && last ? { date: last[1]?.[field] || '', key: last[0] } : null };
}
exports.managerList = endpoint(['manager'], async ({ member, info, data }) => {
  const cid = member.companyId;
  if (data.kind === 'settings') return { settings: (await read(`companies/${cid}/settings`)) || {} };
  // v5.11: the remaining small manager reads (company status, one employee's payroll, badge counts).
  if (data.kind === 'status') return { value: (await read(`companies/${cid}/info/status`)) ?? null };
  if (data.kind === 'payrollMonth') return payrollMonth(cid, info, data.month);
  if (data.kind === 'syncKeys') {
    const [signing, store] = await Promise.all([signingKey(), storeKey(cid)]);
    return { companyId: cid, publicKey: signing.publicKey, storeKey: store.key, keepDays: KEEP_DAYS, purgeStart: PURGE_START, cutoff: purgeCutoff(info.timeZone), today: companyToday(info.timeZone) };
  }
  if (data.kind === 'sync') return syncPage(cid, { ...data, from: data.from === 'mailbox' ? daysBefore(companyToday(info.timeZone), KEEP_DAYS + 2) : data.from });
  // One call per open (cost guard): keys + the first page of every collection + the acknowledgement of the last pull.
  if (data.kind === 'syncAll') {
    const from = data.from || {}, mailbox = daysBefore(companyToday(info.timeZone), KEEP_DAYS + 2), pick = v => (v === 'mailbox' ? mailbox : v ?? null);
    if (data.ack?.syncedTo) {
      const state = { lastPullAt: Date.now(), syncedTo: isoDay(data.ack.syncedTo) };
      if (Number.isFinite(data.ack.lastBackupAt) && data.ack.lastBackupAt <= Date.now()) state.lastBackupAt = data.ack.lastBackupAt;
      await db.ref(`companies/${cid}/syncState`).update(state);
    }
    const [signing, store, records, leaves, excuses, payroll] = await Promise.all([signingKey(), storeKey(cid), ...['records', 'leaves', 'excuses'].map(c => syncPage(cid, { collection: c, from: pick(from[c]) })), syncPage(cid, { collection: 'payroll' })]);
    return { keys: { companyId: cid, publicKey: signing.publicKey, storeKey: store.key, keepDays: KEEP_DAYS, purgeStart: PURGE_START, cutoff: purgeCutoff(info.timeZone), today: companyToday(info.timeZone) }, pages: { records, leaves, excuses, payroll } };
  }
  if (data.kind === 'syncAck') {
    const now = Date.now(), state = { lastPullAt: now, syncedTo: isoDay(data.syncedTo) };
    if (Number.isFinite(data.lastBackupAt) && data.lastBackupAt <= now) state.lastBackupAt = data.lastBackupAt;
    await db.ref(`companies/${cid}/syncState`).update(state);
    return { ok: true };
  }
  if (data.kind === 'employeeLog') {
    const eid = p.key(data.employeeId);
    const items = (await db.ref(`employeeLog/${cid}/${eid}`).orderByKey().limitToLast(50).get()).val() || {};
    return { items };
  }
  if (data.kind === 'payrollAll') {
    const all = (await read(`privatePayroll/${cid}`)) || {};
    return { items: Object.fromEntries(Object.entries(all).map(([eid, v]) => [eid, { salary: v?.salary ?? null, deductionPercent: v?.deductionPercent ?? null }])) };
  }
  if (data.kind === 'monthVersions') {
    const months = Array.isArray(data.months) ? data.months : [];
    if (!months.length || months.length > 12 || months.some(m => typeof m !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m))) p.fail('أشهر غير صالحة', 'invalid-argument');
    const values = await Promise.all(months.map(m => read(`recordsVersions/${cid}/${m}`)));
    return { versions: Object.fromEntries(months.map((m, i) => [m, values[i] ?? 0])) };
  }
  if (data.kind === 'devices') {
    const all = (await read(`deviceApprovals/${cid}`)) || {};
    const items = Object.fromEntries(Object.entries(all).filter(([, d]) => d?.status === 'pending').map(([eid, d]) => [eid, { status: d.status, label: d.label || '', registeredAt: d.registeredAt || null }]));
    return { order: Object.keys(items), items };
  }
  if (data.kind === 'deviceLog') return ordered(db.ref(`deviceLog/${cid}/${p.key(data.employeeId)}`).orderByKey().limitToLast(20));
  if (data.kind === 'employeeToday') return { value: (await read(`companies/${cid}/today/${p.key(data.employeeId)}`)) ?? null };
  if (data.kind === 'payroll') return { value: (await read(`privatePayroll/${cid}/${p.key(data.employeeId)}`)) ?? null };
  if (data.kind === 'badges') return badgesOf(cid);
  const spec = Object.hasOwn(LIST_PAGES, data.kind) ? LIST_PAGES[data.kind] : p.fail('قائمة غير معروفة', 'invalid-argument');
  const cursor = data.cursor == null ? null : p.key(data.cursor);
  let query = db.ref(`companies/${cid}/${spec.path}`).orderByKey();
  if (spec.newest) query = (cursor ? query.endBefore(cursor) : query).limitToLast(spec.size + 1);
  else query = (cursor ? query.startAfter(cursor) : query).limitToFirst(spec.size + 1);
  const keys = [], values = {};
  (await query.get()).forEach(child => { keys.push(child.key); values[child.key] = child.val(); });
  const more = keys.length > spec.size, page = spec.newest ? keys.slice(-spec.size).reverse() : keys.slice(0, spec.size);
  const items = {};
  for (const id of page) if (values[id] && typeof values[id] === 'object') items[id] = Object.fromEntries(spec.fields.filter(k => values[id][k] !== undefined).map(k => [k, values[id][k]]));
  const result = { kind: data.kind, order: page, items, next: more ? page[page.length - 1] : null };
  if (data.kind === 'warehouses') {
    // Approved staff per branch from the indexed status query (no employee details sent).
    const counts = {};
    (await db.ref(`companies/${cid}/employees`).orderByChild('status').equalTo('approved').get()).forEach(child => { const w = child.val()?.warehouseId; if (typeof w === 'string' && Object.hasOwn(items, w)) counts[w] = (counts[w] || 0) + 1; });
    result.counts = counts;
  }
  return result;
});
// Branch changes through the server: the realtime write channel stalls on the same networks as the reads.
// Stricter than the database rules: own company, known branch, plain-text name, HH:MM times, real coordinates.
const hhmm = value => (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : p.fail('وقت غير صالح', 'invalid-argument'));
// Manager approves or rejects a pending fingerprint device. Reject = remove the credential; the employee registers
// again (and that new device again needs approval). The employee gets a notification either way.
exports.managerDevice = endpoint(['manager'], async ({ uid, member, data }) => {
  const cid = member.companyId, eid = p.key(data.employeeId);
  const entry = await read(`deviceApprovals/${cid}/${eid}`), employee = await read(`companies/${cid}/employees/${eid}`);
  if (!entry || !employee) p.fail('لا يوجد جهاز بانتظار الاعتماد لهذا الموظف', 'not-found');
  if (data.action === 'approve') {
    if (entry.status !== 'pending') p.fail('الجهاز معتمد مسبقًا', 'already-exists');
    const credential = await read(`credentials/${entry.uid}`);
    if (!credential || credential.id !== entry.credId) p.fail('تغيّرت بصمة الموظف؛ حدّث الصفحة', 'aborted');
    await db.ref(`deviceApprovals/${cid}/${eid}`).update({ status: 'approved', approvedAt: Date.now(), approvedBy: uid });
    await db.ref(`companies/${cid}/notifications/${eid}`).push({ type: 'device_ok', message: '✅ اعتمد المدير جهازك؛ يمكنك تسجيل الحضور الآن', timestamp: new Date().toISOString(), read: false });
  } else if (data.action === 'reject') {
    await db.ref(`credentials/${entry.uid}`).remove();
    await db.ref(`deviceApprovals/${cid}/${eid}`).remove();
    await db.ref(`companies/${cid}/employees/${eid}`).update({ status: 'pending_activation', credId: null });
    await db.ref(`companies/${cid}/notifications/${eid}`).push({ type: 'device_rejected', message: '❌ رفض المدير الجهاز الجديد؛ سجّل البصمة من جهازك المعتمد أو راجع المدير', timestamp: new Date().toISOString(), read: false });
  } else p.fail('عملية غير معروفة', 'invalid-argument');
  await deviceLog(cid, eid, data.action === 'approve' ? 'approved' : 'rejected', { by: uid, label: entry.label || '' });
  await bumpVersion(cid);
  await audit(uid, `device.${data.action}`, `${cid}/${eid}`);
  return { ok: true };
});
exports.managerBranch = endpoint(['manager'], async ({ uid, member, data }) => {
  const cid = member.companyId, all = db.ref(`companies/${cid}/warehouses`);
  if (data.action === 'add') {
    const ref = all.push();
    await ref.set({ name: p.text(data.name, 'اسم الفرع', 80), active: true });
    await audit(uid, 'branch.add', `${cid}/${ref.key}`);
    await bumpVersion(cid);
    return { id: ref.key };
  }
  const id = p.key(data.id), ref = all.child(id);
  if (!(await ref.child('name').get()).exists()) p.fail('الفرع غير موجود', 'not-found');
  if (data.action === 'rename') await ref.update({ name: p.text(data.name, 'اسم الفرع', 80) });
  else if (data.action === 'delete') {
    // Owner decision 10: a branch that still has employees cannot be deleted (their check-in would stop).
    const staff = Object.values((await read(`companies/${cid}/employees`)) || {}).filter(e => e?.warehouseId === id && e.status !== 'rejected').length;
    if (staff) p.fail(`في الفرع ${staff} موظف؛ انقلهم إلى فرع آخر أولًا`, 'failed-precondition');
    await ref.remove();
  }
  else if (data.action === 'schedule') {
    if (data.schedule == null) await ref.child('schedule').remove();
    else {
      const startTime = optionalTime(data.schedule.startTime), workDays = workDaysValue(data.schedule.workDays);
      await ref.child('schedule').set({ ...dayPair(data.schedule.checkIn, data.schedule.checkOut), ...(startTime ? { startTime } : {}) });
      await ref.child('workDays').set(workDays);
    }
  } else if (data.action === 'geoZone') {
    const { lat, lng, radius } = data.geoZone || {};
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180 || !Number.isFinite(radius) || radius < 1 || radius > 100000) p.fail('موقع غير صالح', 'invalid-argument');
    await ref.child('geoZone').set({ lat, lng, radius: Math.round(radius), enabled: true });
  } else p.fail('عملية غير معروفة', 'invalid-argument');
  await bumpVersion(cid);
  await audit(uid, `branch.${data.action}`, `${cid}/${id}`);
  return { id };
});
// ---- v5.11: the remaining page reads/writes through the server (the realtime channel stalls on the owner's network,
// and long polling is CSP-blocked). Same checks as every callable; company and employee come from the access record.
const isoDate = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : p.fail('تاريخ غير صالح', 'invalid-argument'));
const ordered = async query => { const order = [], items = {}; (await query.get()).forEach(child => { order.push(child.key); items[child.key] = child.val(); }); return { order, items }; };
// Read-receipt updates: only "<key>/read": true for existing items (removing a key only when it is not an object).
async function markRead(base, updates, { allowCleanup = false } = {}) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length > 500) p.fail('تحديث غير صالح', 'invalid-argument');
  const current = (await base.get()).val() || {}, out = {};
  for (const [path, value] of Object.entries(updates)) {
    const [key, field, extra] = path.split('/');
    p.key(key);
    if (field === 'read' && extra === undefined && value === true) { if (current[key] && typeof current[key] === 'object') out[`${key}/read`] = true; }
    else if (allowCleanup && field === undefined && value === null) { if (Object.hasOwn(current, key) && (!current[key] || typeof current[key] !== 'object')) out[key] = null; }
    else p.fail('تحديث غير صالح', 'invalid-argument');
  }
  if (Object.keys(out).length) await base.update(out);
  return { updated: Object.keys(out).length };
}
exports.employeeList = endpoint(['employee'], async ({ member, info, employee, data }) => {
  const cid = member.companyId, eid = member.employeeId, own = collection => db.ref(`companies/${cid}/${collection}`).orderByChild('empId').equalTo(eid).limitToLast(200);
  switch (data.kind) {
    case 'today': return { value: (await read(`companies/${cid}/today/${eid}`)) ?? null };
    case 'partialLeave': return { value: (await read(`companies/${cid}/todayPartialLeave/${eid}`)) ?? null };
    case 'partialRecords': return { value: (await read(`companies/${cid}/partialLeaveRecords/${eid}/${isoDate(data.date)}`)) ?? null };
    case 'missions': case 'leaves': case 'excuses': return ordered(own(data.kind));
    case 'history': {
      // Plus today's ledger events not projected yet (the trigger writes records a moment after check-in; opening
      // «سجلاتي» right after checking out showed nothing — E2E v5.13). Same record ids as projectAttendance: no duplicates.
      const list = await ordered(own('records')), date = p.dateParts(new Date(), info.timeZone).date;
      const ledger = await read(`attendanceLedger/${cid}/${eid}/${date}`);
      for (const [id, value] of Object.entries(ledger?.events || {})) {
        const key = `${date}_${eid}_${id}`;
        if (value && typeof value === 'object' && !Object.hasOwn(list.items, key)) { list.items[key] = value; list.order.push(key); }
      }
      return list;
    }
    case 'notifications': return ordered(db.ref(`companies/${cid}/notifications/${eid}`).orderByKey().limitToLast(100));
    case 'notificationsUpdate': return markRead(db.ref(`companies/${cid}/notifications/${eid}`), data.updates, { allowCleanup: true });
    case 'version': return { value: (await read(`scheduleVersions/${cid}`)) ?? 0 };
    case 'status': return { value: info?.status ?? null };
    case 'selfStatus': return { value: employee?.status ?? null };
    default: p.fail('قائمة غير معروفة', 'invalid-argument');
  }
});
// Manager settings, holidays, company zones, employee schedules, missions and activity notifications.
const zone = z => {
  if (!z || typeof z !== 'object') p.fail('موقع غير صالح', 'invalid-argument');
  const { lat, lng, radius } = z;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180 || !Number.isFinite(radius) || radius < 1 || radius > 100000) p.fail('موقع غير صالح', 'invalid-argument');
  return { lat, lng, radius: Math.round(radius), name: z.name == null || z.name === '' ? '' : p.text(z.name, 'اسم النطاق', 80) };
};
const windowOf = w => ({ from: hhmm(w?.from), to: hhmm(w?.to) });
async function approvedEmployee(cid, eid) {
  const employee = await read(`companies/${cid}/employees/${p.key(eid)}`);
  if (!employee || employee.status !== 'approved') p.fail('الموظف غير موجود', 'not-found');
  return employee;
}
function missionFields(input, { partial }) {
  if (!input || typeof input !== 'object') p.fail('مهمة غير صالحة', 'invalid-argument');
  const out = {};
  if (!partial || input.location !== undefined) out.location = p.text(input.location, 'موقع المهمة', 200);
  if (input.description !== undefined && input.description !== '') out.description = p.text(input.description, 'وصف المهمة', 1000);
  else if (input.description === '') out.description = '';
  if (!partial || input.date !== undefined) out.date = isoDate(input.date);
  if (input.expectedTime !== undefined && input.expectedTime !== '') out.expectedTime = hhmm(input.expectedTime);
  else if (input.expectedTime === '') out.expectedTime = '';
  return out;
}
exports.managerSettings = endpoint(['manager'], async ({ uid, member, data }) => {
  const cid = member.companyId, settings = db.ref(`companies/${cid}/settings`);
  let target = cid;
  switch (data.action) {
    case 'timeWindows': await settings.update({ ...dayPair(data.checkIn, data.checkOut), startTime: optionalTime(data.startTime) }); break;
    case 'holidayAdd': { if (monthClosed(isoDate(data.date), member.timeZone || (await read(`companies/${cid}/info/timeZone`)))) p.fail('الشهر مغلق؛ لا تُضاف عطلة لتاريخ مضى', 'failed-precondition'); const ref = settings.child('holidays').push(); await ref.set({ date: isoDate(data.date), name: p.text(data.name, 'اسم العطلة', 80), active: true }); target = ref.key; break; }
    case 'holidayRemove': { target = p.key(data.id); const h = await read(`companies/${cid}/settings/holidays/${target}`); if (h?.date && monthClosed(h.date, await read(`companies/${cid}/info/timeZone`))) p.fail('الشهر مغلق؛ لا تُحذف عطلة منه', 'failed-precondition'); await settings.child(`holidays/${target}`).remove(); break; }
    case 'geoZone': {
      const g = data.geoZone;
      if (!g || typeof g.enabled !== 'boolean' || !Array.isArray(g.zones) || g.zones.length > 20) p.fail('موقع غير صالح', 'invalid-argument');
      await settings.child('geoZone').set({ enabled: g.enabled, zones: g.zones.map(zone) }); break;
    }
    case 'employeeSchedule': {
      target = p.key(data.employeeId);
      if (!(await read(`companies/${cid}/employees/${target}/name`))) p.fail('الموظف غير موجود', 'not-found');
      const ref = db.ref(`companies/${cid}/employees/${target}/schedule`);
      const emp = { child: k => db.ref(`companies/${cid}/employees/${target}/${k}`) }, oldZone = await read(`companies/${cid}/employees/${target}/geoZone`);
      if (data.schedule == null) {
        await ref.remove(); await emp.child('workDays').remove();
        // Removing the special schedule returns him to his branch location.
        if (oldZone) { await emp.child('geoZone').remove(); await employeeLog(cid, target, { type: 'location', actor: uid, from: zoneText(oldZone), to: 'branch' }); }
      }
      else {
        // v5.18: work location — omitted = unchanged (older page); 'branch'/null = his branch; {lat,lng,radius} = map point.
        if (data.schedule.location !== undefined) {
          const zone = specialZone(data.schedule.location);
          if (JSON.stringify(zoneText(zone)) !== JSON.stringify(zoneText(oldZone))) {
            await emp.child('geoZone').set(zone);
            await employeeLog(cid, target, { type: 'location', actor: uid, from: zoneText(oldZone), to: zoneText(zone) });
          }
        }
        const startTime = optionalTime(data.schedule.startTime), workDays = workDaysValue(data.schedule.workDays);
        await ref.set({ ...dayPair(data.schedule.checkIn, data.schedule.checkOut), ...(startTime ? { startTime } : {}) });
        await db.ref(`companies/${cid}/employees/${target}/workDays`).set(workDays);
      }
      break;
    }
    case 'adminNotificationsRead': return markRead(db.ref(`companies/${cid}/notifications/admin`), data.updates);
    case 'adminNotificationsClear': await db.ref(`companies/${cid}/notifications/admin`).remove(); break;
    case 'missionAdd': {
      const mission = missionFields(data.mission, { partial: false }), employee = await approvedEmployee(cid, data.mission?.empId);
      const ref = db.ref(`companies/${cid}/missions`).push();
      await ref.set({ empId: data.mission.empId, empName: employee.name || '', ...mission, status: 'assigned', assignedAt: new Date().toISOString() });
      target = ref.key; break;
    }
    case 'missionUpdate': {
      target = p.key(data.id);
      const ref = db.ref(`companies/${cid}/missions/${target}`), current = (await ref.get()).val();
      if (!current) p.fail('المهمة غير موجودة', 'not-found');
      const input = data.mission || {};
      if (input.status !== undefined) {
        if (input.status !== 'completed' || Object.keys(input).some(k => !['status', 'completedAt'].includes(k))) p.fail('مهمة غير صالحة', 'invalid-argument');
        await ref.update({ status: 'completed', completedAt: new Date().toISOString() }); break;
      }
      const update = missionFields(input, { partial: true });
      if (input.empId !== undefined && input.empId !== current.empId) { update.empId = input.empId; update.empName = (await approvedEmployee(cid, input.empId)).name || ''; }
      else if (input.empName !== undefined) update.empName = current.empName || '';
      if (Object.keys(input).some(k => !['location', 'description', 'date', 'expectedTime', 'empId', 'empName'].includes(k))) p.fail('مهمة غير صالحة', 'invalid-argument');
      await ref.update(update); break;
    }
    case 'missionRemove': target = p.key(data.id); await db.ref(`companies/${cid}/missions/${target}`).remove(); break;
    default: p.fail('عملية غير معروفة', 'invalid-argument');
  }
  if (['timeWindows', 'holidayAdd', 'holidayRemove', 'geoZone', 'employeeSchedule'].includes(data.action)) await bumpVersion(cid);
  await audit(uid, `settings.${data.action}`, `${cid}/${target}`);
  return { ok: true, id: target };
});
// Seller revenue and notifications (seller only).
exports.sellerData = endpoint(['seller'], async ({ uid, data }) => {
  switch (data.kind) {
    case 'transactions': return ordered(db.ref('seller/transactions').orderByKey().limitToLast(20000));
    case 'notifications': return ordered(db.ref('seller/notifications').orderByKey().limitToLast(500));
    case 'notificationsUpdate': return markRead(db.ref('seller/notifications'), data.updates);
    case 'addTransaction': {
      const t = data.transaction || {}, companyId = p.key(t.companyId);
      if (!Number.isFinite(t.amount) || t.amount <= 0 || t.amount > 1e9) p.fail('مبلغ غير صالح', 'invalid-argument');
      const info = await read(`companies/${companyId}/info`);
      if (!info) p.fail('الشركة غير موجودة', 'not-found');
      const dateStr = isoDate(t.dateStr), ref = db.ref('seller/transactions').push();
      await ref.set({ companyId, companyName: info.nameAr || '', plan: info.plan || 'starter', amount: t.amount, dateStr, date: Date.parse(`${dateStr}T00:00:00Z`), note: t.note ? p.text(t.note, 'ملاحظة', 500) : '', createdAt: Date.now() });
      await audit(uid, 'seller.transaction', ref.key);
      return { id: ref.key };
    }
    default: p.fail('عملية غير معروفة', 'invalid-argument');
  }
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
exports.projectCompanyDirectory = onValueWritten({ ref:'/companies/{cid}/info', region, retry:true, maxInstances: 2, timeoutSeconds: 60 }, async event => {
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
      await db.ref(`deviceApprovals/${cid}/${eid}`).remove(); await deviceLog(cid, eid, 'reset', { by: uid }); await bumpVersion(cid);
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
  const before = await read(`companies/${cid}/employees/${eid}`);
  if (!before) p.fail('الموظف غير موجود', 'not-found');
  await db.ref(`companies/${cid}/employees/${eid}`).update({ status: 'rejected', ...(before.status !== 'rejected' ? { disabledAt: Date.now() } : {}) });
  // Owner decision 10: a disabled employee no longer takes a seat in the plan.
  if (before.status !== 'rejected') await db.ref(`employeeIndex/${cid}`).transaction(index => {
    if (!index?.ids) return index;
    const hash = Object.keys(index.ids).find(h => index.ids[h] === eid);
    if (!hash) return index;
    delete index.ids[hash]; return { ...index, count: Math.max(0, (index.count || 1) - 1) };
  });
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
  const ref = db.ref(`companies/${cid}/employees/${eid}`), before = (await ref.get()).val();
  if (!before) p.fail('الموظف غير موجود', 'not-found');
  if (before.status === 'rejected') p.fail('الموظف معطّل؛ لا يُنقل', 'failed-precondition');
  if (before.warehouseId === warehouseId) p.fail('الموظف في هذا الفرع أصلًا', 'failed-precondition');
  const fromName = before.warehouseName || (await read(`companies/${cid}/warehouses/${before.warehouseId}/name`)) || '';
  // Permanent move (v5.18). Only the live assignment changes: past attendance/leave/payroll keep the old branch.
  // His special times and work days stay; his special map location is reset to the new branch. Device/fingerprint untouched.
  await ref.update({ warehouseId, warehouseName: warehouse.name, geoZone: null });
  await db.ref(`companies/${cid}/employees/${eid}/branchHistory`).push({ at: Date.now(), from: before.warehouseId || null, to: warehouseId });
  await employeeLog(cid, eid, { type: 'transfer', actor: uid, from: before.warehouseId || null, fromName, to: warehouseId, toName: warehouse.name, locationReset: !!before.geoZone });
  await bumpVersion(cid);
  await audit(uid, 'employee.transfer', `${cid}/${eid}`, { from: before.warehouseId, to: warehouseId });
  return { ok: true };
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
// ---- v5.15 devices and schedule version ----
// A newly registered fingerprint credential needs the manager's approval before it can record attendance.
// deviceApprovals/{cid}/{eid}: {status:'pending'|'approved', credId, uid, registeredAt, label, approvedAt, approvedBy}
// (server-only path). Credentials registered before v5.15 have no entry and stay valid.
async function deviceState(cid, eid, credId) {
  const entry = await read(`deviceApprovals/${cid}/${eid}`);
  if (!entry) return 'approved';
  return entry.status === 'approved' && entry.credId === credId ? 'approved' : 'pending';
}
const deviceLog = (cid, eid, event, details = {}) => db.ref(`deviceLog/${cid}/${eid}`).push({ event, at: Date.now(), ...details });
// One small value per company; open employee pages poll it (employeeList 'version') and re-read employeeHome on change.
const bumpVersion = cid => db.ref(`scheduleVersions/${cid}`).set(Date.now());
// ---- v5.17 business rules (owner decisions of 22 Nov 2026) ----
// A month closes by itself at its end (company time). For 5 days after that the manager may still decide LEAVE
// requests that were submitted on time; nothing else may change a closed month.
const companyToday = zone => p.dateParts(new Date(), zone).date;
const monthClosed = (date, zone) => String(date).slice(0, 7) < companyToday(zone).slice(0, 7);
function inLeaveGrace(date, zone) {
  const today = companyToday(zone), [y, m] = String(date).slice(0, 7).split('-').map(Number);
  return today.slice(0, 7) === new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7) && Number(today.slice(8, 10)) <= 5;
}
const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const workDaysValue = v => (v == null ? null : Array.isArray(v) && v.length && v.length <= 7 && v.every(d => Number.isInteger(d) && d >= 0 && d <= 6) ? [...new Set(v)].sort() : p.fail('أيام العمل غير صالحة', 'invalid-argument'));
const optionalTime = v => (v == null || v === '' ? null : hhmm(v));
// Owner decision 8: no window may cross midnight (a night shift could not be recorded).
const dayWindow = w => { const r = windowOf(w); if (p.minutes(r.from) >= p.minutes(r.to)) p.fail('النافذة يجب أن تكون داخل اليوم نفسه، لا تعبر منتصف الليل', 'invalid-argument'); return r; };
// v5.18: an employee's special work location (a map point + radius) and the employee change log.
function specialZone(v) {
  if (v == null || v === 'branch') return null;
  const { lat, lng, radius } = v || {};
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180 || !Number.isFinite(radius) || radius < 1 || radius > 100000) p.fail('موقع العمل غير صالح', 'invalid-argument');
  return { lat, lng, radius: Math.round(radius), enabled: true };
}
const zoneText = z => (z ? { lat: z.lat, lng: z.lng, radius: z.radius } : 'branch');
const employeeLog = (cid, eid, entry) => db.ref(`employeeLog/${cid}/${eid}`).push({ ...entry, at: Date.now() });
// v5.19 (owner, 24 Nov 2026): for NEW saves the check-out window starts at or after the check-in window ends
// (same day; decision 8 = no overnight). Existing saved schedules are never changed or refused at check-in time.
function dayPair(checkIn, checkOut) {
  const i = dayWindow(checkIn), o = dayWindow(checkOut);
  if (p.minutes(o.from) < p.minutes(i.to)) p.fail('أوقات متداخلة: وقت الانصراف يجب أن يبدأ عند نهاية وقت الحضور أو بعده', 'invalid-argument');
  return { checkIn: i, checkOut: o };
}
const MIN_WORK_MS = 10 * 60000; // a check-out needs at least 10 minutes after the check-in
// ---- v6.0 (owner, 24 Nov 2026): records live on the manager's device; Firebase keeps a 45-day mailbox. ----
const KEEP_DAYS = 45, PURGE_START = '2027-01-10', SYNC_PAGE = 2000; // owner 24 Nov: postponed from 2026-12-10
const daysBefore = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
const purgeCutoff = zone => daysBefore(companyToday(zone), KEEP_DAYS); // records dated BEFORE this are removed
const purgeActive = zone => companyToday(zone) >= PURGE_START;
// Deterministic JSON (sorted keys) so the page can verify exactly what the server signed.
const stable = v => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);
// Server-only keys (root rules deny every client path that is not listed). Created once, on first use.
async function serverKey(path, make) {
  const ref = db.ref(path);
  await ref.transaction(old => old || make());
  return read(path);
}
const signingKey = () => serverKey('serverKeys/signing', () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), createdAt: Date.now() }; });
const storeKey = cid => serverKey(`serverKeys/store/${cid}`, () => ({ key: randomBytes(32).toString('base64'), createdAt: Date.now() }));
const signedMessage = (cid, collection, id, value) => `${cid}\n${collection}\n${id}\n${stable(value)}`;
function signItems(cid, collection, items, key) {
  const pk = createPrivateKey(key.privateKey), out = {};
  for (const [id, value] of Object.entries(items)) out[id] = { d: value, s: edSign(null, Buffer.from(signedMessage(cid, collection, id, value)), pk).toString('base64') };
  return out;
}
// Per company and month: changes whenever records/leaves/excuses of that month change. The manager page caches CLOSED
// months on the phone and re-downloads a month only when this number differs (v5.16 cost).
const bumpMonth = (cid, date) => (typeof date === 'string' && /^\d{4}-\d{2}/.test(date) ? db.ref(`recordsVersions/${cid}/${date.slice(0, 7)}`).set(Date.now()) : null);
exports.beginWebAuthn = endpoint(['employee'], async ({ uid, member, data }) => {
  // Warm-up ping from the employee page: starts this instance before the fingerprint button is pressed.
  // Reached only after the endpoint's Auth, App Check, access and rate-limit checks; no reads, no side effects.
  if (data?.warm === true) return { warm: true };
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
  // Warm-up ping from the employee page: starts this instance before the fingerprint button is pressed.
  // Reached only after the endpoint's Auth, App Check, access and rate-limit checks; no reads, no side effects.
  if (data?.warm === true) return { warm: true };
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
    const cid = member.companyId, eid = member.employeeId, label = typeof data.deviceLabel === 'string' && data.deviceLabel.trim() ? p.text(data.deviceLabel, 'الجهاز', 80) : 'جهاز';
    await db.ref(`deviceApprovals/${cid}/${eid}`).set({ status: 'pending', credId: credential.id, uid, registeredAt: Date.now(), label });
    await deviceLog(cid, eid, 'registered', { label });
    await db.ref(`companies/${cid}/notifications/admin`).push({ type: 'device_new', message: `📱 ${activated.snapshot.val()?.name || 'موظف'}: بصمة/جهاز جديد (${label}) بانتظار اعتمادك قبل تسجيل الحضور`, timestamp: new Date().toISOString(), read: false, employeeId: eid });
    await bumpVersion(cid);
    await audit(uid, 'webauthn.register', member.companyId);
    return { registered: true, credentialId: credential.id, deviceStatus: 'pending' };
  }
  const stored = await read(`credentials/${uid}`);
  if (!stored) p.fail('البصمة غير مسجلة');
  // The credential used must be THIS employee's own (another person's fingerprint on the same phone is refused)...
  if (data.response?.id !== stored.id || data.response?.rawId !== stored.id) p.fail('هذه البصمة ليست مسجلة لحسابك', 'permission-denied');
  // ...and registered on a device the manager approved.
  if (await deviceState(member.companyId, member.employeeId, stored.id) !== 'approved') throw new p.PolicyError('failed-precondition', 'الجهاز بانتظار اعتماد المدير؛ لا يمكن تسجيل الحضور قبل الاعتماد', { reason: 'device-pending' });
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
  // Warm-up ping from the employee page: starts this instance before the fingerprint button is pressed.
  // Reached only after the endpoint's Auth, App Check, access and rate-limit checks; no reads, no side effects.
  if (data?.warm === true) return { warm: true };
  const cid = member.companyId, eid = member.employeeId, employee = await employeeContext(uid, member);
  if (employee.status !== 'approved') p.fail('سجّل البصمة أولًا');
  const ownCredential = await read(`credentials/${uid}`);
  if (!ownCredential || await deviceState(cid, eid, ownCredential.id) !== 'approved') throw new p.PolicyError('failed-precondition', 'الجهاز بانتظار اعتماد المدير؛ لا يمكن تسجيل الحضور قبل الاعتماد', { reason: 'device-pending' });
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
    void day;
    // Owner decisions 9 + Q3: work days per branch with an optional employee override (else the company weekend).
    if (!rules.isWorkDay(settings || {}, wh, employee, clock.date)) p.fail('اليوم ليس يوم عمل لك');
    if ((await read(`fullDayLeaveIndex/${cid}/${eid}/${clock.date}`)) === true) p.fail('لديك إجازة معتمدة اليوم؛ لا يُسجَّل حضور');
    if (!p.insideWindow(clock.minutes, sched[type === 'in' ? 'checkIn' : 'checkOut'])) throw new p.PolicyError('failed-precondition', 'انتهت نافذة التسجيل أو لم تبدأ بعد. تمت إعادة مزامنة وقت الخادم؛ راجع الوقت المعروض.', { reason:'attendance-window', serverTime:Date.now(), timeZone:info.timeZone });
    // Owner decisions 7 + Q2: lateness counts only from a start time the manager set (else nobody is late). Display only.
    if (type === 'in') { const start = rules.startTimeOf(settings || {}, wh, employee); delayMins = start ? Math.max(0, Math.floor(clock.minutes - p.minutes(start))) : 0; }
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
  // v5.18: an employee's special work location comes first (this employee only), then his branch, then the company.
  const zone = employee.geoZone?.lat != null && employee.geoZone.enabled !== false ? employee.geoZone : wh.geoZone && wh.geoZone.enabled !== false ? wh.geoZone : settings?.geoZone?.enabled ? settings.geoZone : null;
  // v5.19: a check-out is refused when less than 10 minutes passed since the check-in (checked before the proof is used).
  if (type === 'out') {
    const inAt = Date.parse((await read(`attendanceLedger/${cid}/${eid}/${clock.date}/events/in/timestamp`)) || '');
    if (Number.isFinite(inAt) && Date.now() - inAt < MIN_WORK_MS) p.fail(`لا يمكن تسجيل الانصراف قبل مرور 10 دقائق على الحضور (بقي ${Math.ceil((MIN_WORK_MS - (Date.now() - inAt)) / 60000)} دقيقة)`, 'failed-precondition');
  }
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
  return { ok: true, timestamp: stamp, date: clock.date, today: todaySummary(ledger.snapshot.val(), eid, clock.date) };
});
// The ledger is authoritative. Trigger retries rebuild projections after interrupted writes.
// The employee's day summary from the attendance ledger. Used by projectAttendance (writes companies/{cid}/today) AND
// returned by recordAttendance, so the page shows the check-in at once instead of waiting for the trigger (E2E v5.12).
function todaySummary(state, eid, date) {
  const today = { dateKey: date, empId: eid, ledgerRevision: state.revision || Object.keys(state.events || {}).length, ...p.attendanceSummary(state) };
  for (const value of Object.values(state.events || {})) {
    if (value.type === 'in') Object.assign(today, { checkIn: value.timestamp, empName: value.empName, warehouseId: value.warehouseId, warehouseName: value.warehouseName, locationName: value.locationName, delayMins: value.delayMins });
    if (value.type === 'out') today.checkOut = value.timestamp;
  }
  // Same shape as the stored node (the database drops null/undefined fields).
  return Object.fromEntries(Object.entries(today).filter(([, v]) => v !== null && v !== undefined));
}
exports.projectAttendance = onValueWritten({ ref: '/attendanceLedger/{cid}/{eid}/{date}', region, retry: true, maxInstances: 5, timeoutSeconds: 60 }, async event => {
  const { cid, eid, date } = event.params;
  const state = await read(`attendanceLedger/${cid}/${eid}/${date}`);
  if (!state) return;
  const revision = state.revision || Object.keys(state.events || {}).length;
  const updates = {}, today = todaySummary(state, eid, date);
  for (const [id, value] of Object.entries(state.events || {})) {
    const recordId = `${date}_${eid}_${id}`;
    // Existing reviewed records are not overwritten on subsequent events or trigger retries.
    const existing = await read(`companies/${cid}/records/${recordId}`);
    if (!existing) updates[`companies/${cid}/records/${recordId}`] = value;
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
  await bumpMonth(cid, date);
});
exports.submitRequest = endpoint(['employee'], async ({ uid, member, info, data }) => {
  const employee = await employeeContext(uid, member), cid = member.companyId, eid = member.employeeId;
  const record = { empId: eid, empName: employee.name, warehouseId: employee.warehouseId, warehouseName: employee.warehouseName, status: 'pending', createdAt: Date.now() };
  let collection;
  if (data.kind === 'leave') {
    if (!['paid', 'unpaid', 'sick', 'emergency', 'partial'].includes(data.leaveType) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date || '') || Number.isNaN(Date.parse(data.date))) p.fail('طلب غير صالح', 'invalid-argument');
    // Owner decision + Q4: every leave (full or timed) is requested at least 1 day before; otherwise the day is absence.
    if (data.date < nextDay(p.dateParts(new Date(record.createdAt), info.timeZone).date)) p.fail('الإجازة (الكاملة أو الزمنية) تُطلب قبل يومها بيوم على الأقل', 'invalid-argument');
    p.validateLeaveDate(data.date, false, record.createdAt, info.timeZone);
    Object.assign(record, { date: data.date, reason: p.text(data.reason, 'السبب', 2000), leaveType: data.leaveType, isPartial: data.leaveType === 'partial' });
    if (record.isPartial) { if (p.minutes(data.fromTime) >= p.minutes(data.toTime)) p.fail('فترة غير صالحة'); Object.assign(record, { fromTime: data.fromTime, toTime: data.toTime }); }
    collection = 'leaves';
  } else if (data.kind === 'excuse') {
    collection = 'excuses';
    // Owner decision + Q1: an excuse exists for LATENESS only (today, after a late check-in). Absence cannot be excused.
    if (data.type !== 'late') p.fail('العذر للتأخير فقط؛ الغياب تغطيه إجازة معتمدة مسبقًا', 'invalid-argument');
    const today = p.dateParts(new Date(record.createdAt), info.timeZone).date, ledger = await read(`attendanceLedger/${cid}/${eid}/${today}`);
    if (!(ledger?.events?.in?.delayMins > 0)) p.fail('عذر التأخير يُقدَّم بعد تسجيل حضور متأخر في اليوم نفسه', 'failed-precondition');
    Object.assign(record, { reason: p.text(data.reason, 'السبب', 2000), type: 'late', delayMins: ledger.events.in.delayMins, date: today, dateSource:'server', dateTimeZone:info.timeZone });
  } else p.fail('طلب غير صالح', 'invalid-argument');
  const id = collection === 'excuses' ? `excuse_${eid}_${record.date}` : db.ref().push().key;
  if (collection === 'excuses') {
    const created = await db.ref(`companies/${cid}/${collection}/${id}`).transaction(old => old ? undefined : record);
    if (!created.committed) p.fail('لديك طلب عذر لهذا اليوم بالفعل', 'already-exists');
  } else await db.ref(`companies/${cid}/${collection}/${id}`).set(record);
  await bumpMonth(cid, record.date);
  // Owner decision 6: the manager is notified of every new request.
  await db.ref(`companies/${cid}/notifications/admin`).push({ type: collection === 'leaves' ? 'leave_new' : 'excuse_new', message: collection === 'leaves' ? `🌴 ${employee.name}: طلب إجازة ${record.isPartial ? 'زمنية ' : ''}ليوم ${record.date}` : `📝 ${employee.name}: عذر تأخير (${record.delayMins} دقيقة)`, timestamp: new Date().toISOString(), read: false, employeeId: eid });
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
exports.reviewRequest = endpoint(['manager'], async ({ uid, member, info, data }) => {
  const cid = member.companyId, id = p.key(data.id);
  if (!['leaves', 'excuses'].includes(data.collection) || !['approved', 'rejected'].includes(data.status)) p.fail('طلب غير صالح', 'invalid-argument');
  return withLock(`review_${createHash('sha256').update(`${cid}/${data.collection}/${id}`).digest('hex')}`, async () => {
  const request = await read(`companies/${cid}/${data.collection}/${id}`);
  if (!request) p.fail('الطلب غير موجود', 'not-found');
  if (request.status !== 'pending' && request.status !== data.status) p.fail('الطلب محسوم؛ القرار نهائي');
  // Closed month: only LEAVE requests submitted on time may still be decided, for 5 days after the month ends.
  if (request.date && monthClosed(request.date, info.timeZone)) {
    const onTime = data.collection === 'leaves' && Number.isFinite(request.createdAt) && p.dateParts(new Date(request.createdAt), info.timeZone).date < request.date;
    if (!(onTime && inLeaveGrace(request.date, info.timeZone))) p.fail('الشهر مغلق؛ لا يمكن تغيير شيء فيه', 'failed-precondition');
  }
  // Owner decision + Q1: only lateness excuses can be approved (display only, no ledger change).
  if (data.collection === 'excuses' && data.status === 'approved' && request.type !== 'late') p.fail('هذا النوع من الأعذار لم يعد معتمدًا؛ الغياب تغطيه إجازة معتمدة مسبقًا', 'failed-precondition');
  if (data.collection === 'excuses' && data.status === 'approved' && request.type !== 'late') {
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
  await bumpMonth(cid, request.date);
  await audit(uid, 'request.review', `${cid}/${id}`, { status: data.status });
  return { ok: true };
  });
});
exports.manualAttendance = endpoint(['manager'], async ({ uid, member, info, data }) => {
  // Owner decision 1 (22 Nov 2026): no manager editing of attendance at all.
  p.fail('تعديل الحضور يدويًا غير متاح', 'failed-precondition');
  const cid = member.companyId, eid = p.key(data.employeeId), reason = p.text(data.reason, 'سبب التعديل', 1000);
  const employee = await read(`companies/${cid}/employees/${eid}`);
  if (!employee) p.fail('الموظف غير موجود', 'not-found');
  if (!['present', 'absent'].includes(data.status)) p.fail('حالة غير صالحة', 'invalid-argument');
  const date = p.dateParts(new Date(), info.timeZone).date;
  await db.ref(`companies/${cid}/adjustments/${date}/${eid}`).set({ status: data.status, reason, actor: uid, at: Date.now() });
  await audit(uid, 'attendance.adjust', `${cid}/${eid}/${date}`, { status: data.status, reason });
  return { ok: true };
});
exports.cleanupSecurityState = onSchedule({ schedule: 'every 24 hours', region, maxInstances: 1, timeoutSeconds: 300 }, async () => {
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
  await freezeClosedPayrolls();
  try { await purgeOldRecords(); } catch (error) { console.error('purge_failed', { code: error.code || 'internal' }); }
});
// Owner decision (24 Nov 2026, s1 = A + hard cap): every record older than 45 days is removed from Firebase, even if
// the manager has not pulled it. Only accounts, settings, branches and subscription stay. Chunked; continues next day.
async function purgeOldRecords({ budget = 50000 } = {}) {
  const directory = (await read('companyDirectory')) || {};
  let left = budget;
  for (const [cid, info] of Object.entries(directory)) {
    const zone = info?.timeZone || 'UTC';
    if (!purgeActive(zone) || left <= 0) continue;
    const cutoff = purgeCutoff(zone), base = `companies/${cid}`;
    const older = async (path, field) => {
      const q = field ? db.ref(path).orderByChild(field).endBefore(cutoff) : db.ref(path).orderByKey().endBefore(cutoff);
      return (await q.limitToFirst(Math.min(2000, left)).get()).val() || {};
    };
    const flush = async updates => { const n = Object.keys(updates).length; if (n) { await db.ref().update(updates); left -= n; } return n; };
    for (let n = 1; n && left > 0;) { // attendance: records + their ledger days + timed-leave records
      const updates = {};
      for (const [id, r] of Object.entries(await older(`${base}/records`, 'dateKey'))) {
        updates[`${base}/records/${id}`] = null;
        if (r?.empId && r?.dateKey && r.dateKey < cutoff) { updates[`attendanceLedger/${cid}/${r.empId}/${r.dateKey}`] = null; updates[`${base}/partialLeaveRecords/${r.empId}/${r.dateKey}`] = null; }
      }
      n = await flush(updates);
    }
    for (const collection of ['leaves', 'excuses']) for (let n = 1; n && left > 0;) {
      const updates = {};
      for (const [id, r] of Object.entries(await older(`${base}/${collection}`, 'date'))) {
        updates[`${base}/${collection}/${id}`] = null;
        if (collection === 'leaves' && r?.empId && r?.date) updates[`fullDayLeaveIndex/${cid}/${r.empId}/${r.date}`] = null;
      }
      n = await flush(updates);
    }
    { const updates = {}; for (const date of Object.keys(await older(`${base}/adjustments`))) updates[`${base}/adjustments/${date}`] = null; await flush(updates); }
    { const updates = {}; for (const month of Object.keys((await read(`payrollSnapshots/${cid}`)) || {})) { const [y, m] = month.split('-').map(Number); if (new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) < cutoff) updates[`payrollSnapshots/${cid}/${month}`] = null; } await flush(updates); }
  }
  return budget - left;
}
async function freezeClosedPayrolls() {
  const directory = (await read('companyDirectory')) || {};
  let done = 0;
  for (const [cid, info] of Object.entries(directory)) {
    if (done >= 60) break;
    try {
      const zone = info?.timeZone || 'UTC', today = companyToday(zone), [y, m] = today.slice(0, 7).split('-').map(Number), month = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
      if (`${month}-01` < rules.RULES_FROM || inLeaveGrace(`${month}-01`, zone) || await read(`payrollSnapshots/${cid}/${month}`)) continue;
      const value = await computePayrollMonth(cid, zone, month);
      await db.ref(`payrollSnapshots/${cid}/${month}`).transaction(old => old || { ...value, savedAt: Date.now() }); done++;
    } catch (error) { console.error('payroll_freeze_failed', { code: error.code || 'internal' }); }
  }
}
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
