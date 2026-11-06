#!/usr/bin/env bash
# CI wrapper for the Daily feed fallback (.github/workflows/generate.yml): runs `npm run generate`
# (or generate:mock) and classifies the result so quota days don't page anyone.
#
#   exit 0 from generate (complete)               -> ok
#   exit 2 (partial: below GEN_MIN_COMPLETE, or the
#     free-tier LLM quota / wall clock ran out)  -> soft skip: ::warning::, job summary, step output
#                                                   soft=true and gen-meta/skipped.txt; exits 0 and
#                                                   nothing is published (the local run covers the day)
#   anything else (invalid output, exceptions,
#     missing credentials)                        -> fail (a real error)
#
# Env: SITE, GEN_DATE, DAYFILE (this run's day file), optional GEN_NONCE, FORCE, MOCK. Extra args go to generate.
set -uo pipefail
export TRANSFORMERS_CACHE="$HOME/.cache/taiku-hf"
args=(--date "$GEN_DATE" "$@")
[ -n "${GEN_NONCE:-}" ] && args+=(--nonce "$GEN_NONCE")
[ -n "${FORCE:-}" ] && args+=(--force)
script=generate
[ -n "${MOCK:-}" ] && script=generate:mock
npm run "$script" -- "${args[@]}"
rc=$?

# The run manifest sits next to the day file: content/posts/daily-<date><sfx>.json -> content/runs/<date><sfx>.json
manifest="$(dirname "$(dirname "$DAYFILE")")/runs/$(basename "$DAYFILE" .json | sed 's/^daily-//').json"
facts="$(node -e '
  const fs = require("fs");
  let m = null;
  try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
  if (!m) { console.log("no run manifest"); process.exit(0); }
  const c = m?.completeness ?? {}, b = m?.budget ?? {};
  const why = [b.budgetHit && "LLM quota / call budget exhausted", b.timeUp && "wall clock reached"].filter(Boolean).join(", ");
  console.log(`status ${m?.status ?? "unknown"}: ${c.done ?? "?"}/${c.counted ?? "?"} items (ratio ${c.ratio ?? "?"}, min ${c.minRatio ?? "?"}), topics ${c.topicsOk ?? "?"}/${c.topics ?? "?"}${why ? "; " + why : ""}`);
' "$manifest" 2>/dev/null || echo "no run manifest")"

case "$rc" in
  0)
    echo "generate ($SITE $GEN_DATE${*:+ $*}): complete. $facts"
    ;;
  2)
    echo "::warning title=Daily feed fallback skipped ($SITE)::generate ${*:+$* }ended PARTIAL for $GEN_DATE ($facts). Nothing is published; the local daily run (or a rerun of this workflow for the same date, which resumes) covers the day."
    {
      echo "### Daily feed fallback: \`$SITE\` $GEN_DATE skipped"
      echo
      echo "The Workers AI fallback ${*:+(\`$*\`) }ended **partial**, below the completeness floor (\`GEN_MIN_COMPLETE\`), usually because the free-tier LLM quotas (Groq / Gemini / OpenRouter / Workers AI) were exhausted."
      echo
      echo "- $facts"
      echo "- Nothing was published for this site. Rerun the workflow for the same date to resume, or push the local run."
    } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    mkdir -p gen-meta
    printf 'partial %s %s\n' "$GEN_DATE" "$facts" > gen-meta/skipped.txt
    echo "soft=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
    ;;
  *)
    echo "::error title=Daily feed fallback failed ($SITE)::generate ${*:+$* }exited $rc for $GEN_DATE ($facts). This is a real error (invalid output, an exception or missing credentials), not quota."
    exit "$rc"
    ;;
esac
