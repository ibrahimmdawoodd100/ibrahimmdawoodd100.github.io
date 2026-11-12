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
  // Shows a username/password pair until the user presses «تم، حفظتها» (never closes by itself).
  // The password is masked with an eye toggle; copy buttons copy the REAL values. Values live only in this box
  // (memory + the two fields) and are cleared when it closes. Nothing is logged, stored, or put in a URL.
  function credentials(title, { username, password, note } = {}) {
    return new Promise(resolve => {
      const m = modal(title), secret = { username: String(username ?? ''), password: String(password ?? '') };
      m.box.appendChild(paragraph(note || 'انسخ البيانات الآن واحفظها في مكان آمن. لن تظهر مرة أخرى ولا تُحفظ في قاعدة البيانات.', 'margin:0;font-size:13px;color:var(--gold,#c9a227);line-height:1.6'));
      const fieldRow = (labelText, key, masked) => {
        const label = document.createElement('label'); label.textContent = labelText; label.style.cssText = 'display:grid;gap:4px;font-size:13px';
        const line = document.createElement('div'); line.style.cssText = 'display:flex;gap:6px;align-items:center';
        const field = document.createElement('input'); field.type = masked ? 'password' : 'text'; field.readOnly = true; field.value = secret[key]; field.className = 'form-input';
        field.autocomplete = 'off'; field.style.cssText = 'direction:ltr;text-align:left;font-family:monospace;flex:1;min-width:0';
        line.appendChild(field);
        if (masked) {
          const eye = button('👁 إظهار'); eye.setAttribute?.('aria-label', 'إظهار كلمة المرور');
          eye.addEventListener('click', () => { const show = field.type === 'password'; field.type = show ? 'text' : 'password'; eye.textContent = show ? '🙈 إخفاء' : '👁 إظهار'; });
          line.appendChild(eye);
        }
        const copyButton = button('نسخ ' + labelText, 'btn-gold'); copyButton.addEventListener('click', () => copy(secret[key], field));
        label.append(line, copyButton); m.box.appendChild(label); return field;
      };
      const userField = fieldRow('اسم المستخدم', 'username', false);
      const passField = fieldRow('كلمة المرور', 'password', true);
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
      const both = button('نسخ الاثنين معًا', 'btn-gold');
      both.addEventListener('click', () => copy(`اسم المستخدم: ${secret.username}\nكلمة المرور: ${secret.password}`, userField));
      const done = button('تم، حفظتها', 'btn-green');
      done.addEventListener('click', () => { userField.value = ''; passField.value = ''; secret.username = ''; secret.password = ''; m.close(); resolve(); });
      actions.append(both, done); m.box.appendChild(actions);
    });
  }
  return Object.freeze({ form, confirm, notice, credentials, copy, toLatinDigits });
})();

// Plain-Arabic error messages for every page. The original code stays visible in small text.
// Server messages that are already clear are kept; confusing ones are rewritten here (frontend only).
window.BasmaErrors = (() => {
  const REWRITE = {
    'توجد عملية أخرى على الحساب؛ أعد المحاولة': 'الحساب مشغول بعملية أخرى الآن. انتظر لحظات ثم حاول مرة أخرى.',
    'تعارض التحقق، أعد المحاولة': 'حدث تداخل أثناء التحقق. حاول مرة أخرى.',
    'تحدي منتهي أو مستخدم': 'انتهت مهلة طلب البصمة. اضغط زر البصمة مرة أخرى.',
    'إثبات البصمة غير صالح أو مستخدم': 'لم تُقبل البصمة. اضغط زر البصمة وحاول مرة أخرى.',
    'فشل التحقق': 'لم يتم التحقق من البصمة. حاول مرة أخرى.',
    'لم يعد التفعيل مسموحًا': 'لا يمكن تفعيل البصمة لهذا الحساب الآن. اطلب من المدير إعادة تعيين الحساب.',
    'البصمة مسجلة مسبقًا': 'البصمة مسجلة لهذا الحساب من قبل. إذا غيّرت جوالك فاطلب من المدير إعادة تعيين البصمة.',
    'البصمة غير مسجلة': 'لم تُسجَّل بصمة لهذا الحساب بعد. سجّلها من شاشة التفعيل.',
    'سجّل البصمة أولًا': 'لم تُسجَّل بصمة لهذا الحساب بعد. سجّلها من شاشة التفعيل.',
    'إعدادات نطاق البصمة غير صحيحة': 'إعدادات البصمة في الخادم غير مكتملة. أبلغ المورّد.',
    'ربط غير صالح': 'بيانات الحساب غير مرتبطة بشكل صحيح. أبلغ المورّد.',
    'ربط حساب غير صالح': 'تعذر العثور على حساب مدير هذه الشركة. أبلغ المورّد.',
    'تغيّرت الجلسة. سجّل الدخول مجددًا': 'تغيّرت بيانات الدخول. سجّل الدخول من جديد.',
    'سجّل الدخول': 'انتهت الجلسة. سجّل الدخول من جديد.',
    'سجّل الدخول مجددًا قبل تغيير كلمة المرور': 'لأمانك: سجّل الخروج ثم الدخول من جديد، ثم غيّر كلمة المرور خلال 5 دقائق.',
    'العذر القديم يحتاج إلى إعادة تقديم من النسخة الآمنة': 'هذا العذر من النسخة القديمة. أرسله من جديد من فضلك.',
    'الطلب محسوم؛ تعديل القرار يتطلب إجراء تصحيح مستقل': 'تم البت في هذا الطلب من قبل. لتغيير النتيجة استخدم «تعديل الحضور يدويًا».',
    'نوع غير صالح': 'البيانات المرسلة غير صحيحة. حدّث الصفحة وحاول مرة أخرى.',
    'حالة غير صالحة': 'البيانات المرسلة غير صحيحة. حدّث الصفحة وحاول مرة أخرى.',
    'عملية غير صالحة': 'البيانات المرسلة غير صحيحة. حدّث الصفحة وحاول مرة أخرى.',
    'طلب غير صالح': 'البيانات المرسلة غير صحيحة. حدّث الصفحة وحاول مرة أخرى.',
    'فترة غير صالحة': 'الفترة المختارة غير صحيحة. اختر تاريخ بداية قبل تاريخ النهاية.',
    'بلغت حد الموظفين أو رقم الموظف مستخدم': 'وصلت إلى الحد الأقصى للموظفين، أو رقم الموظف مستخدم من قبل.',
    'المهمة غير متاحة': 'هذه المهمة لم تعد متاحة. حدّث الصفحة.',
    'الفرع غير متاح': 'هذا الفرع غير متاح أو معطّل.'
  };
  const BY_CODE = {
    'functions/aborted': 'الحساب مشغول بعملية أخرى الآن. انتظر لحظات ثم حاول مرة أخرى.',
    'functions/unauthenticated': 'انتهت الجلسة أو تعذر التحقق من التطبيق. سجّل الدخول من جديد.',
    'functions/internal': 'حدث خطأ في الخادم. حاول بعد قليل.',
    'functions/unavailable': 'تعذر الاتصال بالخادم. تحقق من الإنترنت ثم حاول مرة أخرى.',
    'functions/deadline-exceeded': 'استغرق الخادم وقتًا طويلًا. حاول مرة أخرى.',
    'functions/resource-exhausted': 'طلبات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.',
    'basma/busy': 'عملية بصمة جارية بالفعل. انتظر حتى تنتهي.',
    NotAllowedError: 'أُلغي التحقق أو انتهت مهلته. اضغط زر البصمة مرة أخرى.',
    AbortError: 'أُلغي التحقق. اضغط زر البصمة مرة أخرى.',
    InvalidStateError: 'هذا الجوال مسجّل لهذا الحساب من قبل.',
    NotSupportedError: 'هذا المتصفح لا يدعم البصمة لهذا الموقع. استخدم Chrome المحدّث.',
    SecurityError: 'المتصفح منع البصمة لهذا الموقع. افتح الموقع من Chrome مباشرة.'
  };
  const looksArabic = text => /[؀-ۿ]/.test(text);
  function codeOf(error) { return String(error?.code || (error?.name && error.name !== 'Error' ? error.name : '') || ''); }
  function describe(error, fallback = 'تعذرت العملية. حاول مرة أخرى.') {
    const raw = String(error?.message || '').trim(), code = codeOf(error);
    let text = REWRITE[raw];
    if (!text && code === 'functions/aborted') text = BY_CODE[code];
    if (!text && raw && looksArabic(raw)) text = raw;
    if (!text) text = BY_CODE[code] || fallback;
    return { text, code };
  }
  function message(error, fallback) { const d = describe(error, fallback); return d.code ? `${d.text} (رمز: ${d.code})` : d.text; }
  function render(node, error, fallback) {
    if (!node) return;
    const d = describe(error, fallback);
    node.replaceChildren?.();
    if (!node.replaceChildren) { node.textContent = message(error, fallback); return; }
    const main = document.createElement('div'); main.textContent = d.text; node.appendChild(main);
    if (d.code) { const small = document.createElement('small'); small.style.cssText = 'display:block;opacity:.7;font-size:11px;direction:ltr'; small.textContent = d.code; node.appendChild(small); }
  }
  return Object.freeze({ describe, message, render, codeOf });
})();
