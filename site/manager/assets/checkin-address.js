'use strict';
// v6.8 (owner, 27 Nov 2026): a readable check-in address, at zero cost.
// - Looked up on the EMPLOYEE'S PHONE only, AFTER the check-in is saved (never during the fingerprint step).
// - One request per check-in at most; a phone cache answers again for the same place (within 100 m) with NO request.
// - Sent to the service: the point rounded to 4 decimals (~11 m) and the language. Nothing else from Basma.
// - The service is chosen by ONE server setting (GEOCODER in functions/index.js), so it can be switched without a page rebuild.
// - If the service is slow, blocked or fails: no error screen; the distance from the branch + a map link are shown.
(function (root) {
  const CACHE_KEY = 'basma.geo_cache', LAST_KEY = 'basma.geo_last', MAX_CACHE = 30;
  const rad = x => (x * Math.PI) / 180;
  function meters(a, b) {
    if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
  }
  const clean = v => (typeof v === 'string' ? v.replace(/[<>\u0000-\u001f]/g, '').trim() : '');
  const join = parts => { const out = []; for (const p of parts.map(clean)) if (p && !out.includes(p)) out.push(p); return out.join('، ').slice(0, 100); };
  // Short Arabic text from each provider's answer. With ~100 m GPS accuracy the street is only "near"; the neighbourhood is reliable.
  function shortText(provider, json) {
    if (!json || typeof json !== 'object') return '';
    if (provider === 'nominatim') {
      const a = json.address || {}, area = a.neighbourhood || a.quarter || a.suburb || a.hamlet || '', place = a.city_district || a.village || a.town || a.city || '';
      return join([a.road ? `قرب ${a.road}` : '', area, place, a.city && a.city !== place ? a.city : '']);
    }
    if (provider === 'photon') {
      const f = json.features?.[0]?.properties || {};
      return join([f.street ? `قرب ${f.street}` : '', f.locality || f.district || '', f.city || '']);
    }
    if (provider === 'bigdatacloud') {
      const admin = json.localityInfo?.administrative || [];
      return join([admin.at(-1)?.name || '', json.locality || '', json.city || '']);
    }
    return '';
  }
  const storage = () => { try { return root.localStorage || null; } catch { return null; } };
  function cached(point, radius = 100) {
    try { const list = JSON.parse(storage()?.getItem(CACHE_KEY) || '[]'); return list.find(x => meters(x, point) !== null && meters(x, point) <= radius) || null; } catch { return null; }
  }
  function remember(point, text, lang) {
    try { const s = storage(); if (!s) return; const list = JSON.parse(s.getItem(CACHE_KEY) || '[]').filter(x => meters(x, point) > 100);
      list.unshift({ lat: Math.round(point.lat * 1e4) / 1e4, lng: Math.round(point.lng * 1e4) / 1e4, text, lang }); s.setItem(CACHE_KEY, JSON.stringify(list.slice(0, MAX_CACHE))); } catch {}
  }
  // One lookup: cache first; else at most one request (timeout), spaced from the previous one on this phone.
  async function lookup(config, point, { fetchFn = root.fetch?.bind(root), now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    if (!config?.url || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return null;
    const hit = cached(point, config.cacheMeters || 100);
    if (hit) return { text: hit.text, lang: hit.lang, source: 'cache' };
    if (typeof fetchFn !== 'function') return null;
    const s = storage(), last = Number(s?.getItem(LAST_KEY) || 0), gap = (config.minIntervalMs || 1500) - (now() - last);
    if (gap > 0) await wait(gap);
    try { s?.setItem(LAST_KEY, String(now())); } catch {}
    const url = config.url.replace('{lat}', (Math.round(point.lat * 1e4) / 1e4).toFixed(4)).replace('{lng}', (Math.round(point.lng * 1e4) / 1e4).toFixed(4)).replace('{lang}', encodeURIComponent(config.lang || 'ar'));
    const ctl = typeof AbortController === 'function' ? new AbortController() : null, timer = setTimeout(() => ctl?.abort(), config.timeoutMs || 3000);
    try {
      const res = await fetchFn(url, { signal: ctl?.signal, headers: { Accept: 'application/json' }, referrerPolicy: 'strict-origin-when-cross-origin', credentials: 'omit' });
      if (!res.ok) return null;
      const text = shortText(config.provider, await res.json());
      if (!text) return null;
      remember(point, text, config.lang || 'ar');
      return { text, lang: config.lang || 'ar', source: 'service' };
    } catch { return null; } finally { clearTimeout(timer); }
  }
  const mapUrl = p => (Number.isFinite(p?.lat) && Number.isFinite(p?.lng) ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}` : null);
  // What the manager sees: the address if found, else "near <branch>, <distance> m"; always a map link to the exact point.
  function place(record, branch) {
    if (!record) return null;
    const point = Number.isFinite(record.lat) && Number.isFinite(record.lng) ? { lat: record.lat, lng: record.lng } : null;
    const zone = branch?.geoZone, d = point && zone ? meters(point, zone) : null;
    const text = clean(record.address?.text) || (d !== null ? `قرب ${branch?.name || 'الفرع'}، ${d} م` : '');
    return { text, href: mapUrl(point), credit: record.address?.text ? '© OpenStreetMap' : '' };
  }
  const api = { meters, shortText, lookup, cached, remember, mapUrl, place };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BasmaAddress = api;
})(typeof window !== 'undefined' ? window : globalThis);
