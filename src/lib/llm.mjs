// Minimal OpenAI-compatible chat client. Default provider: GitHub Models.
export function llmConfig(env = process.env) {
  const baseUrl = (env.LLM_BASE_URL || 'https://models.github.ai/inference').replace(/\/+$/, '');
  const apiKey = env.LLM_API_KEY || env.GITHUB_MODELS_TOKEN || env.GITHUB_TOKEN || '';
  const model = env.LLM_MODEL || 'openai/gpt-4.1-mini';
  const jsonMode = (env.LLM_JSON_MODE ?? 'true') !== 'false';
  const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const temperature = num(env.LLM_TEMPERATURE, 0.95);
  const delayMs = num(env.LLM_DELAY_MS, 4000);
  return { baseUrl, apiKey, model, jsonMode, temperature, delayMs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLlmProvider(cfg = llmConfig()) {
  let last = 0;
  return {
    name: `llm:${cfg.model}`,
    async complete(messages) {
      const wait = last + cfg.delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      for (let attempt = 1; attempt <= 4; attempt++) {
        last = Date.now();
        const body = { model: cfg.model, messages, temperature: cfg.temperature, max_tokens: 900 };
        if (cfg.jsonMode) body.response_format = { type: 'json_object' };
        let res;
        try {
          res = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          });
        } catch (err) {
          if (attempt === 4) throw err;
          await sleep(2000 * attempt);
          continue;
        }
        if (res.ok) {
          const data = await res.json();
          return data.choices?.[0]?.message?.content ?? '';
        }
        const text = await res.text();
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
          const retryAfter = Number(res.headers.get('retry-after')) || 0;
          if (retryAfter > 120) throw new Error(`LLM rate limited for ${retryAfter}s: ${text.slice(0, 200)}`);
          await sleep(Math.max(retryAfter * 1000, 5000 * attempt));
          continue;
        }
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
      }
      throw new Error('LLM: exhausted retries');
    },
  };
}

/** Extract the first JSON object from a model response. */
export function parseJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error(`Model did not return JSON: ${t.slice(0, 200)}`);
  }
}
