// Taiku service worker. The build fills in VERSION and SHELL; a new deploy gets a new cache.
const VERSION = '__VERSION__';
const SHELL = __SHELL__;
const SHELL_CACHE = `taiku-shell-${VERSION}`;
const PAGE_CACHE = `taiku-pages-${VERSION}`;
const DATA_CACHE = 'taiku-data';
const IMG_CACHE = 'taiku-img';
const KEEP = [SHELL_CACHE, PAGE_CACHE, DATA_CACHE, IMG_CACHE];
const LIMITS = { [PAGE_CACHE]: 60, [DATA_CACHE]: 80, [IMG_CACHE]: 300 };

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('taiku-') && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const trim = async (name) => {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - LIMITS[name]))) await c.delete(k);
};
const put = async (name, req, res) => {
  if (!res || !res.ok || res.type === 'opaque') return;
  const c = await caches.open(name);
  await c.put(req, res);
  trim(name);
};

// Pages: serve the cached copy at once, refresh it in the background; offline page as last resort.
async function staleWhileRevalidate(e) {
  const cached = await caches.match(e.request, { ignoreSearch: false });
  const net = fetch(e.request).then((res) => { put(PAGE_CACHE, e.request, res.clone()); return res; });
  if (cached) { e.waitUntil(net.catch(() => {})); return cached; }
  try { return await net; } catch { return (await caches.match('/offline.html')) || Response.error(); }
}

// Feed JSON: always try the network so the timeline is fresh; fall back to the last copy.
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    put(DATA_CACHE, req, res.clone());
    return res;
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) || Response.error();
  }
}

// Versioned CSS/JS, icons, avatars and media never change under the same URL.
async function cacheFirst(req, name) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  put(name, req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) return e.respondWith(staleWhileRevalidate(e));
  if (url.pathname.startsWith('/data/') || url.pathname === '/feed.xml') return e.respondWith(networkFirst(req));
  if (/^\/(avatars|media|icons)\//.test(url.pathname) || /\.(png|webp|jpe?g|gif|svg)$/.test(url.pathname)) return e.respondWith(cacheFirst(req, IMG_CACHE));
  if (/\.(css|js)$/.test(url.pathname)) return e.respondWith(cacheFirst(req, SHELL_CACHE));
});