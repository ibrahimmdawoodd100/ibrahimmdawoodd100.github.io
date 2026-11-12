'use strict';
// Legacy templates use innerHTML. Parse in an inert template, strip executable content,
// and dispatch explicit function calls without eval or inline JavaScript.
(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const allowedTags = new Set('DIV SPAN P BR HR H1 H2 H3 H4 H5 H6 BUTTON INPUT TEXTAREA SELECT OPTION OPTGROUP LABEL TABLE THEAD TBODY TFOOT TR TH TD UL OL LI STRONG B EM I SMALL A IMG CANVAS SECTION ARTICLE HEADER FOOTER NAV DETAILS SUMMARY'.split(' '));
  function clean(markup) {
    const template = document.createElement('template');
    descriptor.set.call(template, String(markup));
    for (const node of [...template.content.querySelectorAll('*')]) {
      if (!allowedTags.has(node.tagName)) { node.remove(); continue; }
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase(), value = attr.value;
        if (name.startsWith('on') || ['srcdoc', 'formaction', 'xlink:href', 'autofocus'].includes(name)) node.removeAttribute(name);
        if (name === 'style' && /url\s*\(|expression\s*\(|@import/i.test(value)) node.removeAttribute(name);
        if (['href', 'src'].includes(name)) {
          try {
            const url = new URL(value, location.href);
            const safeImage = name === 'src' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value);
            if (!safeImage && (url.protocol !== 'https:' || (name === 'src' && url.origin !== location.origin && !/^[abc]\.tile\.openstreetmap\.org$/.test(url.hostname)))) node.removeAttribute(name);
          } catch { node.removeAttribute(name); }
        }
      }
      if (node.tagName === 'A') node.setAttribute('rel', 'noopener noreferrer');
    }
    return descriptor.get.call(template);
  }
  Object.defineProperty(Element.prototype, 'innerHTML', { ...descriptor, set(value) { descriptor.set.call(this, clean(value)); } });
  const insert = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function(position, value) { return insert.call(this, position, clean(value)); };
  function argument(raw, element, event) {
    if (raw === 'this') return element;
    if (raw === 'event') return event;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    if (/^'[^'"`\\<>\u0000-\u001f]*'$/.test(raw) || /^"[^'"`\\<>\u0000-\u001f]*"$/.test(raw)) return raw.slice(1, -1);
    throw new Error('Unsafe event argument');
  }
  function dispatch(code, element, event) {
    if (code.startsWith("if(event.key==='Enter')")) { if (event.key !== 'Enter') return; code = code.slice(23); }
    if (code === "document.getElementById('wh-sched-modal').style.display='none'") { document.getElementById('wh-sched-modal').style.display = 'none'; return; }
    for (const statement of code.split(';').filter(Boolean)) {
      if (statement === 'event.stopPropagation()') { event.stopPropagation(); continue; }
      if (statement === 'window.print()') { window.print(); continue; }
      const call = /^([A-Za-z_$][\w$]*)\((.*)\)$/.exec(statement.trim());
      if (!call || !window.BASMA_ALLOWED_ACTIONS.includes(call[1]) || typeof window[call[1]] !== 'function') return;
      const args = call[2].trim() ? call[2].split(',').map(x => argument(x.trim(), element, event)) : [];
      Promise.resolve(window[call[1]](...args)).catch(error => { if (window.showToast) window.showToast(window.BasmaErrors?.message(error, 'تعذرت العملية') ?? (error.message || 'تعذرت العملية'), 'error'); });
    }
  }
  for (const eventType of ['click', 'change', 'input', 'keydown', 'submit']) {
    document.addEventListener(eventType, event => {
      const element = event.target.closest(`[data-basma-${eventType}]`);
      if (!element) return;
      try { dispatch(element.getAttribute(`data-basma-${eventType}`), element, event); } catch { /* Reject malformed template actions. */ }
    });
  }
})();
