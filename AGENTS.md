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
| `site.json` | id, domain, baseUrl, name, tagline, `ui_locale` (chrome, i18n, `<html lang/dir>`, dates; default `en`), `content_locale`/`content_dir` (posts, names, bios, profiles, About; default = UI; e.g. tarya: `he`, auto `rtl`; content elements get `lang`/`dir`, so style fonts with `:lang(he)` in the pack's `public/site.css`), `profile.about` (opt-in About block: `background`, `key_works`, `wikipedia_<lang>` → `wikipedia`), legacy `locale`/`dir` (whole site in one locale), theme, `generate` (daily on/off), `deploy.worker`, `deploy.customDomain` |
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
  - per-persona length plausibility;
  - voice attribution (sites with `voice_attribution` in the spec, e.g. tarya): the day's posts with ≥ `min_letters` letters must be matched to their author by style at ≥ `min_lift`× chance, against centroids from the previous `window_days` (`dayAttribution` in `src/lib/voices.mjs`; `test/voices.test.mjs` runs the same check on the last `recent_days` daily files). Fix a failure by rewriting flat posts in the persona's idiolect, not by shortening them: items under `min_letters` aren't scored.

  It runs in CI on every changed `daily-*.json`, and in `generate.yml` before publishing. A local daily run must pass `npm run gate:today` before pushing.
- **Hand-written (session) daily runs** (`provider: "session-daily"`, written by an agent instead of `src/generate.mjs`) must keep the generator's structure. Agents writing a day freehand drifted: link cards on 54% of originals, replies piled on a few authors with few answer-backs, posts bunched at the hour the run started, and one persona posting one format all week. Workflow:
  1. `SITE=<id> npm run day:skeleton -- --date D` (`scripts/day-skeleton.mjs`) runs the real planner on a scratch copy of the corpus with today's feeds. It writes `_scratch/skeleton/<id>/daily-D.json` (the full day: authors, reply targets and A→B→A answer-backs, roles, reply forms, media, polls, link cards, topics and timestamps over the whole local day; future `createdAt` is fine, posts drip-release) and `daily-D.todo.json` (per item: persona, type, reply form, target length, parent or quoted text, topic, stance). It plans up to 6 seeds (`--tries N`) and keeps the first one with the structure fully in band, then prints the planned metrics; if every plan warns, rerun with more `--tries`.
  2. Replace every `⟦write⟧` in voice (the validator rejects leftovers). Pool, GIF-only, wire and retaik rows are already done. Keep ids, authors, parents, timestamps, media, topics and polls. Drop `quoteRefs`/`note` hints unless the text quotes that passage verbatim.
  3. Copy it to `sites/<id>/content/posts/daily-D.json`, then run `SITE=<id> npm run links:backfill -- --refresh-images` (unfurls every card into `sites/<id>/content/state/unfurl-cache.json`, swaps image-less AP/Reuters cards for the same story elsewhere, and rewrites Google News redirect links to the publisher; it runs the work in a child process and retries up to 3 times if Node crashes natively, e.g. the intermittent 0xC0000409 on Windows), then `npm run validate` and `npm run gate -- D --strict`. Warnings count: don't push until it exits 0.
  4. Commit **both** `sites/<id>/content/posts/daily-D.json` and `sites/<id>/content/state/unfurl-cache.json` (plus any other post file the backfill touched), and check `git status --short sites/<id>/content` is empty before pushing. Validation reads the committed cache: a card URL that is only in your local cache passes locally and fails CI and deploy (this is what broke Nov 5).

  Never use `news.google.com/rss/articles/…` (Google News redirect) URLs in `link_card`, `news.url` or `topic.url`: they have no preview and `npm run validate` rejects them. The planner (`fetchPool` in `src/lib/news.mjs`), the skeleton and the links backfill resolve them to the publisher's article URL (`src/lib/gnews.mjs`) or drop them.

  If you write without the skeleton, follow the same rules. Put a `news` object or `link_card` on at most ~10% of originals (`news.url` counts as a link card; use `topic` for the story otherwise). Spread replies over many authors, with nobody getting more than ~4 fresh replies, and have ~half the people replied to answer back (reply reciprocity ≥ 0.3). Spread timestamps over the whole local day by `sampling.diurnal_local`, including the small hours. Give anyone the gate flags for `persona.format_entropy` 2-3 originals in formats they haven't used this week.
  **Be the character, not the biography.** Each persona lives in today's feed: react to the news, people and thread with their temperament, values, obsessions, pettiness, humor and verbal tics. Don't have them retell their own famous deeds, works or signature episode in the first person (Moses "I split the sea", Herzl "בבזל ייסדתי את המדינה", Ben-Yehuda "המילון שלי", Curie "I gave away the radium patent"). A rare oblique allusion is fine; a retelling is not. `src/lib/selfbio.mjs` counts first-person self-biography (key_works, background, `signature_episodes` in `ideas/<id>.json`, Hebrew cues like "אני ש…תי", "כשאני…", "כתבתי/הקמתי/ייסדתי…", English "I founded/wrote/discovered…"). The gate (`persona.self_bio`, blocking when `gate.self_bio_blocking`) and `npm run repetition:audit` cap it at ≤10% of a persona's posts and ≤5% site-wide, with no repeat of the same episode by the same persona within 14 days. Examples:
  - BAD: "טקסס מחייבת לתלות את עשרת הדברות בכיתות. אני הורדתי אותם מההר פעמיים." GOOD: "טקסס מחייבת לתלות את עשרת הדברות בכיתות. יפה. עכשיו שיקראו אותן."
  - BAD: "Spent decades on earthworms. Nobody believes me when I say it's my most exciting book." GOOD: "Earthworms are exciting. Nobody believes it. Go outside after rain and count."
- The planner spreads replies with `sampling.conversation.target_saturation` (each fresh reply to an author who already got n today is scaled by 1/(1+n/s)), damps repeat original authorship within a day, and gives "rotation debt" slots to personas whose last week is one format (`rotationDebt` in `src/lib/formats.mjs`).
- `npm run realism` reports whole-corpus drift and is non-blocking unless `--strict`.
- **spec.json holds distributions, not people.** No real users' content, names, handles or x.com/twitter.com post or profile URLs. Example strings must be invented (`💀`, `source?`); research citations are fine. `test/realism.test.mjs` enforces this for every `sites/*/realism/spec.json`: any `@handle` must be a persona in that pack or a generic term (`@mention`, `@user`, `@handle`).

## Commands

```bash
npm ci --ignore-scripts           # only needed for optional deps / tests that use them (exact pins in package-lock.json)
npm run validate                  # personas + posts against schemas and rules
npm run build                     # validate + build dist/
npm test                          # build + post-build checks + node --test test/*.test.mjs
npm run serve                     # preview dist/ on http://localhost:8080 (PORT env)
npm run realism                   # corpus drift report (--file <day file> = day gate)
npm run gate -- 2026-11-02        # day gate for that date; gate:today = today (UTC); --strict = warnings fail too
npm run day:skeleton -- --date D  # plan a hand-written day (SITE=<id>); see "Hand-written daily runs"
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
  - The leg skips (green, with a notice) if `daily-<today>.json` is already on `main`; publish re-checks `main` and never overwrites a local run pushed meanwhile.
  - Otherwise: generate → gate → one `--repair` (a flagged self-thread part regenerates its whole thread) → gate again.
  - Deep-thread packs (`sampling.conversation.daily_reactions`, currently taiku/tarya) finish five persona replies per original before starting the next, prioritize deduplicated main curated news, and withhold roots with fewer than four replies. Quota/time exhaustion may publish the complete subset only after the normal validation and blocking gate/repair. Likes, reposts and self-continuations never satisfy the reply floor. New files carry `threadPolicy`; the matching role bands and hard thread check apply only to those files.
  - Quota days without any usable complete threads remain **partial**, ending green with a `::warning::`, a job summary, and nothing published (`scripts/ci-generate.sh`). A post-repair gate failure caused by quota is still skipped, never published. Exceptions, invalid output and missing credentials still fail.
  - Provider use is free-only: explicit `:free` OpenRouter models, or verified `CF_FREE_ONLY` / `GROQ_FREE_ONLY` / `GEMINI_FREE_ONLY` attestations for dedicated accounts with paid overflow disabled. A shared, per-attempt ledger is restored/uploaded across serialized site legs and reruns, including failed days. See README's daily free-budget policy for caps, request bounds, UTC rollover and cancellation limitations. Do not set these attestations without verifying the billing configuration.
  - A separate `publish` job (no AI secrets) re-validates and pushes as the bot.
  - `PUBLISH_ENABLED=false` sends output to `staging/`.
- **`deploy.yml`** (push to `main`, every 2h at :07 as the "drip" that releases future-dated posts, plus manual `site`):
  - builds each pack and runs `wrangler deploy` to **Cloudflare Workers Static Assets** (worker = `site.json` `deploy.worker`);
  - a push redeploys only packs whose `sites/<id>/` changed (platform changes redeploy all; `*.md` and `docs/**` are ignored);
  - custom domains are attached in the Cloudflare dashboard and persist. Keep `deploy.customDomain: false`, because the token can't edit routes;
  - limit: 20,000 files per deployment.
  - **Post pages `/p/<id>/` are not files.** The build renders each one with `layout()`, splits it into a shared template (`_p/meta.json`) plus a per-post slot record, and packs the records into ~128 hash buckets (`_p/<k>.bin`). The Worker (`src/worker/`, `run_worker_first: ["/p/*"]`) reassembles byte-identical HTML with `_headers`, ETag/304 and a per-build edge cache. The deploy stays ~2k files. Post pages must keep going through `layout()` / `write(..., {pack})`; `test/worker.test.mjs` checks parity. `POST_PAGES=static` emits files instead.
   - **Real poll votes** (`src/worker/polls.mjs`): the Worker exposes `GET /api/polls?ids=a,b` and `POST /api/poll/<id> {opt}`. Each poll gets its own SQLite-backed Durable Object (`PollVotes`, binding `POLLS`, created by a wrangler migration). Only polls listed in the build's `_p/polls.json` (options plus end time) accept votes, and only until they close. Limits: one vote per HMAC of IP+UA, at most 5 votes per IP per poll, a 20k cap per poll, Workers Rate Limiting bindings (`VOTE_RL`, `READ_RL`), and same-origin, JSON-only POSTs. The HMAC is keyed by the Worker secret `POLL_SECRET` (rotates daily; deploy.yml creates it once). Raw IPs and UAs are never stored. Voter keys are deleted 30 days after the poll closes; totals are kept. Shown counts = the simulated `data-votes` in the HTML + real votes. `public/app.js` falls back to a local-only vote if the API fails. Tests: `test/polls.test.mjs`.

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
