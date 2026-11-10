'use strict';
const crypto = require('node:crypto');
class PolicyError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const fail = (message, code = 'failed-precondition') => { throw new PolicyError(code, message); };
function text(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\u0000-\u001f]/u.test(value)) fail(`قيمة غير صالحة: ${label}`, 'invalid-argument');
  return value.trim();
}
function key(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('معرّف غير صالح', 'invalid-argument');
  return value;
}
function active(info, now = Date.now()) {
  return !!info && info.status === 'active' && Number.isFinite(info.expiresAt) && info.expiresAt > now;
}
function authorize(member, token, info, roles, now = Date.now()) {
  if (!member || member.enabled !== true || !Number.isSafeInteger(member.version) || member.version < 1 || !Number.isSafeInteger(token?.version) || token.version < 1 || token.version !== member.version || !roles.includes(member.role)) fail('غير مصرح', 'permission-denied');
  if (member.role !== 'seller' && !active(info, now)) fail('الشركة معلّقة أو انتهت صلاحيتها', 'permission-denied');
  return member;
}
function password() { return crypto.randomBytes(24).toString('base64url'); }
function dateParts(now, zone) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second:'2-digit', hourCycle: 'h23' }).formatToParts(now).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) + Number(p.second)/60 };
  } catch { fail('المنطقة الزمنية غير صالحة', 'invalid-argument'); }
}
function minutes(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('وقت غير صالح', 'invalid-argument');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function insideWindow(now, window) {
  if (!window) fail('جدول الحضور غير مضبوط');
  const from = minutes(window.from), to = minutes(window.to);
  if(from === to) fail('بداية النافذة ونهايتها متطابقتان');
  return from < to ? now >= from && now < to : now >= from || now < to;
}
function distance(a, b) {
  const rad = x => x * Math.PI / 180;
  const q = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}
function location(value, zone) {
  if (!value || !Number.isFinite(value.lat) || Math.abs(value.lat) > 90 || !Number.isFinite(value.lng) || Math.abs(value.lng) > 180) fail('الموقع مطلوب', 'invalid-argument');
  if (value.accuracy != null && (!Number.isFinite(value.accuracy) || value.accuracy < 0)) fail('دقة GPS غير صالحة', 'invalid-argument');
  const accuracy = value.accuracy ?? 0, tolerance = Math.min(accuracy, 150);
  const result = { lat: value.lat, lng: value.lng, accuracy, gpsTolerance: tolerance, locationName: typeof value.name === 'string' ? text(value.name || 'موقع الجهاز', 'الموقع', 250) : 'موقع الجهاز' };
  if (zone && zone.enabled !== false) {
    const zones = zone.zones ? Object.values(zone.zones) : [zone];
    const valid = zones.filter(z => Number.isFinite(z.lat) && Math.abs(z.lat) <= 90 && Number.isFinite(z.lng) && Math.abs(z.lng) <= 180 && Number.isFinite(z.radius) && z.radius > 0 && z.radius <= 100000);
    if (!valid.length) fail('النطاق الجغرافي غير مضبوط');
    const excess = Math.min(...valid.map(z => distance(value, z) - z.radius));
    if (excess > tolerance) fail(`أنت خارج نطاق الموقع بمقدار ${Math.ceil(excess)} متر؛ سماحية دقة GPS ${Math.round(tolerance)} متر، والمسافة الزائدة بعد السماحية ${Math.ceil(excess - tolerance)} متر.`);
  }
  return result;
}
function transition(state, type) {
  const events = state?.events || {};
  if (events[type]) fail('تم تسجيل العملية مسبقًا', 'already-exists');
  if (type === 'out' && !events.in && !(events.excused && ['no_checkin','no_both'].includes(events.excused.excuseType))) fail('سجّل الحضور أو احصل على موافقة العذر أولًا');
  if (type === 'in' && events.out) fail('انتهى يوم العمل');
  if (type === 'return' && !events.departure) fail('لم تسجّل المغادرة');
  if (type === 'departure' && (!events.in || events.out)) fail('المغادرة تتطلب حضورًا نشطًا');
}
function attendanceSummary(state) {
  const events = state?.events || {}, excuse = events.excused;
  const checkInExcused = !events.in && !!excuse && ['no_checkin','no_both'].includes(excuse.excuseType);
  const checkOutExcused = !events.out && !!excuse && ['no_checkout','no_both'].includes(excuse.excuseType);
  const excusedOut = (!!events.out && checkInExcused) || (!events.out && checkOutExcused);
  return {
    checkIn: events.in?.timestamp || null, checkOut: events.out?.timestamp || null,
    checkInExcused, checkOutExcused, excuseCheckout: checkOutExcused,
    attendanceStatus: excusedOut ? 'excused_out' : events.out ? 'out' : events.in ? 'present' : checkInExcused ? 'excused_present' : 'absent',
    statusLabel: excusedOut ? 'انصرف (بعذر)' : events.out ? 'انصرف' : events.in ? 'حاضر' : checkInExcused ? 'حاضر (بعذر)' : 'غائب',
    actualWorkMinutes: events.in && events.out ? Math.max(0, (Date.parse(events.out.timestamp) - Date.parse(events.in.timestamp)) / 60000) : null,
    excuseId: excuse?.requestId || null
  };
}
function payrollValues(data) {
  const salary = Number(data.salary), deductionPercent = Number(data.deductionPercent);
  if (!Number.isFinite(salary) || salary < 0 || !Number.isFinite(deductionPercent) || deductionPercent < 0 || deductionPercent > 100) fail('قيم مالية غير صالحة', 'invalid-argument');
  return { salary, deductionPercent };
}
function validateLeaveDate(date, partial, now, zone) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) fail('تاريخ غير صالح', 'invalid-argument');
  const today = dateParts(now, zone).date;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
  if (date < (partial ? today : tomorrow)) fail(partial ? 'الإجازة الزمنية متاحة من اليوم فقط بتوقيت الشركة' : 'الإجازة الكاملة متاحة من الغد فقط بتوقيت الشركة', 'invalid-argument');
  return date;
}
module.exports = { validateLeaveDate, PolicyError, fail, text, key, active, authorize, password, dateParts, minutes, insideWindow, distance, location, transition, attendanceSummary, payrollValues };
