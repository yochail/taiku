// Embeddings for the generate step only (never imported by the site build).
//   minilm  — @huggingface/transformers + Xenova/all-MiniLM-L6-v2 (quantized ONNX, CPU), an
//             optionalDependency. Used live.
//   hash    — deterministic bag-of-words hashing (64 dims). Offline mock/dry runs and tests.
//   none    — fallback when the model can't load: callers use tag overlap and the run is degraded.
// Uses: react.mjs affinity (post vs persona interest vector), pool-entry ranking, stance hints.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, sha256, writeJsonAtomic } from './pipeline-util.mjs';

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
// Pinned Hugging Face commit (supply chain: a moved `main` can't swap the weights). generate.yml keys its cache on it.
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const HASH_DIMS = 64;
export const STANCE_ANCHORS = {
  agree: ['yes exactly, you are right', 'agreed, well said', 'this is correct'],
  disagree: ['no, that is wrong', 'I disagree completely', 'that argument fails'],
  mock: ['lol imagine believing this', 'this is ridiculous and embarrassing', 'clown take'],
  awe: ['wow, this is beautiful and profound', 'I am amazed', 'breathtaking'],
  confused: ['wait, what does that even mean?', 'I am confused', 'huh?'],
  hype: ["let's go! this is huge", 'so hyped, incredible news', 'massive W'],
};

const STOP = new Set('the a an and or of to in on for with is are was were be it this that at by as from but not no so if do does did i you he she we they me my your our their its'.split(' '));
export const tokens = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

const norm = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};

/** Deterministic hashed bag-of-words (+ 4-char prefixes for light stemming). */
export function hashEmbed(text, dims = HASH_DIMS) {
  const v = new Array(dims).fill(0);
  for (const w of tokens(text)) {
    for (const t of new Set([w, w.slice(0, 5)])) {
      const h = parseInt(sha256(t).slice(0, 8), 16);
      v[h % dims] += (h >> 8) & 1 ? 1 : -1;
    }
  }
  return norm(v);
}

export function cosineVec(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

const withTimeout = (p, ms, what) => {
  // Ref'd timer (an unref'd one lets the loop exit with the race pending); cleared once settled.
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(` timed out after ${ms}ms`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
};

/**
 * Create an embedder. mode: 'auto' (try MiniLM, fall back to none), 'minilm', 'hash', 'none'.
 * `loader` is injectable for tests: async () => (texts) => number[][].
 * Returns { kind, degraded, reason?, embed(texts) → Promise<number[][]|null> }.
 */
export async function createEmbedder({ mode = 'auto', loader = null, log = () => {}, cacheDir = null, timeoutMs = 60000 } = {}) {
  if (mode === 'hash') return { kind: 'hash', degraded: false, embed: async (texts) => texts.map((t) => hashEmbed(t)) };
  if (mode === 'none') return { kind: 'none', degraded: false, embed: async () => null };
  try {
    const fn = await withTimeout((loader ?? (() => loadMiniLM({ cacheDir })))(), timeoutMs, 'embedding model load');
    return {
      kind: 'minilm',
      degraded: false,
      embed: async (texts) => {
        const out = [];
        for (let i = 0; i < texts.length; i += 64) out.push(...(await fn(texts.slice(i, i + 64))));
        return out.map((v) => Array.from(v));
      },
    };
  } catch (e) {
    const reason = String(e?.message ?? e).slice(0, 160);
    log(`embeddings unavailable (${reason}); falling back to tag overlap (run marked degraded)`);
    return { kind: 'none', degraded: true, reason, embed: async () => null };
  }
}

async function loadMiniLM({ cacheDir }) {
  const pkg = '@huggingface/transformers';
  const tf = await import(pkg);
  if (cacheDir) tf.env.cacheDir = cacheDir;
  tf.env.allowLocalModels = true;
  const extractor = await tf.pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', device: 'cpu', revision: MODEL_REVISION });
  return async (texts) => {
    const t = await extractor(texts, { pooling: 'mean', normalize: true });
    return t.tolist();
  };
}

/** Interest text for a persona: topic affinities, key works and bio. */
export function personaInterestText(p) {
  const aff = Object.entries(p.topic_affinity ?? {})
    .filter(([, v]) => Number(v) >= 0.4)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k.replace(/_/g, ' '));
  const works = (p.key_works ?? []).slice(0, 6).map((w) => `${w.title ?? ''} ${w.note ?? ''}`);
  return [p.name, p.domain ?? '', p.school ?? '', aff.join(', '), ...(p.core_ideas ?? []).slice(0, 4), ...works, p.bio ?? ''].join('. ').slice(0, 1500);
}

export const personaHash = (p) => sha256(JSON.stringify([p.topic_affinity, p.key_works, p.bio, p.core_ideas, p.name, p.domain])).slice(0, 16);

const round4 = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);

/**
 * Persona interest vectors, cached in content/embeddings/personas.json (MiniLM only) and rebuilt for
 * any persona whose hash changed. Returns Map<id, vec> (empty for kind none).
 */
export async function personaVectors(personas, embedder, { file = null, write = true } = {}) {
  const out = new Map();
  if (embedder.kind === 'none') return out;
  const cache = embedder.kind === 'minilm' && file ? readJson(file) : null;
  const entries = cache?.model === MODEL_ID ? cache.personas ?? {} : {};
  const todo = [];
  for (const p of personas) {
    const h = personaHash(p);
    if (entries[p.id]?.hash === h && Array.isArray(entries[p.id].vec)) out.set(p.id, entries[p.id].vec);
    else todo.push([p, h]);
  }
  if (todo.length) {
    const vecs = await embedder.embed(todo.map(([p]) => personaInterestText(p)));
    todo.forEach(([p, h], i) => {
      const v = round4(vecs[i]);
      out.set(p.id, v);
      entries[p.id] = { hash: h, vec: v };
    });
    if (embedder.kind === 'minilm' && file && write) {
      for (const id of Object.keys(entries)) if (!personas.some((p) => p.id === id)) delete entries[id];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, { model: MODEL_ID, updatedAt: new Date().toISOString(), personas: entries });
    }
  }
  return out;
}

/** Anchor vectors per stance (mean of the anchor phrases). */
export async function stanceAnchors(embedder) {
  if (embedder.kind === 'none') return null;
  const keys = Object.keys(STANCE_ANCHORS);
  const flat = keys.flatMap((k) => STANCE_ANCHORS[k]);
  const vecs = await embedder.embed(flat);
  const out = {};
  let i = 0;
  for (const k of keys) {
    const group = vecs.slice(i, i + STANCE_ANCHORS[k].length);
    i += STANCE_ANCHORS[k].length;
    out[k] = norm(group[0].map((_, d) => group.reduce((s, v) => s + v[d], 0)));
  }
  return out;
}

/** Stance hint for a post vector: { stance: cosine } (centered), or null. */
export function stanceHint(vec, anchors) {
  if (!vec || !anchors) return null;
  const raw = Object.fromEntries(Object.entries(anchors).map(([k, a]) => [k, cosineVec(vec, a)]));
  const mean = Object.values(raw).reduce((s, v) => s + v, 0) / Object.keys(raw).length;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.round((v - mean) * 1000) / 1000]));
}

/** Map a cosine to an affinity in [0,1] (MiniLM cosines for related texts sit around 0.2–0.6). */
export const affinityFromCosine = (c, kind = 'minilm') => Math.max(0, Math.min(1, kind === 'hash' ? (c + 0.1) / 0.6 : (c - 0.05) / 0.45));

/** Tag-overlap similarity (fallback ranking): Jaccard-ish on tokens. */
export function tagOverlap(aTags, bTags) {
  const a = new Set((aTags ?? []).flatMap((t) => tokens(t)));
  const b = new Set((bTags ?? []).flatMap((t) => tokens(t)));
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.min(a.size, b.size);
}
