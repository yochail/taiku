// Provider rotation over config/llm.json. Each role (voice / batch / micro / fallback) walks its
// priority chain (config.chains: Gemini → OpenRouter Nemotron → Groq → Cloudflare Workers AI) and
// spills over to the next model with quota left. Providers without their key are skipped. 429 /
// quota errors / 410 mark a model capped and switch. Per-model stats ({model, calls, cap,
// neurons_est, 429s, items}) go into the run manifest.
import { BudgetError, LlmError, createClient, expandEnv, llmConfig, probeTools, toolCapsKey } from './llm.mjs';
import { neuronsFor } from './budget.mjs';
import { sha256 } from './pipeline-util.mjs';
import { createFreeBudget } from './free-budget.mjs';

/**
 * Models search: returns { available: Set<name>|null, skipped: [{name, model, reason}] }. A failed
 * request leaves `available` null (nothing is skipped) and is logged.
 */
export async function discoverModels({ config, env = process.env, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now() }) {
  const url = expandEnv(config.discovery ?? '', env);
  const key = env.CF_AI_TOKEN;
  if (!url || !env.CF_ACCOUNT_ID || !key) return { available: null, skipped: [], error: 'no credentials' };
  let list;
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
    const text = await res.text();
    const json = JSON.parse(text);
    if (!res.ok || !Array.isArray(json.result)) throw new Error(`HTTP ${res.status}`);
    list = json.result;
  } catch (e) {
    log(`model discovery failed (${String(e.message).slice(0, 80)}); using config/llm.json as is`);
    return { available: null, skipped: [], error: String(e.message).slice(0, 120) };
  }
  const byName = new Map(list.map((m) => [m.name, m]));
  const available = new Set();
  const skipped = [];
  for (const p of config.providers) {
    if (!/api\.cloudflare\.com/.test(p.baseURL ?? '')) {
      available.add(p.name); // only Workers AI has a model catalogue to check
      continue;
    }
    const m = byName.get(p.model);
    if (!m) {
      skipped.push({ name: p.name, model: p.model, reason: 'missing' });
      continue;
    }
    const props = Object.fromEntries((m.properties ?? []).map((x) => [x.property_id, x.value]));
    const dep = props.planned_deprecation_date ?? props.deprecation_date ?? null;
    const deprecated = (dep && Date.parse(dep) <= now) || /\bdeprecated\b/i.test(m.description ?? '') || props.deprecated === 'true' || props.deprecated === true;
    if (deprecated) skipped.push({ name: p.name, model: p.model, reason: `deprecated${dep ? ` ${dep}` : ''}` });
    else available.add(p.name);
  }
  return { available, skipped };
}

/** Deterministic weighted pick by hash (same persona → same model every day). */
export function hashPick(key, entries) {
  const list = entries.filter(([, w]) => w > 0);
  if (!list.length) return null;
  const total = list.reduce((s, [, w]) => s + w, 0);
  let x = (parseInt(sha256(String(key)).slice(0, 8), 16) / 0x100000000) * total;
  for (const [k, w] of list) {
    x -= w;
    if (x < 0) return k;
  }
  return list.at(-1)[0];
}

const estTokens = (s) => Math.ceil(String(s ?? '').length / 4);

/**
 * @param o.config     config/llm.json
 * @param o.plan       planBudget(...) result (per-model plan/reserve); models with no allowance are skipped
 * @param o.makeClient (provider, cfg) => client  (mock clients in offline runs)
 */
export function createRotation({ config, plan, env = process.env, makeClient = null, fetchImpl, sleep, log = () => {}, caps = {}, freeBudget = null }) {
  const safety = freeBudget ?? createFreeBudget({ config, used: Object.fromEntries((plan?.models ?? []).map((m) => [m.name, m.usedToday ?? {}])), day: new Date().toISOString().slice(0, 10), maxCalls: plan?.totals?.calls });
  const planBy = new Map((plan?.models ?? []).map((m) => [m.name, m]));
  const planShare = config.planShare ?? 0.8;
  const models = [];
  for (const p of config.providers) {
    const pm = planBy.get(p.name) ?? { plan: p.calls ?? 10, reserve: 1, allowance: p.calls ?? 10 };
    const cfg = llmConfig(env, p);
    const allowance = pm.capacity ?? pm.allowance ?? pm.plan + pm.reserve;
    const reserve = pm.capacity == null ? pm.reserve : Math.ceil(allowance * (config.reserveShare ?? 0.05));
    const client = makeClient ? makeClient(p, cfg, allowance) : createClient({ cfg, fetchImpl, maxCalls: Math.max(1, allowance), reserve: (body) => safety.take(p, body), log, ...(sleep ? { sleep } : {}) });
    models.push({
      p,
      client,
      name: p.name,
      model: p.model,
      role: p.role,
      plan: pm.capacity == null ? pm.plan : allowance - reserve,
      reserve,
      neuronCap: p.capUnit === 'requests' ? Infinity : p.cap * planShare - (pm.usedToday?.neurons ?? 0),
      neurons: 0,
      r429: 0,
      items: 0,
      capped: allowance <= 0 ? 'no allowance' : !makeClient && !cfg.apiKey ? `no ${p.keyEnv}` : null,
      tools: null,
    });
  }
  const byName = new Map(models.map((m) => [m.name, m]));
  const spill = config.spill ?? {};
  const usedAll = () => models.reduce((s, m) => s + m.client.calls, 0);
  // Day-size cap across all models (budget roles); repairs may dip into the reserve.
  const dayPlan = plan?.totals?.plan ?? Infinity;
  const dayCap = plan?.totals?.calls ?? Infinity;
  const usable = (m, repair) => !m.capped && m.client.calls < (repair ? m.plan + m.reserve : m.plan) && m.neurons < m.neuronCap && usedAll() < (repair ? dayCap : dayPlan);

  function order(role, personaId) {
    const roles = spill[role] ?? [role, 'fallback'];
    const out = [];
    const chain = config.chains?.[role];
    if (chain) {
      // Explicit priority chain (config.chains): best model first, cheaper/backup ones after.
      for (const n of chain) if (byName.has(n) && !out.includes(byName.get(n))) out.push(byName.get(n));
    } else if (role === 'voice') {
      const voices = models.filter((m) => (m.p.voiceWeight ?? 0) > 0);
      const primary = hashPick(`voice:${personaId ?? ''}`, voices.map((m) => [m.name, m.p.voiceWeight]));
      if (primary) out.push(byName.get(primary));
      for (const m of [...voices].sort((a, b) => b.p.voiceWeight - a.p.voiceWeight)) if (!out.includes(m)) out.push(m);
    }
    for (const r of roles) for (const m of models) if (m.role === r && !out.includes(m)) out.push(m);
    return out;
  }

  function account(m, body, r) {
    const u = r?.usage;
    const input = Number(u?.prompt_tokens) || estTokens(JSON.stringify(body.messages ?? []));
    const output = Number(u?.completion_tokens) || estTokens(r?.message?.content ?? JSON.stringify(r?.message?.tool_calls ?? ''));
    m.neurons += neuronsFor(m.p, input, output);
  }

  /** A client-like facade pinned to one model for a turn/batch (switches only between whole requests without tool state). */
  function clientFor(role, personaId = null, { needTools = false } = {}) {
    let pinned = null;
    // needTools prefers native function calling; with none of those left, a model that runs the turn
    // with emulated tools (TOOL_EMULATION) beats leaving the task pending.
    const pickModel = (repair, exclude = new Set()) => {
      const ok = order(role, personaId).filter((m) => !exclude.has(m) && usable(m, repair));
      return (needTools && ok.find((m) => m.tools !== false)) || ok[0] || null;
    };
    let calls = 0;
    const facade = {
      role,
      get cfg() {
        return (pinned ?? pickModel(false) ?? pickModel(true))?.client.cfg ?? { model: 'none', baseUrl: '' };
      },
      get model() {
        return pinned?.model ?? null;
      },
      get modelName() {
        return pinned?.name ?? null;
      },
      get isMock() {
        return Boolean(models[0]?.client.isMock);
      },
      get calls() {
        return calls;
      },
      get remaining() {
        const perModel = models.reduce((s, m) => s + (usable(m, true) ? m.plan + m.reserve - m.client.calls : 0), 0);
        return Math.max(0, Math.min(perModel, dayCap - usedAll()));
      },
      get nativeTools() {
        const m = pinned ?? pickModel(false) ?? pickModel(true);
        return m ? m.tools !== false : false;
      },
      available: () => Boolean(pickModel(false)),
      async chat(body) {
        const { _repair: repair = false, ...rest } = body;
        const hasToolState = (rest.messages ?? []).some((x) => x.role === 'tool' || x.tool_calls);
        const tried = new Set();
        for (;;) {
          let m = pinned && usable(pinned, repair || calls > 0) ? pinned : null;
          if (!m) {
            if (pinned && hasToolState) throw new LlmError(`model ${pinned.name} exhausted mid-turn`, { capped: true });
            m = pickModel(repair, tried);
          }
          if (!m) throw new BudgetError(`no ${role} model with quota left`);
          pinned = m;
          calls++;
          try {
            // A turn built for native tools can land on a model without them after a switch: drop the schemas.
            const send = m.tools === false && rest.tools ? (({ tools, tool_choice, ...b }) => b)(rest) : rest;
            const r = await m.client.chat(send);
            account(m, rest, r);
            return { ...r, model: m.model };
          } catch (e) {
            if (e instanceof BudgetError) {
              m.capped = 'allowance used';
            } else if (e.capped || e.status === 429) {
              if (e.status === 429) m.r429++;
              m.capped = String(e.message).slice(0, 80);
              log(`model ${m.name} capped: ${m.capped}`);
            } else if (!hasToolState && (e.status === 413 || /^empty content$/.test(e.message))) {
              // This request is too big for, or keeps coming back empty from, this model: try the next
              // model for this request only, without capping the model for the rest of the run.
              tried.add(m);
              if (!pickModel(repair, tried)) throw e;
              log(`model ${m.name} failed this request (${String(e.message).slice(0, 40)}), trying the next model`);
              pinned = null;
              continue;
            } else throw e;
            tried.add(m);
            if (hasToolState) throw new LlmError(`model ${m.name} capped mid-turn`, { capped: true });
            pinned = null;
          }
        }
      },
      noteItems(n = 1) {
        if (pinned) pinned.items += n;
      },
    };
    return facade;
  }

  /** Probe native tool support for models with tools:auto (cached in `caps`, keyed by base URL + model). */
  async function probe() {
    for (const m of models) {
      if (m.capped) continue;
      const key = toolCapsKey(m.client);
      if (typeof caps[key] === 'boolean') m.tools = caps[key];
      else {
        try {
          m.tools = await probeTools(m.client, caps);
          caps[key] = m.tools;
          if (!m.client.isMock && m.client.calls > 0) account(m, { messages: [{ content: 'probe'.repeat(40) }] }, null);
        } catch (e) {
          if (!(e instanceof BudgetError)) throw e;
          m.tools = false;
        }
      }
    }
    return caps;
  }

  const report = () =>
    models.map((m) => ({
      name: m.name,
      model: m.model,
      role: m.role,
      calls: m.client.calls,
      plan: m.plan,
      reserve: m.reserve,
      cap: m.p.cap,
      capUnit: m.p.capUnit,
      neurons_est: Math.round(m.neurons),
      '429s': m.r429,
      items: m.items,
      tools: m.tools,
      ...(m.capped && m.capped !== 'no allowance' ? { capped: m.capped } : {}),
    }));

  return {
    models,
    clientFor,
    probe,
    report,
    get calls() {
      return models.reduce((s, m) => s + m.client.calls, 0);
    },
    get neurons() {
      return models.reduce((s, m) => s + m.neurons, 0);
    },
    usageByName: () => Object.fromEntries(models.map((m) => [m.name, { calls: m.client.calls, neurons: Math.round(m.neurons) }])),
    freeUsage: () => safety.usage(),
    hasCapacity: (role) => Boolean(order(role, null).find((m) => usable(m, false))),
    caps,
  };
}

/** Wrap a single pre-built client (tests, --client injection) as a one-model rotation. */
export function singleClientRotation(client) {
  const m = { name: client.cfg?.name ?? 'client', model: client.cfg?.model ?? 'unknown', calls0: 0, items: 0, r429: 0 };
  let tools = null;
  const facade = (role) => ({
    role,
    cfg: client.cfg,
    get model() {
      return client.cfg?.model;
    },
    get modelName() {
      return m.name;
    },
    isMock: client.isMock,
    get calls() {
      return client.calls;
    },
    get remaining() {
      return client.remaining;
    },
    get nativeTools() {
      return tools !== false;
    },
    available: () => client.remaining > 0,
    chat: (body) => {
      const { _repair, ...rest } = body;
      return client.chat(rest);
    },
    noteItems(n = 1) {
      m.items += n;
    },
  });
  return {
    models: [m],
    clientFor: (role) => facade(role),
    async probe(caps = {}) {
      try {
        tools = await probeTools(client, caps);
        caps[toolCapsKey(client)] = tools;
      } catch (e) {
        if (!(e instanceof BudgetError)) throw e;
      }
      return caps;
    },
    report: () => [{ name: m.name, model: m.model, role: 'all', calls: client.calls, plan: null, reserve: null, cap: null, capUnit: null, neurons_est: 0, '429s': client.stats?.rateLimited ?? 0, items: m.items, tools }],
    get calls() {
      return client.calls;
    },
    get neurons() {
      return 0;
    },
    usageByName: () => ({}),
    hasCapacity: () => client.remaining > 0,
    caps: {},
  };
}
