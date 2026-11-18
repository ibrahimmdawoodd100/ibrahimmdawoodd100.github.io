'use strict';
// Monthly cost model for Basma (node scripts/cost-model.js). Every input is visible here.
// PRICES: [V] = verified on the official page on 2026-11-18, [A] = assumed (page did not load / not published there).
const PRICE = {
  runFreeRequests: 2e6,          // [V] cloud.google.com/run/pricing: 2 million requests free per month
  runFreeVcpuS: 240000,          // [V] 240,000 vCPU-seconds free per month
  runFreeGibS: 450000,           // [V] 450,000 GiB-seconds free per month
  runPerMillion: 0.40,           // [A] per million requests (Tier 1)
  runPerVcpuS: 0.000024,         // [A] per vCPU-second
  runPerGibS: 0.0000025,         // [A] per GiB-second
  rtdbFreeGBDay: 0.36,           // [V] firebase.google.com/pricing: 360 MB/day downloads free
  rtdbPerGB: 1,                  // [V] then $1/GB downloaded
  rtdbFreeStoredGB: 1, rtdbPerStoredGB: 5, // [V] 1 GB stored free, then $5/GB
  recaptchaFree: 10000,          // [V] docs.cloud.google.com/recaptcha/docs/compare-tiers: free up to 10,000/month (per organization)
  recaptchaFlat: 8,              // [V] 10,001-100,000: $8.00 flat fee
  recaptchaPer1k: 1,             // [V] more than 100,000: $1.00 per 1,000 (applied here to the part above 100,000 [A])
  logFreeGiB: 50, logPerGiB: 0.5,// [V] Cloud Logging: first 50 GiB/project/month, then $0.50/GiB
  storagePerGBMonth: 0.022,      // [V] Cloud Storage Standard $0.000030137/GiB-hour ≈ $0.022/GiB-month; 5 GB-months free [V]
  egressFreeGB: 5, egressPerGB: 0.12 // [V] Firebase: 5 GB/month outbound free; [A] $0.12/GB after
};
const DAYS = 22; // working days per month
// Usage per person per working day. "before" = v5.15 code; "after" = this release's code; "ttl7d" adds the owner's App Check TTL change.
const USAGE = {
  before: { empCalls: 36.5, mgrCalls: 366, empAssess: 2, mgrAssess: 16, empKB: 30, mgrKB: 96 * 55 + 2 * 1000, logKBPerCall: 2.8 },
  after:  { empCalls: 19.8, mgrCalls: 78,  empAssess: 2, mgrAssess: 8.5, empKB: 30, mgrKB: 48 * 55 + 2 * 500, logKBPerCall: 2.8 },
  ttl7d:  { empCalls: 19.8, mgrCalls: 78,  empAssess: 0.2, mgrAssess: 0.2, empKB: 30, mgrKB: 48 * 55 + 2 * 500, logKBPerCall: 2.8 }
};
const CALL_SECONDS = 0.06, CALL_GIB = 0.25; // average busy time per call (measured warm medians 30-60 ms) and 256 MiB
function month(employees, u) {
  const managers = Math.ceil(employees / 30);
  const calls = (employees * u.empCalls + managers * u.mgrCalls) * DAYS;
  const run = Math.max(0, calls - PRICE.runFreeRequests) / 1e6 * PRICE.runPerMillion
    + Math.max(0, calls * CALL_SECONDS - PRICE.runFreeVcpuS) * PRICE.runPerVcpuS + Math.max(0, calls * CALL_SECONDS * CALL_GIB - PRICE.runFreeGibS) * PRICE.runPerGibS;
  const assess = (employees * u.empAssess + managers * u.mgrAssess) * DAYS;
  const recaptcha = assess <= PRICE.recaptchaFree ? 0 : assess <= 100000 ? PRICE.recaptchaFlat : PRICE.recaptchaFlat + (assess - 100000) / 1000 * PRICE.recaptchaPer1k;
  const gbDay = (employees * u.empKB + managers * u.mgrKB) / 1e6;
  const rtdb = Math.max(0, gbDay - PRICE.rtdbFreeGBDay) * 30 * PRICE.rtdbPerGB;
  const logs = Math.max(0, calls * u.logKBPerCall / 1e6 - PRICE.logFreeGiB) * PRICE.logPerGiB;
  // Stored data after 3 months: ~700 B per attendance record, 2 per employee per working day.
  const storedGB = employees * 2 * DAYS * 3 * 700 / 1e9 + employees * 2000 / 1e9;
  const rtdbStore = Math.max(0, storedGB - PRICE.rtdbFreeStoredGB) * PRICE.rtdbPerStoredGB;
  const backups = storedGB * 30 * PRICE.storagePerGBMonth; // 30 daily full copies kept (needs the owner's lifecycle rule)
  const total = run + recaptcha + rtdb + logs + rtdbStore + backups;
  return { employees, calls: Math.round(calls), assess: Math.round(assess), run, recaptcha, rtdb, logs, rtdbStore, backups, total };
}
if (require.main === module) for (const [name, u] of Object.entries(USAGE)) {
  console.log(`== ${name}`);
  for (const n of [1000, 3000, 10000, 30000]) { const r = month(n, u); console.log(`${String(n).padStart(6)} emp | calls ${(r.calls / 1e6).toFixed(2)}M | assessments ${(r.assess / 1000).toFixed(0)}k | reCAPTCHA $${r.recaptcha.toFixed(0)} | RTDB dl $${r.rtdb.toFixed(0)} | Run $${r.run.toFixed(1)} | logs $${r.logs.toFixed(1)} | RTDB store $${r.rtdbStore.toFixed(1)} | backups $${r.backups.toFixed(1)} | TOTAL $${r.total.toFixed(0)}`); }
}
module.exports = { month, USAGE, PRICE };
