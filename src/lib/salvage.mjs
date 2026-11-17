import { validate } from './data.mjs';
import { completeThreads } from './complete-threads.mjs';
import { gateDay } from './daygate.mjs';
import { checkPost, policyContext } from './policy.mjs';

const refs = (p) => [p.inReplyTo, p.quoteOf, p.retaikOf].filter(Boolean);
const failureSize = (gate) => gate.failures.reduce((sum, c) => sum +
  (Number.isFinite(c.value) ? Math.max(0, c.min == null ? 0 : c.min - c.value,
    c.max == null ? 0 : c.value - c.max) / Math.max(0.01, Math.abs(c.min ?? c.max ?? 1)) : 1), 0);

/** Remove content, never rewrite it or relax a gate. No network or inference is used. */
export function salvageDay({ posts, context = [], personas, spec, threadPolicy = null, knownUrls, allowNames = [] }) {
  const baseline = validate(personas, context, { knownUrls });
  if (baseline.length) throw new Error(`cannot salvage over an invalid existing corpus: ${baseline[0]}`);
  const reasons = new Map();
  const add = (id, reason) => reasons.set(id, [...(reasons.get(id) ?? []), reason]);
  const existing = new Set(context.map((p) => p.id));
  const byId = new Map([...context, ...posts].map((p) => [p.id, p]));
  const policy = policyContext(personas, { allowNames });
  const errors = validate(personas, [...context, ...posts], { knownUrls });
  for (const error of errors) {
    const affected = posts.filter((p) => error.startsWith(`post ${p.id} (`) ||
      error === `duplicate post id ${p.id}` || error.startsWith('media ') && error.split(': ').at(-1).split(', ').includes(p.id));
    if (!affected.length) throw new Error(`cannot attribute validation error safely: ${error}`);
    for (const p of affected) add(p.id, error);
  }
  for (const p of posts) {
    if (existing.has(p.id)) add(p.id, 'already published');
    const checked = checkPost(p, policy, { topic: p.topic ?? p.news,
      parentText: refs(p).map((id) => byId.get(id)?.text ?? '').join(' ') });
    for (const v of checked.violations) add(p.id, `policy: ${v.rule} (${v.where})`);
  }
  const close = (items) => {
    let keep = items;
    for (;;) {
      const ids = new Set([...existing, ...keep.map((p) => p.id)]);
      const next = keep.filter((p) => refs(p).every((id) => ids.has(id)));
      if (next.length === keep.length) break;
      keep = next;
    }
    return threadPolicy ? completeThreads(keep, threadPolicy.min, threadPolicy.max).posts : keep;
  };
  let kept = close(posts.filter((p) => !reasons.has(p.id)));
  const evaluate = (items) => gateDay({ posts: items, context, personas, spec, threadPolicy });
  let gate = evaluate(kept);
  const initialFailures = gate.failures.map((c) => c.id);
  let evaluations = 1;
  while (kept.length && !gate.ok && evaluations < 500) {
    const flagged = new Set(gate.offenders.map((o) => o.postId));
    const candidates = flagged.size ? kept.filter((p) => flagged.has(p.id)) : kept;
    let best = null;
    for (const p of candidates) {
      const subset = close(kept.filter((q) => q.id !== p.id));
      if (!subset.length || ++evaluations > 500) continue;
      const score = evaluate(subset);
      if (score.failures.length > gate.failures.length ||
        score.failures.length === gate.failures.length && failureSize(score) >= failureSize(gate)) continue;
      if (!best || score.failures.length < best.gate.failures.length ||
        score.failures.length === best.gate.failures.length && (score.ok ? subset.length > best.posts.length :
          failureSize(score) < failureSize(best.gate))) best = { posts: subset, gate: score, removed: p.id };
    }
    if (!best) break;
    add(best.removed, `excluded to satisfy ${gate.failures.map((c) => c.id).join(', ')}`);
    kept = best.posts;
    gate = best.gate;
  }
  const ids = new Set(kept.map((p) => p.id));
  const finalErrors = validate(personas, [...context, ...kept], { knownUrls });
  const ok = kept.length > 0 && gate.ok && finalErrors.length === 0;
  const omitted = posts.filter((p) => !ok || !ids.has(p.id)).map((p) => ({ id: p.id,
    reasons: reasons.get(p.id) ?? [ids.has(p.id) ? 'no subset passed all blocking checks' :
      'dependent on an excluded item or outside a complete conversation'] }));
  return { ok, posts: ok ? kept : [], gate, report: { status: ok ? 'partial' : 'unpublishable',
    input: posts.length, retained: ok ? kept.length : 0, omitted, initialFailures,
    remainingFailures: gate.failures.map((c) => c.id), validationErrors: finalErrors, evaluations } };
}
