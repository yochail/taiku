// Site packs: the platform (src/, public/, schemas/, config/llm.json, workflows) is site-agnostic;
// each site's content lives in sites/<id>/ (site.json, personas/, content/, realism/, prompts/,
// sources/, config/feeds.json, i18n/, public/). SITE=<id> selects the pack (default: taiku).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// SITES_DIR env: tests point the platform at fixture packs.
export const SITES_DIR = process.env.SITES_DIR ? path.resolve(ROOT, process.env.SITES_DIR) : path.join(ROOT, 'sites');
export const DEFAULT_SITE = 'taiku';
export const SITE = process.env.SITE || DEFAULT_SITE;
if (!/^[a-z0-9][a-z0-9-]*$/.test(SITE)) throw new Error(`invalid SITE "${SITE}"`);

/** Root of a site pack (sites/<id>). */
export function siteDir(id = SITE) {
  const dir = path.join(SITES_DIR, id);
  if (fs.existsSync(dir)) return dir;
  throw new Error(`unknown site "${id}" (no ${path.relative(ROOT, dir)})`);
}

export const SITE_DIR = siteDir();
export const sitePath = (...parts) => path.join(SITE_DIR, ...parts);

const RTL_LANGS = /^(he|iw|ar|fa|ur|yi|ps|sd|ug|dv)\b/i;
export const dirOf = (locale) => (RTL_LANGS.test(locale) ? 'rtl' : 'ltr');

/**
 * Locales from site.json. ui_locale/ui_dir: app chrome, i18n strings, <html lang/dir>, dates (default en/ltr).
 * content_locale/content_dir: posts, names, bios, profiles and About text (default: same as the UI).
 * Legacy locale/dir mean the whole site (UI and content) is in that locale.
 */
export function resolveLocales(cfg) {
  const ui = cfg.ui_locale ?? cfg.locale ?? 'en';
  const uiDir = cfg.ui_dir ?? (cfg.ui_locale == null && cfg.dir ? cfg.dir : dirOf(ui));
  const content = cfg.content_locale ?? ui;
  const contentDir = cfg.content_dir ?? (cfg.content_locale == null ? uiDir : dirOf(content));
  for (const l of [ui, content]) if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)) throw new Error(`invalid locale "${l}" in site.json`);
  return { ui_locale: ui, ui_dir: uiDir, content_locale: content, content_dir: contentDir, locale: ui, dir: uiDir };
}

/** sites/<id>/site.json: domain, name, tagline, description, ui_locale, content_locale, theme, social. */
export const SITE_CONFIG = (() => {
  const file = path.join(SITE_DIR, 'site.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { id: SITE, theme: {}, social: {}, ...cfg, ...resolveLocales(cfg) };
})();

/** Build output: OUT_DIR env, else dist/<id> when SITE is set explicitly, else dist (taiku.app's Pages project). */
export const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || (process.env.SITE ? path.join('dist', SITE) : 'dist'));

/** All site ids with a pack under sites/ (the default site is always included). */
export function listSites() {
  const ids = fs.existsSync(SITES_DIR) ? fs.readdirSync(SITES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(SITES_DIR, d.name, 'site.json'))).map((d) => d.name) : [];
  return [...new Set([DEFAULT_SITE, ...ids])].sort();
}
