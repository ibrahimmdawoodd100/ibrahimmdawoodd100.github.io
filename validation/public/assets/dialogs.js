'use strict';
// In-page dialogs for every Basma page. Phones can silently block window.prompt/confirm/alert,
// so Basma never relies on them. Only safe DOM methods are used (createElement/textContent).
// Credentials shown here are never logged, stored, or put in a URL, and are cleared on close.
window.BasmaDialogs = (() => {
  const toLatinDigits = value => String(value ?? '').replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
  const toast = (message, type) => { try { if (typeof window.showToast === 'function') window.showToast(message, type); else if (typeof showToast === 'function') showToast(message, type); } catch {} };
  function modal(title) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:#000a;z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface,#1a1a1a);color:var(--text,inherit);border:1px solid var(--border,#333);border-radius:14px;padding:18px;width:100%;max-width:380px;max-height:90vh;overflow:auto;direction:rtl;display:grid;gap:10px';
    const heading = document.createElement('h3'); heading.textContent = title; heading.style.margin = '0'; box.appendChild(heading);
    overlay.appendChild(box); document.body.appendChild(overlay);
    return { overlay, box, close: () => overlay.remove() };
  }
  function button(label, kind) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = 'action-btn-sm' + (kind ? ' ' + kind : ''); return b; }
  function paragraph(text, css) { const p = document.createElement('p'); p.textContent = text; p.style.cssText = css || 'margin:0;font-size:14px;line-height:1.7'; return p; }
  function form(title, fields) {
    return new Promise(resolve => {
      const m = modal(title), inputs = {};
      for (const f of fields) {
        const label = document.createElement('label'); label.textContent = f.label; label.style.cssText = 'display:grid;gap:4px;font-size:14px';
        const input = document.createElement('input'); input.type = f.type || 'text'; input.value = f.value ?? ''; input.className = 'form-input';
        if (f.numeric) input.inputMode = 'numeric';
        if (f.type === 'password') input.autocomplete = 'new-password';
        label.appendChild(input); m.box.appendChild(label); inputs[f.id] = input;
      }
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px';
      const ok = button('موافق', 'btn-gold'), cancel = button('إلغاء');
      row.append(ok, cancel); m.box.appendChild(row);
      const clear = () => { for (const el of Object.values(inputs)) el.value = ''; };
      ok.addEventListener('click', () => {
        const out = {};
        for (const [k, el] of Object.entries(inputs)) out[k] = el.type === 'password' ? String(el.value) : toLatinDigits(String(el.value).trim());
        clear(); m.close(); resolve(out);
      });
      cancel.addEventListener('click', () => { clear(); m.close(); resolve(null); });
      Object.values(inputs)[0]?.focus?.();
    });
  }
  function confirm(title, message, okLabel = 'متابعة', kind = 'btn-red') {
    return new Promise(resolve => {
      const m = modal(title); m.box.appendChild(paragraph(message));
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px';
      const ok = button(okLabel, kind), cancel = button('إلغاء');
      row.append(ok, cancel); m.box.appendChild(row);
      ok.addEventListener('click', () => { m.close(); resolve(true); });
      cancel.addEventListener('click', () => { m.close(); resolve(false); });
    });
  }
  function notice(title, message, selectableText) {
    return new Promise(resolve => {
      const m = modal(title); m.box.appendChild(paragraph(message));
      if (selectableText != null) {
        const field = document.createElement('input'); field.type = 'text'; field.readOnly = true; field.value = String(selectableText); field.className = 'form-input';
        field.style.cssText = 'direction:ltr;text-align:left;user-select:all'; m.box.appendChild(field);
        const copyButton = button('نسخ', 'btn-gold'); copyButton.addEventListener('click', () => copy(String(selectableText), field)); m.box.appendChild(copyButton);
      }
      const ok = button('حسنًا', 'btn-gold'); ok.addEventListener('click', () => { m.close(); resolve(); }); m.box.appendChild(ok);
    });
  }
  async function copy(text, field) {
    try { await navigator.clipboard.writeText(text); toast('تم النسخ', 'success'); return true; }
    catch {
      try { field?.focus?.(); field?.select?.(); if (document.execCommand?.('copy')) { toast('تم النسخ', 'success'); return true; } } catch {}
      try { field?.focus?.(); field?.select?.(); } catch {}
      toast('تعذر النسخ التلقائي. النص محدد الآن؛ اضغط عليه مطولًا واختر «نسخ».', 'info'); return false;
    }
  }
  // Shows a username/password pair exactly once. Closing removes the box and clears both fields.
  function credentials(title, { username, password, note } = {}) {
    return new Promise(resolve => {
      const m = modal(title), fields = [];
      m.box.appendChild(paragraph(note || 'انسخ البيانات الآن واحفظها في مكان آمن. لن تظهر مرة أخرى ولا تُحفظ في قاعدة البيانات.', 'margin:0;font-size:13px;color:var(--gold,#c9a227);line-height:1.6'));
      const row = (labelText, value) => {
        const label = document.createElement('label'); label.textContent = labelText; label.style.cssText = 'display:grid;gap:4px;font-size:13px';
        const field = document.createElement('input'); field.type = 'text'; field.readOnly = true; field.value = String(value ?? ''); field.className = 'form-input';
        field.autocomplete = 'off'; field.style.cssText = 'direction:ltr;text-align:left;font-family:monospace;user-select:all';
        const copyButton = button('نسخ ' + labelText, 'btn-gold'); copyButton.addEventListener('click', () => copy(field.value, field));
        label.append(field, copyButton); m.box.appendChild(label); fields.push(field); return field;
      };
      const userField = row('اسم المستخدم', username);
      const passField = row('كلمة المرور', password);
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
      const both = button('نسخ الاثنين معًا', 'btn-gold');
      both.addEventListener('click', () => copy(`اسم المستخدم: ${userField.value}\nكلمة المرور: ${passField.value}`, userField));
      const close = button('حفظتها، أغلق');
      close.addEventListener('click', () => { for (const f of fields) f.value = ''; m.close(); resolve(); });
      actions.append(both, close); m.box.appendChild(actions);
    });
  }
  return Object.freeze({ form, confirm, notice, credentials, copy, toLatinDigits });
})();
