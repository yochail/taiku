// OpenAI-compatible chat client (Cloudflare Workers AI /ai/v1/chat/completions) with ONE retry
// layer, an rpm limiter and a shared request budget. GitHub Models is retired (it answers every
// request with HTTP 200 "OK"), so it is not a provider any more; any non-JSON / empty body or a
// message without content or tool calls is treated as a failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LLM_CONFIG_FILE = path.join(ROOT, 'config', 'llm.json');
export const CF_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1';
export const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class BudgetError extends Error {
  constructor(msg = 'LLM request budget exhausted') {
    super(msg);
    this.code = 'BUDGET';
  }
}
export class LlmError extends Error {
  constructor(msg, { status, retryable = false, capped = false } = {}) {
    super(msg);
    this.status = status;
    this.retryable = retryable;
    this.capped = capped; // quota exhausted / model gone: mark the model capped and switch
  }
}

const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || Number.isNaN(Number(v)) ? d : Number(v));

/** Expand ${VAR} from env. Missing vars stay empty (→ invalid URL → no key is ever sent). */
export const expandEnv = (s, env = process.env) => String(s ?? '').replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? '');

export function loadLlmConfig(file = LLM_CONFIG_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, https: u.protocol === 'https:', ok: !/\/accounts\/\/|\/accounts\/$/.test(u.pathname) };
  } catch {
    return { host: '', https: false, ok: false };
  }
}

/**
 * Single-provider config from env (tests, one-off runs): LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,
 * defaulting to Cloudflare Workers AI with CF_ACCOUNT_ID + CF_AI_TOKEN. The CF token is only ever
 * sent to https://api.cloudflare.com.
 */
export function llmConfig(env = process.env, provider = null) {
  const baseUrl = expandEnv(provider?.baseURL ?? env.LLM_BASE_URL ?? CF_BASE_URL, env).replace(/\/+$/, '');
  const { host, https, ok } = hostOf(baseUrl);
  const keyEnv = provider?.keyEnv ?? (env.LLM_API_KEY ? 'LLM_API_KEY' : 'CF_AI_TOKEN');
  const cfHost = https && host === 'api.cloudflare.com';
  const apiKey = ok && (keyEnv !== 'CF_AI_TOKEN' || cfHost) ? env[keyEnv] || '' : '';
  return {
    name: provider?.name ?? 'env',
    baseUrl,
    host,
    apiKey,
    keySource: apiKey ? keyEnv : null,
    model: provider?.model ?? env.LLM_MODEL ?? DEFAULT_MODEL,
    role: provider?.role ?? 'voice',
    temperature: num(provider?.temperature ?? env.LLM_TEMPERATURE, 0.95),
    maxTokens: num(provider?.max_tokens ?? env.LLM_MAX_TOKENS, 700),
    tools: String(env.LLM_TOOLS || provider?.tools || 'auto').toLowerCase(), // auto | on | off
    extra: provider?.extra ?? {},
    userPrefix: provider?.userPrefix ?? '',
    rpm: num(provider?.rpm ?? env.LLM_RPM, 12),
    maxRetryAfterMs: num(env.LLM_MAX_RETRY_AFTER_MS, 120000),
  };
}

/** Retry-After → ms. Accepts delta-seconds or an HTTP-date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export const backoffMs = (attempt, rand = Math.random, base = 800, cap = 20000) => Math.min(cap, base * 2 ** attempt) * (0.5 + rand());

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Requests-per-minute limiter (minimum spacing between request starts). */
export function createLimiter(rpm, { sleep = realSleep, now = Date.now } = {}) {
  const gap = rpm > 0 ? 60000 / rpm : 0;
  let next = 0;
  return async () => {
    const t = now();
    const wait = Math.max(0, next - t);
    next = Math.max(t, next) + gap;
    if (wait > 0) await sleep(wait);
  };
}

const QUOTA_RE = /neuron|quota|daily (free )?allocation|limit exceeded|4006|exceeded your/i;

/** Pull the assistant message out of an OpenAI-style or Cloudflare-wrapped body. */
export function extractMessage(json) {
  const body = json?.result && !json.choices ? json.result : json;
  const msg = body?.choices?.[0]?.message;
  if (msg) return { message: msg, usage: body.usage ?? json.usage ?? null, model: body.model ?? null };
  if (typeof body?.response === 'string') return { message: { role: 'assistant', content: body.response, ...(body.tool_calls ? { tool_calls: body.tool_calls } : {}) }, usage: body.usage ?? null, model: null };
  return null;
}

const hasOutput = (m) => (typeof m.content === 'string' && m.content.trim() !== '') || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0);

/**
 * Budgeted client for ONE model. Every HTTP attempt (including retries and probes) consumes one
 * unit of the shared budget. Retries: 408/5xx/network/non-JSON/empty bodies with exponential
 * backoff + jitter, honouring Retry-After. 429 / quota errors / 404 / 410 throw `capped` errors
 * (after one Retry-After-bounded back-off for 429) so the rotation switches models.
 */
export function createClient({ cfg = llmConfig(), fetchImpl = globalThis.fetch, maxCalls = 120, maxAttempts = 4, sleep = realSleep, rand = Math.random, log = () => {}, limiter = null, budget = null } = {}) {
  let calls = 0;
  const stats = { calls: 0, retries: 0, errors: 0, rateLimited: 0, usage: { input: 0, output: 0 } };
  const limit = limiter ?? (cfg.rpm > 0 ? createLimiter(cfg.rpm, { sleep }) : null);
  async function post(body) {
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (calls >= maxCalls || (budget && !budget.take())) throw new BudgetError();
      calls++;
      stats.calls = calls;
      if (limit) await limit();
      let res;
      let wait = null;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify(body),
        });
      } catch (e) {
        lastErr = new LlmError(`network: ${e.message}`, { retryable: true });
      }
      if (res) {
        const text = await res.text();
        if (res.ok) {
          let json = null;
          try {
            json = text && text.trim() ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          if (!json || typeof json !== 'object') lastErr = new LlmError(`non-JSON response body (${String(text).slice(0, 40).replace(/\s+/g, ' ') || 'empty'})`, { status: res.status, retryable: true });
          else {
            const got = extractMessage(json);
            if (got && hasOutput(got.message)) {
              const u = got.usage ?? {};
              stats.usage.input += Number(u.prompt_tokens) || 0;
              stats.usage.output += Number(u.completion_tokens) || 0;
              return { message: got.message, usage: got.usage, model: got.model ?? body.model };
            }
            lastErr = new LlmError(got ? 'empty content' : 'response without choices', { status: res.status, retryable: true });
          }
        } else {
          const st = res.status;
          wait = parseRetryAfter(res.headers?.get?.('retry-after'));
          if (st === 429) stats.rateLimited++;
          const quota = (st === 429 || st === 403 || st === 400) && QUOTA_RE.test(text);
          if (st === 410 || st === 404 || quota) throw new LlmError(`HTTP ${st}: ${text.slice(0, 160)}`, { status: st, capped: true });
          if (st === 429) {
            // Back off once (bounded), then let the rotation switch models.
            if (attempt === 0 && (wait ?? 0) <= Math.min(cfg.maxRetryAfterMs, 30000)) {
              stats.retries++;
              await sleep(wait ?? backoffMs(0, rand));
              lastErr = new LlmError(`HTTP 429: ${text.slice(0, 120)}`, { status: st, retryable: true });
              continue;
            }
            throw new LlmError(`HTTP 429: ${text.slice(0, 160)}`, { status: st, capped: true });
          }
          lastErr = new LlmError(`HTTP ${st}: ${text.slice(0, 200)}`, { status: st, retryable: st === 408 || st >= 500 });
        }
      }
      stats.errors++;
      if (!lastErr.retryable || attempt === maxAttempts - 1) throw lastErr;
      if (wait != null && wait > cfg.maxRetryAfterMs) throw new LlmError(`Retry-After ${Math.round(wait / 1000)}s exceeds limit`, { status: lastErr.status, capped: true });
      const ms = wait ?? backoffMs(attempt, rand);
      stats.retries++;
      log(`llm retry ${attempt + 1} in ${Math.round(ms)}ms (${lastErr.message.slice(0, 80)})`);
      await sleep(ms);
    }
    throw lastErr;
  }
  const prefixUser = (messages) =>
    !cfg.userPrefix ? messages : messages.map((m) => (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith(cfg.userPrefix) ? { ...m, content: `${cfg.userPrefix} ${m.content}` } : m));
  return {
    cfg,
    stats,
    get calls() {
      return calls;
    },
    get remaining() {
      return Math.max(0, maxCalls - calls);
    },
    chat: (body) => post({ model: cfg.model, temperature: cfg.temperature, max_tokens: cfg.maxTokens, ...(cfg.extra ?? {}), ...body, messages: prefixUser(body.messages ?? []) }),
  };
}

const capsCache = new Map();
export const toolCapsKey = (client) => `${client.cfg.baseUrl}|${client.cfg.model}`;
/**
 * Does this model do native function calling? `tools=on|off` skips the probe; otherwise one tiny
 * request is spent and cached per base URL + model (persisted via `known`, recorded in the manifest).
 */
export async function probeTools(client, known = null) {
  const key = toolCapsKey(client);
  if (known && typeof known[key] === 'boolean') return known[key];
  if (capsCache.has(key)) return capsCache.get(key);
  let ok;
  if (client.cfg.tools === 'off') ok = false;
  else if (client.cfg.tools === 'on' || client.isMock) ok = true;
  else {
    try {
      const r = await client.chat({
        messages: [{ role: 'user', content: 'Call the ping tool with x="1". Do not answer in text.' }],
        tools: [{ type: 'function', function: { name: 'ping', description: 'connectivity probe', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } }],
        tool_choice: 'auto',
        temperature: 0,
      });
      ok = Array.isArray(r.message.tool_calls) && r.message.tool_calls.length > 0;
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      ok = e.status === 400 ? false : null;
    }
  }
  if (ok === null) return false; // transient failure: use emulation for now, don't cache
  capsCache.set(key, ok);
  return ok;
}

const tryParse = (x) => {
  try {
    return JSON.parse(x);
  } catch {
    return null;
  }
};
const stripThink = (s) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');

/** Lenient JSON extraction from a model message (fenced blocks, leading prose, <think> blocks). */
export function parseJsonLoose(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const s = stripThink(String(text)).trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const direct = tryParse(fenced ? fenced[1].trim() : s);
  if (direct !== null) return direct;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(s.slice(start, end + 1)) : null;
}

/** Every complete top-level {...} object in a string (recovers truncated / partial arrays). */
export function scanObjects(s) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const o = tryParse(s.slice(start, i + 1));
        if (o && typeof o === 'object') out.push(o);
        start = -1;
      }
    }
  }
  return out;
}

/**
 * JSON array from a model message: fenced or bare arrays, {"items":[…]} wrappers, prose around it,
 * and truncated arrays (the complete objects are kept). Returns [] when nothing parses.
 */
export function parseJsonArray(text) {
  if (text == null) return [];
  if (Array.isArray(text)) return text;
  if (typeof text === 'object') return Array.isArray(text.items) ? text.items : Array.isArray(text.posts) ? text.posts : [text];
  const s = stripThink(String(text)).trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  const body = fenced ? fenced[1].trim() : s;
  const direct = tryParse(body);
  if (Array.isArray(direct)) return direct.filter((x) => x && typeof x === 'object');
  if (direct && typeof direct === 'object') {
    for (const k of ['items', 'posts', 'replies', 'results', 'taiks']) if (Array.isArray(direct[k])) return direct[k].filter((x) => x && typeof x === 'object');
    return [direct];
  }
  const a = body.indexOf('[');
  const b = body.lastIndexOf(']');
  if (a >= 0 && b > a) {
    const arr = tryParse(body.slice(a, b + 1));
    if (Array.isArray(arr)) return arr.filter((x) => x && typeof x === 'object');
  }
  const objs = scanObjects(a >= 0 ? body.slice(a) : body);
  if (objs.length === 1) for (const k of ['items', 'posts', 'replies']) if (Array.isArray(objs[0][k])) return objs[0][k];
  return objs;
}
