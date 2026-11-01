// Hardened outbound fetch for untrusted URLs (link unfurls, real-post lookups).
// - https only, no credentials, default port only
// - DNS-resolved; private, loopback, link-local, CGNAT, multicast, reserved and cloud-metadata
//   addresses are refused, re-checked on every redirect hop
// - redirect: 'manual', at most 3 hops; response body stream-capped; content type enforced; timeout
// Residual risk: fetch() re-resolves the name after our check (DNS rebinding window). Generation
// runs in throwaway CI runners / a local session with no internal services to reach.
import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_HOPS = 3;
export const MAX_BYTES = 512 * 1024;
const UA = 'Mozilla/5.0 (compatible; TaikuBot/1.0; +https://taiku.app)';

export class BlockedUrlError extends Error {
  constructor(reason, url) {
    super(`blocked: ${reason}${url ? ` (${url})` : ''}`);
    this.name = 'BlockedUrlError';
    this.reason = reason;
  }
}

const v4num = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4num(base), bits]);

function v6words(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4num(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((w) => parseInt(w || '0', 16));
}

/** True for any address a server-side fetch must never reach. */
export function isBlockedIp(ip) {
  const kind = net.isIP(String(ip ?? ''));
  if (kind === 4) {
    const n = v4num(ip);
    return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  if (kind !== 6) return true;
  const w = v6words(ip);
  if (w.slice(0, 7).every((x) => x === 0) && w[7] <= 1) return true; // :: and ::1
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return isBlockedIp(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`); // v4-mapped / -compatible
  if (w[0] === 0x64 && w[1] === 0xff9b) return isBlockedIp(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`); // NAT64
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x2002) return isBlockedIp(`${w[1] >> 8}.${w[1] & 255}.${w[2] >> 8}.${w[2] & 255}`); // 6to4
  return false;
}

const defaultLookup = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Validate one URL (scheme, host allowlist, every resolved address). Throws BlockedUrlError. */
export async function checkUrl(raw, { lookup = defaultLookup, hosts = null } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError('bad url', raw);
  }
  if (u.protocol !== 'https:') throw new BlockedUrlError('not https', raw);
  if (u.username || u.password) throw new BlockedUrlError('credentials in url', raw);
  if (u.port && u.port !== '443') throw new BlockedUrlError('non-default port', raw);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hosts && !hosts.includes(host)) throw new BlockedUrlError('host not allowlisted', raw);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new BlockedUrlError('internal host', raw);
  const addrs = net.isIP(host) ? [host] : await lookup(host).catch(() => []);
  if (!addrs.length) throw new BlockedUrlError('unresolvable host', raw);
  const bad = addrs.find(isBlockedIp);
  if (bad) throw new BlockedUrlError(`private address ${bad}`, raw);
  return u.toString();
}

async function readCapped(res, maxBytes, stopAt) {
  const reader = res.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - size;
      chunks.push(value.length > room ? value.subarray(0, room) : value);
      size += Math.min(value.length, room);
      if (size >= maxBytes || (stopAt && stopAt.test(Buffer.from(value).toString('latin1')))) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * GET an untrusted URL safely. expect: 'html' (text/html or xhtml) | 'json'.
 * Returns { ok, status, url (final), contentType, text }; non-2xx and wrong types give ok:false, text ''.
 * Throws BlockedUrlError for policy violations, AbortError/TypeError for network failures.
 */
export async function safeFetch(raw, { fetchImpl = globalThis.fetch, lookup = defaultLookup, hosts = null, expect = 'html', timeoutMs = 8000, maxBytes = MAX_BYTES, maxHops = MAX_HOPS, stopAt = null, headers = {} } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const accept = expect === 'json' ? 'application/json' : 'text/html,application/xhtml+xml';
  let url = raw;
  for (let hop = 0; ; hop++) {
    url = await checkUrl(url, { lookup, hosts });
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept, ...headers }, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      res.body?.cancel?.().catch?.(() => {});
      const loc = res.headers?.get?.('location');
      if (!loc) return { ok: false, status: res.status, url, contentType: '', text: '' };
      if (hop >= maxHops) throw new BlockedUrlError('too many redirects', url);
      url = new URL(loc, url).toString();
      continue;
    }
    const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase();
    const typeOk = expect === 'json' ? /^application\/([\w.+-]+\+)?json\b/.test(contentType) : /^(text\/html|application\/xhtml\+xml)\b/.test(contentType);
    if (!res.ok || !typeOk) {
      res.body?.cancel?.().catch?.(() => {});
      return { ok: false, status: res.status, url, contentType, text: '', ...(res.ok ? { error: 'content-type' } : {}) };
    }
    return { ok: true, status: res.status, url, contentType, text: await readCapped(res, maxBytes, stopAt) };
  }
}
