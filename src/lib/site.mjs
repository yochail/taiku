// Site packs: the platform (src/, public/, schemas/, config/llm.json, workflows) is site-agnostic;
// each site's content lives in sites/<id>/ (site.json, personas/, content/, realism/, prompts/,
// sources/, config/feeds.json, i18n/, public/). SITE=<id> selects the pack (default: taiku).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SITES_DIR = path.join(ROOT, 'sites');
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

/** sites/<id>/site.json: domain, name, tagline, description, locale, dir, theme, social. */
export const SITE_CONFIG = (() => {
  const file = path.join(SITE_DIR, 'site.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { id: SITE, locale: 'en', dir: 'ltr', theme: {}, social: {}, ...cfg };
})();

/** Build output: OUT_DIR env, else dist/<id> when SITE is set explicitly, else dist (taiku.app's Pages project). */
export const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || (process.env.SITE ? path.join('dist', SITE) : 'dist'));

/** All site ids with a pack under sites/ (the default site is always included). */
export function listSites() {
  const ids = fs.existsSync(SITES_DIR) ? fs.readdirSync(SITES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(SITES_DIR, d.name, 'site.json'))).map((d) => d.name) : [];
  return [...new Set([DEFAULT_SITE, ...ids])].sort();
}
