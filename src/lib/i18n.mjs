// UI strings: platform i18n/<lang>.json (en is the base) + the site pack's sites/<id>/i18n.json overrides.
// Values may contain trusted HTML (repo content). Plural values are objects keyed by Intl.PluralRules categories.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE_DIR, SITE_CONFIG } from './site.mjs';

const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
export const LOCALE = SITE_CONFIG.locale || 'en';
export const DIR = SITE_CONFIG.dir === 'rtl' ? 'rtl' : 'ltr';
// Content (posts, names, bios, profiles, About) may be in another language than the chrome. When it is,
// content elements carry CA (lang + dir) and <html> carries HTML_CA so app.js can tag what it renders.
// Empty when content and UI match, so single-locale sites render exactly as before.
export const CONTENT_LOCALE = SITE_CONFIG.content_locale;
export const CONTENT_DIR = SITE_CONFIG.content_dir === 'rtl' ? 'rtl' : 'ltr';
const SPLIT = CONTENT_LOCALE.split('-')[0] !== LOCALE.split('-')[0] || CONTENT_DIR !== DIR;
export const CA = SPLIT ? ` lang="${CONTENT_LOCALE}" dir="${CONTENT_DIR}"` : '';
export const HTML_CA = SPLIT ? ` data-clang="${CONTENT_LOCALE}" data-cdir="${CONTENT_DIR}"` : '';
/** Wrap inline content (a name inside a chrome sentence) in an isolated span when locales differ. */
export const cw = (html) => (CA ? `<span${CA}>${html}</span>` : html);
const LANG = LOCALE.split('-')[0];

export function loadStrings(lang = LANG, siteDir = SITE_DIR) {
  return { ...read(path.join(ROOT, 'i18n', 'en.json')), ...(lang === 'en' ? {} : read(path.join(ROOT, 'i18n', `${lang}.json`))), ...read(path.join(siteDir, 'i18n.json')) };
}
export const STRINGS = loadStrings();

const rules = new Intl.PluralRules(LOCALE);
const nf = new Intl.NumberFormat(LANG === 'en' ? 'en-US' : LOCALE);
export const fmtNumber = (n) => nf.format(n);
const BASE = { site: SITE_CONFIG.name, tagline: SITE_CONFIG.tagline };

/** t('poll.days', { n: 3 }) -> "3 days left". Throws on a missing key so packs fail the build, not the page. */
export function t(key, vars = {}) {
  let v = STRINGS[key];
  if (v == null) throw new Error(`missing i18n key "${key}" (locale ${LOCALE})`);
  if (typeof v === 'object') v = v[rules.select(Number(vars.n))] ?? v.other;
  const all = { ...BASE, ...vars };
  return String(v).replace(/\{(\w+)\}/g, (m, k) => (k in all ? String(all[k]) : m));
}

/** Strings app.js needs (js.* keys), emitted as a JSON data block only for non-English sites; app.js has English defaults. */
export function clientStrings() {
  if (LANG === 'en' && !Object.keys(read(path.join(SITE_DIR, 'i18n.json'))).some((k) => k.startsWith('js.'))) return '';
  const js = Object.fromEntries(Object.entries({ ...STRINGS }).filter(([k]) => k.startsWith('js.')).map(([k, v]) => [k.slice(3), v]));
  for (const [k, v] of Object.entries(js)) if (typeof v === 'string') js[k] = v.replace(/\{site\}/g, SITE_CONFIG.name);
  return `<script type="application/json" id="i18n">${JSON.stringify({ locale: LOCALE, s: js }).replace(/</g, '\\u003c')}</script>`;
}
