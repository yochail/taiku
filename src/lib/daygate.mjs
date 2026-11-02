// Blocking per-day distribution gate: scores ONE day's generated file against realism/spec.json.
//
// A day is ~150 items, so spec bands (written for the whole corpus) are widened per metric:
// share metrics by a binomial z-interval at the day's n (spec.gate.ci_z), other metrics by
// spec.gate.relative_slack. Only spec.gate.blocking metrics and the hard checks fail the gate;
// everything else is reported. Personas with >= gate.persona_min_items items must also look like
// themselves: their share of short items (<= gate.persona_short_chars) has to be plausible for
// their x_behavior / temperament (realism.lengthWeights + expectedReplyForms).
//
// Returns offenders [{ postId, taskId, reason, length? }] the pipeline can regenerate once
// (generate --repair), and a short markdown scorecard.
import { withDisplayStats } from './crowd.mjs';
import { rotationStats } from './formats.mjs';
import { maxSimilarityByPersona, noveltyConfig, scanRepetition } from './ideas.mjs';
import { scanSelfBio, selfBioConfig } from './selfbio.mjs';
import { classify, evaluate, expectedReplyForms, lengthWeights, measure, mediaOf, personaReplyStyle } from './realism.mjs';

const charLen = (text) => [...String(text ?? '')].length;
const SHORT_FORMS = new Set(['emoji_only', 'few_words', 'gif_only', 'meme_only', 'image_only', 'media_only', 'short']);
const isShare = (id) => /share/.test(id);
const pct = (v) => `${Math.round(v * 100)}%`;
const round = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? v : Math.round(v * 10 ** d) / 10 ** d);

/** Spec band widened for a sample of n: binomial z-interval for shares, relative slack otherwise. */
export function widenBand(id, t, n, gate) {
  if (isShare(id) && n > 0) {
    const z = gate.ci_z ?? 1.96;
    const se = (p) => z * Math.sqrt(Math.max(p, 0.01) * Math.max(1 - p, 0.01) / n);
    return { min: Math.max(0, t.min - se(t.min)), max: Math.min(1, t.max + se(t.max)) };
  }
  const s = gate.relative_slack ?? 0.15;
  return { min: t.min - Math.abs(t.min) * s, max: t.max + Math.abs(t.max) * s };
}

/** Share of the persona's length-bucket mass in [from, to] (partial buckets pro rata). */
function bucketMass(spec, persona, from, to) {
  const w = lengthWeights(spec, persona);
  let s = 0;
  spec.sampling.length_chars.buckets.forEach(([lo, hi], i) => {
    const a = Math.max(lo, from);
    const b = Math.min(hi, to);
    if (b >= a) s += w[i] * ((b - a + 1) / (hi - lo + 1));
  });
  return s / (w.reduce((x, y) => x + y, 0) || 1);
}

/**
 * Expected P(item <= shortChars) and P(item > 140) for one item by this persona in this role.
 * Originals draw from the persona's length buckets; replies/quotes from the persona's reply-form mix
 * (small forms are short by definition, full forms draw the buckets above shortChars).
 */
function expectedShape(spec, persona, role, shortChars) {
  if (role === 'reply' || role === 'quote') {
    const f = expectedReplyForms(spec, role, persona);
    const small = Math.min(1, Object.entries(f).filter(([k]) => SHORT_FORMS.has(k)).reduce((s, [, v]) => s + v, 0));
    const aboveShort = bucketMass(spec, persona, shortChars + 1, 280) || 1;
    return { short: small, long: (1 - small) * (bucketMass(spec, persona, 141, 280) / aboveShort) };
  }
  return { short: bucketMass(spec, persona, 1, shortChars), long: bucketMass(spec, persona, 141, 280) };
}

/**
 * Gate one day.
 *   posts:     the day's file posts (incl. retaik rows)
 *   context:   every other post (parents/quotes for timing + role checks)
 *   personas, spec
 */
/** P(X <= k) for X ~ Binomial(n, p). */
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  p = Math.min(1 - 1e-9, Math.max(1e-9, p));
  let term = (1 - p) ** n;
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    sum += term;
  }
  return Math.min(1, sum);
}

export function gateDay({ posts, context = [], personas, spec, label = 'day' }) {
  const gate = spec.gate ?? {};
  const byP = new Map(personas.map((p) => [p.id, p]));
  const day = posts.map((p) => ({ ...p }));
  withDisplayStats(day, personas);
  const all = new Map([...context, ...day].map((p) => [p.id, p]));
  const authored = day.filter((p) => !p.retaikOf);
  const role = (p) => classify(p, all);
  const lenOf = (p) => charLen(p.text);
  const checks = [];
  const add = (c) => checks.push({ blocking: false, ...c });

  // 1) Spec metrics on the day's posts, bands widened for this n.
  const blocking = new Set(gate.blocking ?? []);
  const results = evaluate(measure(day, personas, spec, { context }), spec);
  for (const r of results) {
    const t = spec.metrics[r.id];
    const isBlocking = blocking.has(r.id) || t.severity === 'fail';
    if (r.value === null || r.value === undefined || Number.isNaN(r.value) || r.n < (t.severity === 'fail' ? 1 : Math.min(t.min_n ?? 0, 10))) {
      add({ id: r.id, status: 'skip', value: r.value, n: r.n, min: t.min, max: t.max, blocking: isBlocking });
      continue;
    }
    const band = t.severity === 'fail' ? { min: t.min, max: t.max } : widenBand(r.id, t, r.n, gate);
    const ok = r.value >= band.min && r.value <= band.max;
    add({ id: r.id, status: ok ? 'pass' : isBlocking ? 'fail' : 'warn', value: r.value, n: r.n, min: band.min, max: band.max, blocking: isBlocking, detail: Array.isArray(r.detail) && typeof r.detail[0] === 'string' ? r.detail : undefined });
  }

  // 2) Hard checks.
  const mediaItems = authored.flatMap((p) => mediaOf(p)).length;
  add({ id: 'hard.media_items', status: mediaItems >= (gate.min_media_items ?? 1) ? 'pass' : 'fail', value: mediaItems, n: authored.length, min: gate.min_media_items ?? 1, max: null, blocking: true });
  const originals = authored.filter((p) => role(p) === 'original');
  const polls = authored.filter((p) => p.poll || mediaOf(p).some((m) => m.kind === 'poll')).length;
  const pollsExpected = originals.length >= (gate.min_originals_for_poll ?? 20) ? gate.min_polls ?? 1 : 0;
  add({ id: 'hard.polls', status: polls >= pollsExpected ? 'pass' : 'fail', value: polls, n: originals.length, min: pollsExpected, max: null, blocking: true });
  const lens = authored.map(lenOf).filter((l) => l > 0);
  const over140 = lens.length ? lens.filter((l) => l > 140).length / lens.length : 0;
  add({ id: 'hard.over_140_share', status: over140 <= (gate.max_over_140_share ?? 0.2) ? 'pass' : 'fail', value: over140, n: lens.length, min: null, max: gate.max_over_140_share ?? 0.2, blocking: true });
  const timed = day.filter((p) => !Number.isNaN(Date.parse(p.createdAt)));
  const round5 = timed.length ? timed.filter((p) => new Date(p.createdAt).getUTCMinutes() % 5 === 0).length / timed.length : 0;
  add({ id: 'hard.round_minute_share', status: round5 <= (gate.max_round_minute_share ?? 0.4) ? 'pass' : 'fail', value: round5, n: timed.length, min: null, max: gate.max_round_minute_share ?? 0.4, blocking: true });
  const early = [];
  for (const p of day) for (const ref of [p.inReplyTo, p.quoteOf, p.retaikOf]) {
    const parent = ref && all.get(ref);
    if (parent && Date.parse(p.createdAt) < Date.parse(parent.createdAt)) early.push(`${p.id} before ${parent.id}`);
  }
  add({ id: 'hard.before_parent_any_file', status: early.length ? 'fail' : 'pass', value: early.length, n: day.length, min: 0, max: 0, blocking: true, detail: early.slice(0, 10) });

  // 3) Per persona: short-item share plausible for the persona's style.
  const minItems = gate.persona_min_items ?? 5;
  const shortChars = gate.persona_short_chars ?? 40;
  const slack = gate.persona_slack ?? 0.2;
  const pz = gate.persona_z ?? 2;
  const personaRows = [];
  const byAuthor = new Map();
  for (const p of authored) {
    if (role(p) === 'thread_part') continue;
    if (!byAuthor.has(p.authorId)) byAuthor.set(p.authorId, []);
    byAuthor.get(p.authorId).push(p);
  }
  for (const [pid, items] of byAuthor) {
    const persona = byP.get(pid);
    if (!persona || items.length < minItems) continue;
    const n = items.length;
    const shapes = items.map((p) => expectedShape(spec, persona, role(p), shortChars));
    const exp = shapes.reduce((s, x) => s + x.short, 0) / n;
    const expLong = shapes.reduce((s, x) => s + x.long, 0) / n;
    const obs = items.filter((p) => lenOf(p) <= shortChars).length / n;
    const obsLong = items.filter((p) => lenOf(p) > 140).length / n;
    const tolOf = (p) => pz * Math.sqrt(Math.max(p * (1 - p), 0.02) / n) + slack;
    const tol = tolOf(exp);
    const tolLong = tolOf(expLong);
    const sorted = items.map(lenOf).sort((a, b) => a - b);
    // A band miss must also be unlikely under the binomial (alpha per persona): with ~20 personas a
    // day, a 7-item persona at the band edge is otherwise a routine false alarm.
    const alpha = gate.persona_alpha ?? 0.002;
    const kShort = items.filter((p) => lenOf(p) <= shortChars).length;
    const kLong = items.filter((p) => lenOf(p) > 140).length;
    const tooLong = (obs < exp - tol && binomCdf(kShort, n, exp) < alpha) || (obsLong > expLong + tolLong && 1 - binomCdf(kLong - 1, n, expLong) < alpha);
    const tooShort = obs > exp + tol && 1 - binomCdf(kShort - 1, n, exp) < alpha;
    const row = { personaId: pid, style: personaReplyStyle(spec, persona), n, expectedShort: exp, shortShare: obs, tolerance: tol, expectedLong: expLong, longShare: obsLong, toleranceLong: tolLong, median: sorted[n >> 1], status: tooLong || tooShort ? 'fail' : 'pass', tooLong, items };
    personaRows.push(row);
  }
  const personaFails = personaRows.filter((r) => r.status === 'fail');
  add({ id: 'persona.length_mix', status: personaFails.length ? 'fail' : 'pass', value: personaFails.length, n: personaRows.length, min: 0, max: 0, blocking: true, detail: personaFails.map((r) => `${r.personaId} (${r.style}): ${pct(r.shortShare)} short (expected ${pct(r.expectedShort)} ±${pct(r.tolerance)}), ${pct(r.longShare)} over 140 (expected ${pct(r.expectedLong)} +${pct(r.toleranceLong)})`) });

  // 3b) Per persona format rotation over the day + previous days (news accounts exempt).
  const winDays = gate.format_window_days ?? 7;
  const dayStart = Math.min(...day.map((p) => Date.parse(p.createdAt)).filter((t) => !Number.isNaN(t)));
  const todayIds = new Set(day.map((p) => p.id));
  const window = Number.isFinite(dayStart) ? [...context.filter((p) => { const t = Date.parse(p.createdAt); return t < dayStart && t >= dayStart - (winDays - 1) * 864e5; }), ...day] : day;
  const rotRows = rotationStats(window).filter((r) => byP.get(r.personaId) && (byP.get(r.personaId).kind ?? 'thinker') !== 'news' && r.n >= (gate.format_min_items ?? 5));
  const maxRunAllowed = gate.max_format_run ?? 4;
  const runFails = rotRows.filter((r) => r.maxRun > maxRunAllowed && r.run.ids.some((id) => todayIds.has(id)));
  add({ id: 'persona.format_run', status: runFails.length ? 'fail' : 'pass', value: Math.max(0, ...rotRows.map((r) => r.maxRun)), n: rotRows.length, min: null, max: maxRunAllowed, blocking: true, detail: runFails.map((r) => `${r.personaId}: ${r.maxRun}× ${r.run.f} in a row (${r.run.ids.slice(-3).join(', ')})`) });
  const minH = gate.min_format_entropy_bits ?? 1;
  const lowH = rotRows.filter((r) => r.entropy < minH && r.formats.length >= Math.max(gate.format_min_items ?? 5, 6));
  add({ id: 'persona.format_entropy', status: lowH.length ? 'warn' : 'pass', value: rotRows.length ? Math.min(...rotRows.map((r) => r.entropy)) : null, n: rotRows.length, min: minH, max: null, blocking: false, detail: lowH.map((r) => `${r.personaId}: ${r.entropy.toFixed(2)} bits over ${r.n}`) });

  // 3c) Novelty: today's taiks vs the same persona's last window (and earlier today) + catchphrase caps.
  const ncfg = noveltyConfig(spec);
  const novWindow = Number.isFinite(dayStart) ? [...context.filter((p) => { const t = Date.parse(p.createdAt); return t < dayStart && t >= dayStart - Math.max(ncfg.window_days, ncfg.catchphrase_window_days) * 864e5; }), ...day] : day;
  const isToday = (p) => todayIds.has(p.id);
  const repeats = scanRepetition(novWindow, { personas, cfg: ncfg, isTarget: isToday });
  add({ id: 'persona.novelty', status: repeats.length ? (gate.novelty_blocking === false ? 'warn' : 'fail') : 'pass', value: repeats.length, n: authored.length, min: 0, max: 0, blocking: gate.novelty_blocking !== false, detail: repeats.map((r) => `${r.personaId}: ${r.postId} ${r.reason === 'catchphrase' ? `catchphrase "${r.label}"` : `repeats ${r.otherId} (cos ${r.score}${r.gram ? `, "${r.gram}"` : ''})`}`) });
  const sims = maxSimilarityByPersona(novWindow.filter((p) => Date.parse(p.createdAt) >= dayStart - ncfg.window_days * 864e5 || isToday(p)), { personas, cfg: ncfg, isTarget: isToday });
  const topSim = [...sims].sort((a, b) => b[1] - a[1])[0];
  add({ id: 'persona.max_similarity', status: 'pass', value: topSim ? topSim[1] : null, n: sims.size, min: null, max: ncfg.cosine, blocking: false, detail: topSim ? [`${topSim[0]}`] : undefined });

  // 3d) Self-biography: personas retelling their own famous deeds/works instead of living today.
  // Caps: persona share and site share over the window, one telling of an episode per window.
  const sbcfg = selfBioConfig(spec);
  const sbWindow = Number.isFinite(dayStart) ? [...context.filter((p) => { const t = Date.parse(p.createdAt); return t < dayStart && t >= dayStart - Math.max(sbcfg.share_window_days, sbcfg.episode_window_days) * 864e5; }), ...day] : day;
  const selfBio = scanSelfBio(sbWindow, { personas, cfg: sbcfg, isTarget: isToday });
  const sbToday = selfBio.hits.filter((h) => h.target);
  const sbBlocking = gate.self_bio_blocking === true;
  add({ id: 'persona.self_bio', status: selfBio.offenders.length ? (sbBlocking ? 'fail' : 'warn') : 'pass', value: authored.length ? sbToday.length / authored.length : 0, n: authored.length, min: null, max: sbcfg.site_max_share, blocking: sbBlocking, detail: selfBio.offenders.map((o) => `${o.personaId}: ${o.postId} ${o.reason} "${String(o.episode).slice(0, 40)}"`) });

  // 4) Offenders the pipeline can regenerate (text items with a taskId; timing/role-mix are planner-level).
  const offenders = new Map();
  const flag = (p, reason, length) => {
    if (!p || offenders.has(p.id) || p.retaikOf) return;
    offenders.set(p.id, { postId: p.id, taskId: p.taskId ?? null, personaId: p.authorId, reason, chars: lenOf(p), ...(length ? { length } : {}) });
  };
  const longestFirst = [...authored].filter((p) => role(p) !== 'thread_part').sort((a, b) => lenOf(b) - lenOf(a));
  const failed = (id) => checks.find((c) => c.id === id)?.status === 'fail';
  if (failed('hard.over_140_share')) {
    const need = Math.ceil((over140 - (gate.max_over_140_share ?? 0.2) * 0.8) * lens.length);
    longestFirst.filter((p) => lenOf(p) > 140).slice(0, need).forEach((p) => flag(p, 'over_140', { min: 20, max: 120 }));
  }
  const median = checks.find((c) => c.id === 'length.median_chars');
  const short = checks.find((c) => c.id === 'length.short_share');
  if (median?.status === 'fail' && median.value > median.max || short?.status === 'fail' && short.value < short.min) {
    // Shorten the longest items until the day's median/short share would land inside the band.
    const sim = authored.map((p) => ({ p, l: lenOf(p) })).filter((x) => x.l > 0);
    const cut = [...sim].sort((a, b) => b.l - a.l);
    const ok = () => {
      const ls = sim.map((x) => x.l).sort((a, b) => a - b);
      const med = ls[ls.length >> 1];
      const sh = ls.filter((l) => l <= 40).length / ls.length;
      return (!median || med <= median.max) && (!short || sh >= short.min);
    };
    for (const x of cut) {
      if (ok() || offenders.size > authored.length * 0.3) break;
      x.l = 30;
      flag(x.p, 'too_long_for_day', { min: 5, max: 40 });
    }
  }
  for (const r of personaFails) {
    const tooLong = r.tooLong;
    const need = Math.max(1, Math.ceil(Math.max(Math.abs(r.shortShare - r.expectedShort) - r.tolerance, r.longShare - r.expectedLong - r.toleranceLong) * r.n) + 1);
    const list = [...r.items].sort((a, b) => (tooLong ? lenOf(b) - lenOf(a) : lenOf(a) - lenOf(b)));
    list.slice(0, need).forEach((p) => flag(p, tooLong ? `persona_too_long:${r.personaId}` : `persona_too_short:${r.personaId}`, tooLong ? { min: 5, max: shortChars } : { min: 60, max: 140 }));
  }

  if (failed('persona.self_bio')) for (const o of selfBio.offenders) flag(all.get(o.postId), `self_bio:${String(o.episode).slice(0, 40)}`);
  if (failed('persona.novelty')) for (const r of repeats) flag(all.get(r.postId), r.reason === 'catchphrase' ? `catchphrase:${r.label}` : `repetitive:${r.otherId}`);

  const failures = checks.filter((c) => c.status === 'fail');
  const ok = failures.length === 0;
  const scorecard = renderScorecard({ label, ok, checks, personaRows, offenders: [...offenders.values()], counts: { posts: day.length, authored: authored.length, originals: originals.length, polls, mediaItems } });
  return { ok, checks, failures, personas: personaRows.map(({ items: _i, ...r }) => r), offenders: [...offenders.values()], scorecard };
}

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));
const ICON = { pass: '✅', warn: '⚠️', fail: '❌', skip: '·' };

function renderScorecard({ label, ok, checks, personaRows, offenders, counts }) {
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const lines = [
    `## Day gate: ${label} ${ok ? '✅ PASS' : '❌ FAIL'}`,
    '',
    `${counts.posts} rows · ${counts.authored} authored · ${counts.originals} originals · ${counts.mediaItems} media items · ${counts.polls} polls · ${fails.length} blocking failures · ${warns.length} warnings`,
    '',
    '| | check | value | band | n | blocks |',
    '|---|---|---|---|---|---|',
    ...checks
      .filter((c) => c.blocking || c.status === 'warn' || c.id === 'persona.max_similarity')
      .map((c) => `| ${ICON[c.status]} | ${c.id} | ${fmt(round(c.value))} | ${fmt(round(c.min))}–${fmt(round(c.max))} | ${c.n} | ${c.blocking ? 'yes' : ''} |`),
  ];
  for (const c of fails) if (c.detail?.length) lines.push('', `**${c.id}**: ${c.detail.slice(0, 12).join('; ')}`);
  if (personaRows.length) {
    lines.push('', `<details><summary>Personas with enough items (${personaRows.length})</summary>`, '', '| | persona | style | n | ≤40 chars | expected | >140 | expected | median |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of personaRows) lines.push(`| ${ICON[r.status]} | ${r.personaId} | ${r.style} | ${r.n} | ${pct(r.shortShare)} | ${pct(r.expectedShort)} ±${pct(r.tolerance)} | ${pct(r.longShare)} | ≤${pct(r.expectedLong + r.toleranceLong)} | ${r.median} |`);
    lines.push('', '</details>');
  }
  if (offenders.length) lines.push('', `Regenerable offenders: ${offenders.length} (${offenders.slice(0, 8).map((o) => `${o.postId} ${o.reason}`).join(', ')}${offenders.length > 8 ? ', …' : ''})`);
  return lines.join('\n');
}
