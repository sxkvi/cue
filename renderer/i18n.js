/* cue — translation lookup and DOM application.
 *
 * Markup declares what it needs and this file fills it in, so a new language
 * never means touching index.html:
 *
 *   <span data-i18n="action.recap"></span>          -> textContent
 *   <button data-i18n-title="action.recap.tip">     -> title + aria-label
 *   <button data-i18n-aria="composer.send">         -> aria-label only
 *   <input data-i18n-placeholder="settings.search">
 *   <div data-i18n-html="settings.rules.help">      -> innerHTML (trusted strings)
 *
 * English is the fallback for any key a translation has not caught up with, so
 * a missing string degrades to English rather than to a raw key.
 */
(function () {
  const LOCALES = window.CUE_LOCALES || {};
  const FALLBACK = 'en';

  let current = FALLBACK;
  const listeners = new Set();

  /** Best supported locale for a BCP-47 tag such as "fr-CA". */
  function resolve(tag) {
    if (!tag) return null;
    const lower = String(tag).toLowerCase();
    if (LOCALES[lower]) return lower;
    const base = lower.split('-')[0];
    return LOCALES[base] ? base : null;
  }

  /** Pick a locale from an explicit preference, else from the system. */
  function detect(preference) {
    if (preference && preference !== 'auto') {
      const explicit = resolve(preference);
      if (explicit) return explicit;
    }
    const candidates = [].concat(navigator.languages || [], navigator.language || []);
    for (const candidate of candidates) {
      const match = resolve(candidate);
      if (match) return match;
    }
    return FALLBACK;
  }

  function strings(locale) {
    return (LOCALES[locale] && LOCALES[locale].strings) || {};
  }

  /**
   * Look up a key and substitute {placeholders}.
   * Unknown keys return the key itself — visible in the UI on purpose, so a
   * missing string is caught during development rather than shipping blank.
   */
  function t(key, vars) {
    const template = strings(current)[key] ?? strings(FALLBACK)[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
    );
  }

  /** Fill every translatable attribute inside `root` (default: the document). */
  function apply(root) {
    const scope = root || document;

    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    });
    // A title on an icon-only control is also its accessible name, so set both
    // unless the element already carries an explicit aria-label.
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const text = t(el.dataset.i18nTitle);
      el.setAttribute('title', text);
      if (!el.hasAttribute('data-i18n-aria')) el.setAttribute('aria-label', text);
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    });

    document.documentElement.lang = current;
  }

  /** Switch language and re-render. Returns the locale actually selected. */
  function set(preference) {
    const next = detect(preference);
    if (next === current) return current;
    current = next;
    apply();
    listeners.forEach((fn) => {
      try { fn(current); } catch (_) { /* a bad listener must not block the rest */ }
    });
    return current;
  }

  /** Initialise without firing listeners — for the first paint. */
  function init(preference) {
    current = detect(preference);
    apply();
    return current;
  }

  window.i18n = {
    t,
    apply,
    set,
    init,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    get locale() { return current; },
    get available() {
      return Object.keys(LOCALES).map((code) => ({ code, name: LOCALES[code].name }));
    }
  };
})();
