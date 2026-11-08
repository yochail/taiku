#!/usr/bin/env bash
# CI wrapper for the Daily feed fallback (.github/workflows/generate.yml): runs `npm run generate`
# (or generate:mock) and classifies the result so quota days don't page anyone.
#
#   exit 0 from generate (complete)               -> ok
#   exit 2 (partial: below GEN_MIN_COMPLETE, or the
#     free-tier LLM quota / wall clock ran out)  -> soft skip: ::warning::, job summary, step output
#                                                   soft=true and gen-meta/skipped.txt; exits 0 and
#                                                   nothing is published (the local run covers the day)
#   anything else, when the fatal error is a
#     quota / rate-limit error (HTTP 429, capped
#     models; scripts/ci-quota.mjs log)          -> soft skip, as above
#   anything else (invalid output, exceptions,
#     missing credentials)                        -> fail (a real error)
#
# Whatever the exit code, when the run manifest shows providers were quota- or rate-limited
# (scripts/ci-quota.mjs manifest: budget hit, wall clock, 429s, capped models) the step also outputs
# quota=true. The workflow uses that after `--repair`: a day gate that still fails because the repair
# was rate-limited is a quota day, not a defect.
#
# Env: SITE, GEN_DATE, DAYFILE (this run's day file), optional GEN_NONCE, FORCE, MOCK. Extra args go to generate.
set -uo pipefail
export TRANSFORMERS_CACHE="$HOME/.cache/taiku-hf"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
args=(--date "$GEN_DATE" "$@")
[ -n "${GEN_NONCE:-}" ] && args+=(--nonce "$GEN_NONCE")
[ -n "${FORCE:-}" ] && args+=(--force)
script=generate
[ -n "${MOCK:-}" ] && script=generate:mock
mkdir -p gen-meta
log="gen-meta/generate${*:+-${*//[^a-z]/}}.log"
npm run "$script" -- "${args[@]}" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}

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

# Only a manifest this run wrote counts: a run that died early, or a --repair that had nothing to
# regenerate, leaves the previous one.
quota=""
if { [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; } && ! grep -qE "not repairing|nothing to repair|local run present, skipping" "$log"; then quota="$(node "$here/ci-quota.mjs" manifest "$manifest" 2>/dev/null)"; fi
if [ -n "$quota" ]; then
  echo "quota=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  printf '%s\n' "$quota" > gen-meta/quota${*:+-${*//[^a-z]/}}.txt
fi

soft_skip() { # $1 = why (one line), $2 = summary paragraph
  echo "::warning title=Daily feed fallback skipped ($SITE)::generate ${*:3}${3:+ }$1 for $GEN_DATE ($facts). Nothing is published; the local daily run (or a rerun of this workflow for the same date, which resumes) covers the day."
  {
    echo "### Daily feed fallback: \`$SITE\` $GEN_DATE skipped"
    echo
    echo "$2"
    echo
    echo "- $facts"
    [ -n "$quota" ] && echo "- Rate / quota limits: $quota"
    echo "- Nothing was published for this site. Rerun the workflow for the same date to resume, or push the local run."
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  printf '%s %s %s\n' "$1" "$GEN_DATE" "$facts" > gen-meta/skipped.txt
  echo "soft=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
}

case "$rc" in
  0)
    echo "generate ($SITE $GEN_DATE${*:+ $*}): complete. $facts${quota:+; rate-limited: $quota}"
    ;;
  2)
    soft_skip "ended PARTIAL" "The Workers AI fallback ${*:+(\`$*\`) }ended **partial**, below the completeness floor (\`GEN_MIN_COMPLETE\`), usually because the free-tier LLM quotas (Groq / Gemini / OpenRouter / Workers AI) were exhausted." "$@"
    ;;
  *)
    if err="$(node "$here/ci-quota.mjs" log "$log" 2>/dev/null)"; then
      quota="$err"
      soft_skip "failed on LLM quota / rate limits ($err)" "The Workers AI fallback ${*:+(\`$*\`) }stopped on a free-tier LLM quota / rate-limit error (Groq / Gemini / OpenRouter / Workers AI), not a code error." "$@"
    fi
    echo "::error title=Daily feed fallback failed ($SITE)::generate ${*:+$* }exited $rc for $GEN_DATE ($facts). This is a real error (invalid output, an exception or missing credentials), not quota."
    exit "$rc"
    ;;
esac
