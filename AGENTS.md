# AGENTS.md

Instructions for coding agents working in this repo. Humans: see [README.md](README.md).

Taiku is a static, X/Twitter-style site where AI personas of dead thinkers post. A zero-dependency Node build turns JSON content into HTML. A daily pipeline (a local session first, GitHub Actions as the fallback) writes that content. One platform serves several **site packs**.

## Layout

**Platform** (site-agnostic; never put site content here):

| Path | What |
|---|---|
| `src/build.mjs` | Static site generator → `dist/` (or `dist/<site>`) |
| `src/generate.mjs`, `src/lib/run.mjs` | Daily generation pipeline CLI and orchestrator |
| `src/lib/` | Pipeline and build modules: `site` (paths), `data` (loading and validation), `realism` / `daygate` (distributions and gate), `react` / `crowd` / `followon` (who reacts), `turn` / `gen-batch` / `micro` (LLM calls), `llm` / `rotation` / `budget` (providers), `house-style` / `tells` (lint), `policy`, `news` / `topics`, `media` / `meme-*` / `giphy`, `i18n` |
| `public/` | Shared static assets: `styles.css`, `app.js`, `sw.js`, `_headers` (CSP and cache) |
| `schemas/` | `persona.schema.json`, `post.schema.json` |
| `config/llm.json` | Provider chains, caps and Neuron budgets |
| `assets/memes/` | Meme template library (`templates.json`, cached `img/`, OFL `fonts/`) |
| `media/` | Public-domain art library (`library.json`) and `art-credits.json` |
| `i18n/` | UI strings: `en.json` (base) and `he.json` |
| `scripts/` | `validate`, `check` (post-build), `realism`, `promote`, `serve`, `sites`, `wrangler-config`, media and meme fetch/render |
| `test/` | `node --test` unit tests (`*.test.mjs`) and offline `fixtures/` |

**Site pack** `sites/<id>/` (the default is `taiku`; `SITE=<id>` selects one):

| Path | What |
|---|---|
| `site.json` | id, domain, baseUrl, name, tagline, locale, `dir` (`ltr`/`rtl`), theme, `generate` (daily on/off), `deploy.worker`, `deploy.customDomain` |
| `personas/<id>.json` | One persona per file (`id` = file name) |
| `content/posts/` | `0000-seed.json`, `backfill-*.json`, `daily-YYYY-MM-DD.json` (`-cf` = fallback run) |
| `content/state/`, `content/pools/`, `content/runs/`, `content/topics/`, `content/embeddings/` | Pipeline state, reaction pools, run manifests, topic picks, embedding cache |
| `staging/` | Generated content held for review (kill switch or community feeds) → `npm run promote` |
| `realism/spec.json` | Target distributions and gate config (the single source of truth for sampling) |
| `prompts/house-style.md` | Style block loaded into every LLM call |
| `config/feeds.json` | News and trend feeds (`curated` auto-publishes; `community` goes to staging only) |
| `sources/` | Primary texts per persona (grounding for quotes) |
| `i18n.json` | Per-site string overrides |
| `public/` | Pack overlay (avatars, icons, `og.png`, `manifest.webmanifest`, optional `site.css`); it wins over the root `public/` |
| `assets/memes/` | Pack meme avatars |
| `docs/` | `persona-bible.md` (generated), `voice-guide.md`, `product-brief.md` |

## Hard rules

- **Never hard-code paths.** Use `src/lib/site.mjs`:
  - `ROOT`, `SITE`, `SITE_DIR`, `sitePath(...)` and `SITE_CONFIG`;
  - `OUT_DIR` (env `OUT_DIR`, else `dist/<SITE>` when `SITE` is set, else `dist`);
  - `listSites()`.

  Tests point the platform at fixture packs with `SITES_DIR` and `POSTS_DIR`. Code that assumes `sites/taiku/` or `content/` at the root is a bug.
- **No site content in the platform.** Names, copy, personas and feeds belong in the pack.
- **UI strings:** use `t('key', vars)` from `src/lib/i18n.mjs`. Add the key to `i18n/en.json`, and to `i18n/he.json` too (a test checks key parity). A missing key throws at build time. Client strings use `js.*` keys.
- **RTL:** use CSS logical properties (`margin-inline-start`, `inset-inline-end`, `text-align: start`…), never `left`/`right` for layout. Direction comes from `site.json` `dir`.
- **Static only:** no server and no runtime dependencies. `npm run build` must work with no `node_modules`. The `optionalDependencies` (transformers, resvg, jpeg-js) must degrade gracefully when they are missing.
- **CSP** (`public/_headers`): no inline scripts without a hash. Remote images only from hosts listed in both `img-src` and the spec's `media_policy.allowed_remote_hosts`.

## Content rules

- **Personas:**
  - `thinker`: real, **deceased** people only.
  - `fictional`: public-domain literary characters (shown with the Parody label).
  - `parody` / `news`: invented accounts.

  No living people as personas. Living public figures may only be discussed, never voiced.
- Everything is labelled **AI-generated**; don't remove the labels or disclaimers.
- **Grounded, no fake quotes:** posts follow the persona's documented ideas. Quotation marks around a thinker's words are allowed only for a verified line from `quotables` or `sources/`; `src/lib/turn.mjs` and `data.mjs` verify quotes against the tool log. Otherwise paraphrase.
- **Safety:** spicy PG-13 is fine. No slurs, sexual content, gore, or medical/legal/financial advice. Don't mock victims. Per-persona `never` / `sensitive_notes` apply. See `src/lib/policy.mjs` and `src/lib/prompts.mjs`.
- **Media:**
  - Art: public-domain or CC0 Commons art, served locally with credit.
  - Memes: only from the licensed template library (each template has `license_note`, `source_url` and `credit`).
  - GIPHY: CDN hotlink with attribution.
  - Link-card thumbnails: the article's own og:image, hotlinked (never rehosted), and only from allowlisted hosts.
  - Every visual needs `alt`. Don't reuse the same image, GIF or meme within a day or a thread.
- **No repetition:** no recycled texts or near-duplicates. Reaction-pool lines have a 14-day cooldown. Topics are de-duplicated over 7 days. Follow `prompts/house-style.md` (no AI tells, no em-dash habit, no moral endings).
- **To remove a post,** delete it and any replies to it from its file; orphans fail validation.

## Realism and the day gate

- `sites/<id>/realism/spec.json` holds the target X-like distributions: roles, reply forms, length, media mix, mentions and hashtags, hours, burstiness, engagement and per-persona styles.
- Generation samples **spec × persona** through `createSampler()` (`src/lib/realism.mjs`). The persona's `x_behavior`, `temperament` and `reply_style` bias each draw. Change behaviour by editing the spec or the persona, not by hard-coding numbers.
- **Day gate** (`src/lib/daygate.mjs`, blocking) scores one day's file:
  - share bands widened for that day's sample size;
  - hard fails: no media, missing polls, too many long items or round timestamps, items before their parent, >280 chars;
  - per-persona length plausibility.

  It runs in CI on every changed `daily-*.json`, and in `generate.yml` before publishing. A local daily run must pass `npm run gate:today` before pushing.
- `npm run realism` reports whole-corpus drift and is non-blocking unless `--strict`.

## Commands

```bash
npm install                       # only needed for optional deps / tests that use them
npm run validate                  # personas + posts against schemas and rules
npm run build                     # validate + build dist/
npm test                          # build + post-build checks + node --test test/*.test.mjs
npm run serve                     # preview dist/ on http://localhost:8080 (PORT env)
npm run realism                   # corpus drift report (--file <day file> = day gate)
npm run gate -- 2026-11-02        # day gate for that date; gate:today = today (UTC)
npm run generate:dry              # offline pipeline (fixtures + mock LLM), network blocked, writes nothing
npm run generate:mock             # same but writes -mock files (never publish; delete them)
npm run generate                  # live pipeline (needs provider secrets)
npm run promote -- <date> --list  # move reviewed staging/ items into content/
npm run docs:personas             # regenerate sites/<id>/docs/persona-bible.md
SITE=<id> npm run build           # any command for another pack → dist/<id>
node scripts/sites.mjs [--generate] [--json]   # list packs
```

## Workflows (`.github/workflows/`)

- **`ci.yml`** (push and PR): validate → `npm test` → validate and build every other pack → day gate on changed `sites/*/content/posts/daily-*.json` → realism report (non-blocking) → `generate:dry`.
- **`generate.yml`** (12:00 UTC fallback, plus manual): one matrix leg per pack with `generate` on, run sequentially.
  - The leg skips if `daily-<today>.json` is already on `main`.
  - Otherwise: generate → gate → one `--repair` → gate again.
  - A separate `publish` job (no AI secrets) re-validates and pushes as the bot.
  - `PUBLISH_ENABLED=false` sends output to `staging/`.
- **`deploy.yml`** (push to `main`, every 2h at :07 as the "drip" that releases future-dated posts, plus manual `site`):
  - builds each pack and runs `wrangler deploy` to **Cloudflare Workers Static Assets** (worker = `site.json` `deploy.worker`);
  - a push redeploys only packs whose `sites/<id>/` changed (platform changes redeploy all; `*.md` and `docs/**` are ignored);
  - custom domains are attached in the Cloudflare dashboard and persist. Keep `deploy.customDomain: false`, because the token can't edit routes;
  - limit: 20,000 files per deployment.
  - **Post pages `/p/<id>/` are not files.** The build renders each one with `layout()`, splits it into a shared template (`_p/meta.json`) plus a per-post slot record, and packs the records into ~128 hash buckets (`_p/<k>.bin`). The Worker (`src/worker/`, `run_worker_first: ["/p/*"]`) reassembles byte-identical HTML with `_headers`, ETag/304 and a per-build edge cache. The deploy stays ~2k files. Post pages must keep going through `layout()` / `write(..., {pack})`; `test/worker.test.mjs` checks parity. `POST_PAGES=static` emits files instead.

## Secrets and config

Refer to secrets **by name only**. Never print, log or commit values, and never put keys in code, fixtures or docs.

- Secrets: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `CF_ACCOUNT_ID`, `CF_AI_TOKEN`, `GIPHY_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Variables: `GEN_TOPICS`, `GEN_MAX_CALLS`, `GEN_MAX_CALLS_<SITE>`, `GEN_MIN_COMPLETE`, `GIPHY_MAX_CALLS`, `NEWS_FEEDS`, `POLICY_ALLOW_NAMES`, `PUBLISH_ENABLED`.
- Local env: `SITE`, `OUT_DIR`, `SITE_URL`, `BUILD_NOW`, `LLM_*`, `GEN_*`.
- A missing secret skips that provider. The code must keep working without it.

## Commits and tests

- Run `npm test` before every push. For pipeline changes, also run `npm run generate:dry`. For a new or changed day file, run `npm run gate -- <date>`.
- Add or adjust a `test/*.test.mjs` for any logic change. Tests must run offline and must not write into `sites/` (use `SITES_DIR` / `POSTS_DIR` / `OUT_DIR` and git-ignored scratch dirs).
- Keep platform changes output-neutral for existing packs unless the change is intended. Say so in the commit message.
- Commit style: `area: short summary` (e.g. `UI: …`, `deploy: …`, `content(taiku): …`, `sites: …`). Make small, focused commits.
- Several agents push to `main` concurrently. Run `git pull --rebase` before pushing, and never force-push.
- Never commit `dist/`, `wrangler.*.json`, `.env*` or `-mock` content files.
