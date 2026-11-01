// OpenAI-compatible chat client with ONE retry layer and a shared request budget.
// Default provider: GitHub Models. Security A1: GITHUB_TOKEN is only ever sent to models.github.ai.
export const DEFAULT_BASE_URL = 'https://models.github.ai/inference';
export const DEFAULT_MODEL = 'openai/gpt-4.1-mini';
const GITHUB_MODELS_HOST = 'models.github.ai';

export class BudgetError extends Error {
  constructor(msg = 'LLM request budget exhausted') {
    super(msg);
    this.code = 'BUDGET';
  }
}
export class LlmError extends Error {
  constructor(msg, { status, retryable = false } = {}) {
    super(msg);
    this.status = status;
    this.retryable = retryable;
  }
}

const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || Number.isNaN(Number(v)) ? d : Number(v));

/** Resolve provider config from env. The key falls back to GITHUB_TOKEN ONLY for https://models.github.ai/. */
export function llmConfig(env = process.env) {
  const baseUrl = String(env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let host = '';
  let https = false;
  try {
    const u = new URL(baseUrl);
    host = u.hostname;
    https = u.protocol === 'https:';
  } catch {
    /* invalid → no key */
  }
  const isGithubModels = https && host === GITHUB_MODELS_HOST;
  const apiKey = env.LLM_API_KEY || (isGithubModels ? env.GITHUB_TOKEN || '' : '');
  const keySource = env.LLM_API_KEY ? 'LLM_API_KEY' : isGithubModels && env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : null;
  return {
    baseUrl,
    host,
    apiKey,
    keySource,
    model: env.LLM_MODEL || DEFAULT_MODEL,
    temperature: num(env.LLM_TEMPERATURE, 0.95),
    maxTokens: num(env.LLM_MAX_TOKENS, 700),
    tools: String(env.LLM_TOOLS || 'auto').toLowerCase(), // auto | on | off
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

/**
 * Budgeted client. Every HTTP attempt (including retries and probes) consumes one unit of the
 * shared budget (GEN_MAX_CALLS). Retries: 429/408/5xx/network/non-JSON bodies, with exponential
 * backoff + jitter, honouring Retry-After (numeric or HTTP-date).
 */
export function createClient({ cfg = llmConfig(), fetchImpl = globalThis.fetch, maxCalls = 120, maxAttempts = 4, sleep = realSleep, rand = Math.random, log = () => {} } = {}) {
  let calls = 0;
  const stats = { calls: 0, retries: 0, errors: 0, rateLimited: 0 };
  async function post(body) {
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (calls >= maxCalls) throw new BudgetError();
      calls++;
      stats.calls = calls;
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
          try {
            const json = JSON.parse(text);
            const msg = json?.choices?.[0]?.message;
            if (msg) return { message: msg, usage: json.usage ?? null, model: json.model ?? body.model };
            lastErr = new LlmError('response without choices', { status: res.status, retryable: true });
          } catch {
            lastErr = new LlmError(`non-JSON response body (${text.slice(0, 40).replace(/\s+/g, ' ')})`, { status: res.status, retryable: true });
          }
        } else {
          const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
          if (res.status === 429) stats.rateLimited++;
          lastErr = new LlmError(`HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status, retryable });
          wait = parseRetryAfter(res.headers?.get?.('retry-after'));
        }
      }
      stats.errors++;
      if (!lastErr.retryable || attempt === maxAttempts - 1) throw lastErr;
      if (wait != null && wait > cfg.maxRetryAfterMs) throw new LlmError(`Retry-After ${Math.round(wait / 1000)}s exceeds limit`, { status: lastErr.status });
      const ms = wait ?? backoffMs(attempt, rand);
      stats.retries++;
      log(`llm retry ${attempt + 1} in ${Math.round(ms)}ms (${lastErr.message.slice(0, 80)})`);
      await sleep(ms);
    }
    throw lastErr;
  }
  return {
    cfg,
    stats,
    get calls() {
      return calls;
    },
    get remaining() {
      return Math.max(0, maxCalls - calls);
    },
    chat: (body) => post({ model: cfg.model, temperature: cfg.temperature, max_tokens: cfg.maxTokens, ...body }),
  };
}

const capsCache = new Map();
/**
 * Does this model do native function calling? `LLM_TOOLS=on|off` skips the probe; otherwise one
 * tiny request is spent and cached per base URL + model (and recorded in the run manifest).
 */
export async function probeTools(client, known = null) {
  const key = `${client.cfg.baseUrl}|${client.cfg.model}`;
  if (known && typeof known[key] === 'boolean') return known[key];
  if (capsCache.has(key)) return capsCache.get(key);
  let ok;
  if (client.cfg.tools === 'on' || client.isMock) ok = true;
  else if (client.cfg.tools === 'off') ok = false;
  else {
    try {
      const r = await client.chat({
        messages: [{ role: 'user', content: 'Call the ping tool with x="1". Do not answer in text.' }],
        tools: [{ type: 'function', function: { name: 'ping', description: 'connectivity probe', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } }],
        tool_choice: 'auto',
        max_tokens: 30,
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
export const toolCapsKey = (client) => `${client.cfg.baseUrl}|${client.cfg.model}`;

/** Lenient JSON extraction from a model message (fenced blocks, leading prose). */
export function parseJsonLoose(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const s = String(text).trim();
  const tryParse = (x) => {
    try {
      return JSON.parse(x);
    } catch {
      return null;
    }
  };
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const direct = tryParse(fenced ? fenced[1] : s);
  if (direct !== null) return direct;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(s.slice(start, end + 1)) : null;
}
