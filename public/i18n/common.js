/*!
 * ToolFront — shared i18n single source of truth.
 *
 * Every cross-page string (navigation, footer, language labels) lives here
 * exactly once. Pages keep only their own private copy and fall back to this
 * file, so a string can never be updated in one page and forgotten in another
 * (the cause of the 2026-09-05 bilingual mismatches).
 *
 * Shape: { en: { key: text }, zh: { key: text } }
 * ALIASES map legacy key names to the canonical ones so pages can migrate
 * incrementally instead of in one risky sweep.
 */
window.I18N_COMMON = {
  en: {
    'nav.scanner': 'Scanner',
    'nav.compare': 'Compare',
    'nav.rankings': 'Rankings',
    'nav.monitor': 'Monitor',
    'foot.methodology': 'Methodology',
    'foot.privacy': 'Privacy',
    'foot.security': 'Security',
    'foot.terms': 'Terms',
    'lang.en': 'EN',
    'lang.zh': '中文'
  },
  zh: {
    'nav.scanner': '扫描器',
    'nav.compare': '对比',
    'nav.rankings': '排行榜',
    'nav.monitor': '监控',
    'foot.methodology': '评分方法',
    'foot.privacy': '隐私政策',
    'foot.security': '安全',
    'foot.terms': '服务条款',
    'lang.en': 'EN',
    'lang.zh': '中文'
  }
};

/* Legacy key names still used by some pages -> canonical key. */
window.I18N_ALIASES = {
  'nav.scan': 'nav.scanner',
  'nav.cmp': 'nav.compare',
  'nav.rank': 'nav.rankings',
  'nav.mon': 'nav.monitor',
  'rfoot.methodology': 'foot.methodology',
  'rfoot.privacy': 'foot.privacy',
  'rfoot.security': 'foot.security',
  'foot.meth': 'foot.methodology'
};

/* Shared resolver: page dictionary first, then this file, then alias, then key. */
window.tfCommon = function (dict, lang, key) {
  var v = dict && dict[key];
  if (v != null) return v;
  var canon = (window.I18N_ALIASES && window.I18N_ALIASES[key]) || key;
  var common = window.I18N_COMMON && window.I18N_COMMON[lang];
  if (common && common[canon] != null) return common[canon];
  return null;
};
