/*!
 * ToolFront — shared i18n runtime (unify-plan phase 2).
 *
 * Model: monitor's I18N_RUNTIME, which was already right — layout-injected,
 * every page gets it, clear detect priority, setLang keeps the URL in sync.
 * Extracted here so toolfront's four pages stop each shipping their own
 * variant (four variants produced the 2026-09-05 mixed-language defects).
 *
 * The runtime OWNS:
 *   - detect(): ?lang= > localStorage > navigator.language
 *   - setLang(): localStorage + ?lang= URL sync + pill state + <html lang>
 *   - the lang-toggle click binding (delegated, one owner for every page)
 *
 * A page only registers its re-render callback:
 *   window.tfOnLang(function (l) { lang = l; applyLang(); });
 *
 * Contract (unchanged by this refactor): localStorage key 'tf-lang',
 * URL param '?lang=', element ids 'lang-en' / 'lang-zh', data-i18n* attrs.
 */
(function () {
  var LS = 'tf-lang';
  var subs = [];

  function valid(l) { return l === 'en' || l === 'zh'; }

  function detect() {
    try {
      var q = new URLSearchParams(location.search).get('lang');
      if (valid(q)) { try { localStorage.setItem(LS, q); } catch (e) {} return q; }
      var saved = localStorage.getItem(LS);
      // Cookie bridge: localStorage is per-origin, so the choice made on
      // toolfront.dev must reach monitor.toolfront.dev via a parent-domain
      // functional cookie (no tracking, language only). The newer of the
      // two writes wins — a stale localStorage value must not override a
      // fresher choice made on the other subdomain.
      var lsT = parseInt(localStorage.getItem(LS + '-t') || '0', 10);
      var cm = document.cookie.match(/(?:^|;\s*)tf-lang=(en|zh)(?:;|\s|$)/);
      var cmT = parseInt((document.cookie.match(/(?:^|;\s*)tf-lang-t=(\d+)/) || [])[1] || '0', 10);
      if (cm && valid(cm[1]) && cmT >= lsT) return cm[1];
      if (valid(saved)) return saved;
    } catch (e) {}
    return (navigator.language || 'en').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  function paint(l) {
    try { document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'; } catch (e) {}
    var be = document.getElementById('lang-en'), bz = document.getElementById('lang-zh');
    if (be) be.classList.toggle('on', l === 'en');
    if (bz) bz.classList.toggle('on', l === 'zh');
  }

  window.tfLang = detect;
  window.tfOnLang = function (cb) { if (typeof cb === 'function') subs.push(cb); };

  window.tfSetLang = function (l) {
    if (!valid(l)) return;
    try { localStorage.setItem(LS, l); } catch (e) {}
    try { localStorage.setItem(LS + '-t', String(Date.now())); } catch (e) {}
    try { document.cookie = LS + '=' + l + ';domain=.toolfront.dev;path=/;max-age=31536000;samesite=Lax'; } catch (e) {}
    try { document.cookie = LS + '-t=' + Date.now() + ';domain=.toolfront.dev;path=/;max-age=31536000;samesite=Lax'; } catch (e) {}
    // Sync ?lang= so detect() (which gives the URL priority) agrees with the
    // user's choice on the next apply() — without this the click looks dead.
    try {
      var u = new URL(location.href);
      if (u.searchParams.get('lang')) u.searchParams.set('lang', l);
      else u.searchParams.append('lang', l);
      history.replaceState({}, '', u.toString());
    } catch (e) {}
    paint(l);
    for (var i = 0; i < subs.length; i++) { try { subs[i](l); } catch (e) {} }
    // Pages may re-render after this event; pill stays with the runtime.
    paint(l);
    try { document.dispatchEvent(new CustomEvent('tf:lang', { detail: { lang: l } })); } catch (e) {}
  };

  // One owner for the toggle: delegated so it works on every page and survives
  // re-renders. Pages must NOT bind #lang-en/#lang-zh themselves.
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('#lang-en,#lang-zh') : null;
    if (!t) return;
    e.preventDefault();
    window.tfSetLang(t.id === 'lang-zh' ? 'zh' : 'en');
  });

  paint(detect());
})();
