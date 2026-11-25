'use strict';
// v6.0 (owner decision, 24 Nov 2026): the company's records live on the MANAGER'S device. Firebase is a 45-day mailbox.
// - IndexedDB "basma-local-v1", every item encrypted (AES-GCM) with a per-company key that the server gives only to a
//   signed-in manager. Logout removes the key, NOT the data: nobody on this phone/site can read it without signing in.
// - Every item carries the server's Ed25519 signature; anything unsigned or changed is refused (no attendance editing).
// - Incremental sync from the last pulled date. Backup export/import is encrypted with a password the manager chooses.
(function (root) {
  const DB_NAME = 'basma-local-v1', DB_VERSION = 3, COLLECTIONS = ['records', 'leaves', 'excuses', 'payroll'];
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = bytes => { let s = ''; const a = new Uint8Array(bytes); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  // Same deterministic JSON as the server (functions/index.js `stable`).
  const stable = v => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);
  const message = (cid, col, id, d) => enc.encode(`${cid}\n${col}\n${id}\n${stable(d)}`);
  const dateOf = (col, id, d) => (col === 'records' ? d?.dateKey : col === 'payroll' ? `${id}-01` : d?.date) || '';
  const daysBefore = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

  // Storage backends: IndexedDB in the page, a Map in unit tests. Same tiny interface.
  function idbBackend(idb = root.indexedDB) {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((resolve, reject) => {
      const r = idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'k' }).createIndex('byDate', ['cid', 'col', 'date']);
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'cid' });
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'cid' });
      };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error || Error('IndexedDB'));
    }));
    const tx = async (store, mode, fn) => { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction(store, mode), s = t.objectStore(store); let out; const req = fn(s); if (req) req.onsuccess = () => { out = req.result; }; t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || Error('aborted')); }); };
    return {
      get: (store, key) => tx(store, 'readonly', s => s.get(key)),
      put: (store, value) => tx(store, 'readwrite', s => s.put(value)),
      putMany: async (store, values) => { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction(store, 'readwrite'), s = t.objectStore(store); for (const v of values) s.put(v); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); }); },
      del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
      range: (cid, col, from, to) => tx('items', 'readonly', s => s.index('byDate').getAll(IDBKeyRange.bound([cid, col, from], [cid, col, to]))),
      count: (cid, col) => tx('items', 'readonly', s => s.index('byDate').count(IDBKeyRange.bound([cid, col, ''], [cid, col, '￿'])))
    };
  }
  function memoryBackend() {
    const stores = { items: new Map(), meta: new Map(), keys: new Map() }, keyOf = { items: 'k', meta: 'cid', keys: 'cid' };
    const clone = v => (v && typeof v === 'object' ? { ...v } : v);
    return {
      stores,
      get: async (store, key) => clone(stores[store].get(key)),
      put: async (store, value) => { stores[store].set(value[keyOf[store]], clone(value)); },
      putMany: async (store, values) => { for (const v of values) stores[store].set(v[keyOf[store]], clone(v)); },
      del: async (store, key) => { stores[store].delete(key); },
      range: async (cid, col, from, to) => [...stores.items.values()].filter(x => x.cid === cid && x.col === col && x.date >= from && x.date <= to).sort((a, b) => a.date.localeCompare(b.date)),
      count: async (cid, col) => [...stores.items.values()].filter(x => x.cid === cid && x.col === col).length
    };
  }

  function create({ call, backend = idbBackend(), subtle = root.crypto?.subtle, now = () => Date.now(), storage = root.navigator?.storage, companyId = () => null } = {}) {
    let keys = null; // { cid, aes, verifier, cutoff, today, keepDays, purgeStart }
    async function unlock(given) {
      const k = given || await call('managerList', { kind: 'syncKeys' });
      const aes = await subtle.importKey('raw', unb64(k.storeKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      let verifier = null;
      try { verifier = await subtle.importKey('spki', unb64(k.publicKey), { name: 'Ed25519' }, false, ['verify']); } catch { verifier = null; }
      keys = { cid: k.companyId, aes, verifier, cutoff: k.cutoff, today: k.today, keepDays: k.keepDays, purgeStart: k.purgeStart };
      await backend.put('keys', { cid: k.companyId, aes, savedAt: now() }); // non-extractable key, usable offline until logout
      return keys;
    }
    async function unlockOffline(cid) { const saved = await backend.get('keys', cid); if (!saved?.aes) return null; keys = { cid, aes: saved.aes, verifier: null, offline: true }; return keys; }
    const need = () => { if (!keys) throw Error('البيانات المحلية مقفلة؛ سجّل الدخول'); return keys; };
    async function verify(col, id, item, verifier = need().verifier) {
      if (!item || typeof item.s !== 'string') return false;
      if (!verifier) return null; // this browser cannot check signatures
      try { return await subtle.verify('Ed25519', verifier, unb64(item.s), message(need().cid, col, id, item.d)); } catch { return false; }
    }
    async function seal(col, id, item, verified) {
      const { cid, aes } = need(), iv = root.crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(JSON.stringify({ d: item.d, s: item.s })));
      return { k: `${cid}|${col}|${id}`, cid, col, id, date: dateOf(col, id, item.d), iv: b64(iv), ct: b64(ct), verified };
    }
    async function open(row) { const { aes } = need(); const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv) }, aes, unb64(row.ct)); return JSON.parse(dec.decode(pt)); }
    async function store(col, items) {
      const rows = [], rejected = [];
      for (const [id, item] of Object.entries(items || {})) { const ok = await verify(col, id, item); if (ok === false) { rejected.push(id); continue; } rows.push(await seal(col, id, item, ok === true)); }
      if (rows.length) await backend.putMany('items', rows);
      return { stored: rows.length, rejected };
    }
    async function meta() { return (await backend.get('meta', need().cid)) || { cid: need().cid }; }
    async function saveMeta(patch) { const m = { ...(await meta()), ...patch }; await backend.put('meta', m); return m; }
    // v6.1 (owner, 25 Nov 2026): ONE call per open. The first sync on a phone is FULL (everything still on the server).
    // After that it is INCREMENTAL: the server sends only items changed since this phone's cursor, in pages. The cursor
    // moves only after a successful sync, so an offline or failed sync is simply retried on the next open.
    // Every phone keeps its own cursor (several manager phones never conflict).
    async function sync({ onProgress } = {}) {
      const cid0 = keys?.cid || companyId(), m0 = cid0 ? ((await backend.get('meta', cid0)) || {}) : {};
      const result = { stored: 0, rejected: [] };
      const take = async (col, page) => { const part = await store(col, page.items); result.stored += part.stored; result.rejected.push(...part.rejected.map(id => `${col}/${id}`)); onProgress?.(col, result.stored); };
      let res = await call('managerList', { kind: 'syncAll', cursor: Number.isFinite(m0.cursor?.at) ? { at: m0.cursor.at } : null, lastBackupAt: m0.lastBackupAt });
      const k = await unlock(res.keys), full = !!res.full;
      for (let guard = 0; guard < 50; guard++) {
        for (const col of COLLECTIONS) {
          let page = res.pages[col] || { items: {}, next: null };
          for (;;) { await take(col, page); if (!page.next) break; page = await call('managerList', { kind: 'sync', collection: col, from: null, after: page.next }); }
        }
        if (full || !res.more) break;
        res = await call('managerList', { kind: 'syncAll', cursor: res.cursor, lastBackupAt: m0.lastBackupAt }); // next page of changes
      }
      const saved = await saveMeta({ cursor: { at: res.cursor.at }, syncedTo: k.today, lastPullAt: now(), lastOpenAt: now(), lastFull: full ? now() : m0.lastFull });
      return { ...result, full, meta: saved };
    }
    async function range(col, from, to) { const out = {}; for (const row of await backend.range(need().cid, col, from, to)) out[row.id] = (await open(row)).d; return out; }
    async function stats() { const m = await meta(), counts = {}; for (const col of COLLECTIONS) counts[col] = await backend.count(need().cid, col); return { ...m, counts }; }
    async function persist() { try { if (await storage?.persisted?.()) return true; return !!(await storage?.persist?.()); } catch { return false; } }
    // ---- backup file (v6.3, owner 25 Nov 2026): a PLAIN file, no password. Inside: the company ID, an integrity
    // check (SHA-256 of the whole content) against damage, and the server's signature on every item against editing
    // (a signature also binds the item to its company). Old password-protected files (v1) can still be imported. ----
    async function passwordKey(password, salt) { const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']); return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
    const sha256 = async text => [...new Uint8Array(await subtle.digest('SHA-256', enc.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const bodyOf = f => stable({ format: f.format, companyId: f.companyId, createdAt: f.createdAt, count: f.count, items: f.items });
    async function exportBackup() {
      const { cid } = need(), items = [];
      for (const col of COLLECTIONS) for (const row of await backend.range(cid, col, '', '\uffff')) { const x = await open(row); items.push({ col, id: row.id, d: x.d, s: x.s }); }
      const file = { format: 'basma-backup-v2', companyId: cid, createdAt: now(), count: items.length, items };
      file.integrity = { algorithm: 'SHA-256', value: await sha256(bodyOf(file)) };
      await saveMeta({ lastBackupAt: now() });
      return file;
    }
    const needsPassword = file => file?.format === 'basma-backup-v1';
    // Import is ALL OR NOTHING: a file of another company, a damaged or edited file, or one bad signature = nothing is
    // added and a clear Arabic message is returned. A valid file only ADDS what this phone does not have yet.
    async function importBackup(file, password) {
      const { cid, verifier } = need(), refuse = text => { throw Object.assign(new Error(text), { code: 'basma/import-refused' }); };
      if (!file || typeof file !== 'object' || !['basma-backup-v1', 'basma-backup-v2'].includes(file.format)) refuse('هذا الملف ليس نسخة احتياطية من بصمة؛ لم يُستورد أي شيء');
      if (file.companyId !== cid) refuse('هذه النسخة لشركة أخرى؛ لم يُستورد أي شيء');
      let items;
      if (file.format === 'basma-backup-v1') {
        if (!password) refuse('هذه نسخة قديمة محمية بكلمة سر؛ اكتب كلمة السر');
        let plain; try { plain = JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, await passwordKey(password, unb64(file.kdf.salt)), unb64(file.ct)))); } catch { refuse('كلمة السر غير صحيحة أو الملف تالف؛ لم يُستورد أي شيء'); }
        if (plain.companyId !== cid) refuse('هذه النسخة لشركة أخرى؛ لم يُستورد أي شيء');
        items = plain.items;
      } else {
        if (!Array.isArray(file.items) || file.count !== file.items.length || file.integrity?.algorithm !== 'SHA-256' || file.integrity.value !== await sha256(bodyOf(file))) refuse('الملف تالف أو معدَّل؛ لم يُستورد أي شيء');
        items = file.items;
      }
      if (!verifier) refuse('هذا المتصفح لا يستطيع التحقق من التواقيع؛ حدّث المتصفح ثم أعد المحاولة. لم يُستورد أي شيء');
      for (const x of items || []) if (!x || !COLLECTIONS.includes(x.col) || typeof x.id !== 'string' || (await verify(x.col, x.id, x)) !== true) refuse('في الملف سجل معدَّل أو غير موقَّع من الخادم؛ لم يُستورد أي شيء');
      let imported = 0, kept = 0; const rows = [];
      for (const x of items || []) { if (await backend.get('items', `${cid}|${x.col}|${x.id}`)) { kept++; continue; } rows.push(await seal(x.col, x.id, x, true)); imported++; }
      if (rows.length) await backend.putMany('items', rows);
      return { imported, kept, rejected: [] };
    }
    // Logout: the key goes, the encrypted data stays.
    async function lock() { if (keys?.cid) await backend.del('keys', keys.cid); keys = null; }
    return { unlock, unlockOffline, sync, range, stats, meta, saveMeta, persist, exportBackup, importBackup, needsPassword, lock, get companyId() { return keys?.cid; }, get verifiable() { return !!keys?.verifier; }, get info() { return keys; } };
  }
  const api = { create, idbBackend, memoryBackend, stable, DB_NAME, COLLECTIONS };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BasmaLocal = api;
})(typeof window !== 'undefined' ? window : globalThis);
