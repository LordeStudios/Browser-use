(function (root) {
  'use strict';

  const MAX_NAME = 96;
  const MAX_SELECTOR = 500;
  const MAX_TEXT = 40_000;
  const MAX_PREVIEW = 160;
  const PLACEHOLDER_NAME = /^dom[\s_-]*\d+$/i;

  function clean(value, max) {
    return String(value || '').replace(/\0/g, '').trim().slice(0, max);
  }

  function slug(value) {
    const source = String(value || '').trim();
    if (!source || PLACEHOLDER_NAME.test(source)) return '';
    const result = source
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .slice(0, MAX_NAME);
    return result && !PLACEHOLDER_NAME.test(result) ? result : '';
  }

  function selectorName(selector) {
    const parts = String(selector || '').split(/\s*>\s*/).map((part) => {
      const withoutAttrs = part.replace(/\[[^\]]*\]/g, '').replace(/:nth-of-type\((\d+)\)/g, '_$1');
      return slug(withoutAttrs);
    }).filter(Boolean);
    return parts.slice(-3).join('_');
  }

  function deriveDomName(element = {}) {
    const candidates = [
      element.id,
      element.testId,
      element.name,
      element.ariaLabel,
      element.title,
      element.text && String(element.text).length <= 48 && !element.id ? element.text : '',
      selectorName(element.selector),
      element.tag ? `${element.tag}_element` : 'selected_element'
    ];
    for (const candidate of candidates) {
      const name = slug(candidate);
      if (name) return name;
    }
    return 'selected_element';
  }

  function uniqueDomName(name, existing = []) {
    const taken = new Set(existing.map((item) => String(item?.name || '').toLowerCase()));
    const base = slug(name) || 'selected_element';
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}_${suffix}`)) suffix += 1;
    return `${base}_${suffix}`;
  }

  function normalizeDomAttachment(value = {}, existing = []) {
    const selector = clean(value.selector, MAX_SELECTOR);
    const name = uniqueDomName(
      PLACEHOLDER_NAME.test(String(value.name || '')) ? deriveDomName({ ...value, selector }) : (value.name || deriveDomName({ ...value, selector })),
      existing
    );
    const text = clean(value.text || value.content, MAX_TEXT);
    const previewText = clean(value.previewText || value.textPreview || value.text, MAX_PREVIEW);
    return {
      ...(value.id ? { id: clean(value.id, 120) } : {}),
      name,
      selector,
      text,
      previewText,
      ...(value.pageUrl || value.url ? { pageUrl: clean(value.pageUrl || value.url, 2_000) } : {}),
      ...(value.href ? { href: clean(value.href, 2_000) } : {}),
      ...(value.tag ? { tag: clean(value.tag, 40) } : {}),
      ...(value.role ? { role: clean(value.role, 80) } : {}),
      ...(value.classes ? { classes: clean(value.classes, 160) } : {})
    };
  }

  function normalizeDomAttachments(values) {
    if (!Array.isArray(values)) return [];
    const result = [];
    for (const value of values) result.push(normalizeDomAttachment(value, result));
    return result;
  }

  function isBoundary(text, start, end) {
    const before = start > 0 ? text[start - 1] : '';
    const after = end < text.length ? text[end] : '';
    return !/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after);
  }

  function findDomReferences(text, attachments) {
    const source = String(text || '');
    const refs = normalizeDomAttachments(attachments);
    const matches = [];
    for (const attachment of refs) {
      const name = attachment.name;
      let from = 0;
      while (from < source.length) {
        const index = source.indexOf(name, from);
        if (index < 0) break;
        const end = index + name.length;
        if (isBoundary(source, index, end)) matches.push({ index, end, attachment });
        from = end;
      }
    }
    return matches.sort((a, b) => a.index - b.index || b.end - a.end);
  }

  function replaceDomReferences(text, attachments) {
    const source = String(text || '');
    const refs = normalizeDomAttachments(attachments);
    if (!refs.length) return source;
    const byLegacyIndex = new Map(refs.map((attachment, index) => [`DOM ${index + 1}`, attachment.name]));
    return source.replace(/\bDOM \d+\b/g, (token) => byLegacyIndex.get(token) || token);
  }

  const api = { MAX_TEXT, deriveDomName, uniqueDomName, normalizeDomAttachment, normalizeDomAttachments, findDomReferences, replaceDomReferences };
  root.BrowserUseDomAttachments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
