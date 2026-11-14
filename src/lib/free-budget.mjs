import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { neuronsFor } from './budget.mjs';
import { writeJsonAtomic } from './pipeline-util.mjs';

export const freeProvider = (p, env) => p.model.endsWith(':free') ||
  env[`${p.keyEnv.replace(/_(API_KEY|AI_TOKEN)$/, '')}_FREE_ONLY`] === 'true';

// A UTF-8 byte is a conservative token bound, including Hebrew and tool schemas.
export function requestBound(p, body) {
  const input = Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools })) + 256;
  const output = body.max_tokens ?? p.max_tokens ?? 700;
  if (!Number.isInteger(output) || output <= 0) throw new Error('invalid output token bound');
  return { calls: 1, tokens: input + output, neurons: neuronsFor(p, input, output) };
}

export function readLedger(file, day) {
  if (!fs.existsSync(file)) return { day, events: {} };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc.events || typeof doc.events !== 'object') throw new Error('invalid shared free-budget ledger');
  for (const e of Object.values(doc.events)) {
    if (typeof e.name !== 'string' || !Number.isInteger(e.calls) || e.calls < 0 ||
      !['tokens', 'neurons'].every((k) => Number.isFinite(e[k] ?? 0) && (e[k] ?? 0) >= 0)) throw new Error('invalid shared quota charge');
  }
  return doc.day === day ? doc : { day, events: {} };
}

export function ledgerUsage(doc) {
  const models = {};
  for (const e of Object.values(doc.events)) {
    const u = models[e.name] ??= { calls: 0, tokens: 0, neurons: 0 };
    if (e.keyEnv) u.keyEnv = e.keyEnv;
    for (const k of ['calls', 'tokens', 'neurons']) u[k] += e[k] ?? 0;
  }
  return models;
}

export function mergeLedgers(docs, day) {
  const events = {};
  for (const doc of docs) if (doc.day === day) {
    for (const [id, event] of Object.entries(doc.events)) {
      if (events[id] && JSON.stringify(events[id]) !== JSON.stringify(event)) throw new Error(`conflicting budget event ${id}`);
      events[id] = event;
    }
  }
  return { day, events };
}

export function createFreeBudget({ config, used = {}, file = null, day, shares = 1, maxCalls = Infinity, now = () => new Date().toISOString().slice(0, 10) }) {
  let sessionCalls = 0;
  const doc = file ? readLedger(file, day) : { day, events: {} };
  const recorded = ledgerUsage(doc);
  for (const [name, base] of Object.entries(used)) {
    const delta = Object.fromEntries(['calls', 'tokens', 'neurons'].map((k) =>
      [k, Math.max(0, (base[k] ?? 0) - (recorded[name]?.[k] ?? 0))]));
    if (Object.values(delta).some((n) => n > 0)) doc.events[randomUUID()] = {
      name, keyEnv: base.keyEnv ?? config.providers.find((p) => p.name === name)?.keyEnv, ...delta };
  }
  const usage = () => ledgerUsage(doc);
  const persist = () => { if (file) writeJsonAtomic(file, doc); };
  const initial = usage();
  const limits = {};
  for (const key of new Set(config.providers.map((p) => p.keyEnv))) {
    const group = config.providers.filter((p) => p.keyEnv === key);
    const sum = (k) => Object.entries(initial).filter(([name, u]) => u.keyEnv === key || group.some((p) => p.name === name))
      .reduce((s, [, u]) => s + (u[k] ?? 0), 0);
    const quota = config.freePools?.[key] ?? {};
    limits[key] = Object.fromEntries(['calls', 'tokens', 'neurons'].map((k) => {
      const cap = k === 'neurons' && key === 'CF_AI_TOKEN' ? config.totalCap.cap : quota[k] ?? Infinity;
      return [k, sum(k) + Math.max(0, cap - sum(k)) / shares];
    }));
  }
  return {
    take(p, body) {
      if (sessionCalls >= maxCalls || now() !== day) return null;
      const charge = requestBound(p, body);
      const current = usage();
      const own = current[p.name] ?? {};
      const group = config.providers.filter((x) => x.keyEnv === p.keyEnv);
      const sum = (k) => Object.entries(current).filter(([name, u]) => u.keyEnv === p.keyEnv || group.some((x) => x.name === name))
        .reduce((s, [, u]) => s + (u[k] ?? 0), 0);
      if ((own.calls ?? 0) + 1 > Math.min(p.calls ?? Infinity, p.capUnit === 'requests' ? p.cap : Infinity) ||
          sum('calls') + 1 > limits[p.keyEnv].calls ||
          sum('tokens') + charge.tokens > limits[p.keyEnv].tokens ||
          (p.capUnit === 'neurons' && sum('neurons') + charge.neurons > limits[p.keyEnv].neurons)) return null;
      const id = randomUUID();
      doc.events[id] = { name: p.name, keyEnv: p.keyEnv, ...charge };
      persist(); // Charge before sending: crashes, retries and empty responses cannot reset usage.
      sessionCalls++;
      return {
        settle(usage) {
          if (!Number.isFinite(usage?.prompt_tokens) || !Number.isFinite(usage?.completion_tokens)) return;
          const input = usage.prompt_tokens, output = usage.completion_tokens;
          if (input < 0 || output < 0) throw new Error('invalid provider token usage');
          doc.events[id] = { name: p.name, keyEnv: p.keyEnv, calls: 1, tokens: input + output, neurons: neuronsFor(p, input, output) };
          persist();
        },
      };
    },
    usage,
  };
}
