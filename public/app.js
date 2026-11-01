(() => {
  const root = document.documentElement;
  // UI strings: English fallbacks inline; other locales ship <script type="application/json" id="i18n"> from the build.
  const I18N = (() => { try { return JSON.parse(document.getElementById('i18n')?.textContent || '{}'); } catch (e) { return {}; } })();
  const LOC = I18N.locale || 'en-US';
  const PR = new Intl.PluralRules(LOC);
  const SITE_NAME = document.querySelector('meta[property="og:site_name"]')?.content || '';
  const S = (k, en, v = {}) => {
    let x = I18N.s?.[k] ?? en;
    if (x && typeof x === 'object') x = x[PR.select(v.n)] ?? x.other;
    return String(x).replace(/\{(\w+)\}/g, (m, n) => (n in v ? v[n] : n === 'site' ? SITE_NAME : m));
  };
  const RTL = root.dir === 'rtl';
  // Content language attrs when posts/names/bios differ from the UI language (build sets data-clang/data-cdir on <html>).
  const CA = root.dataset.clang ? ` lang="${root.dataset.clang}" dir="${root.dataset.cdir === 'rtl' ? 'rtl' : 'ltr'}"` : '';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  const btn = document.querySelector('.theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem('theme', root.dataset.theme); } catch (e) {}
    });
  }

  // Mobile side drawer (the desktop left nav slides in).
  const drawer = document.getElementById('drawer');
  const scrim = document.querySelector('.drawer-scrim');
  const menuBtns = [...document.querySelectorAll('.menu-btn')];
  let lastMenuBtn = null;
  const setDrawer = (open, from) => {
    if (open) { root.dataset.drawer = 'open'; lastMenuBtn = from || lastMenuBtn; } else delete root.dataset.drawer;
    if (scrim) scrim.hidden = !open;
    menuBtns.forEach((b) => b.setAttribute('aria-expanded', String(open)));
    if (open) drawer?.querySelector('a, button')?.focus();
    else if (lastMenuBtn) lastMenuBtn.focus();
  };
  menuBtns.forEach((b) => b.addEventListener('click', () => setDrawer(root.dataset.drawer !== 'open', b)));
  scrim?.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.dataset.drawer === 'open') setDrawer(false); });
  drawer?.addEventListener('click', (e) => { if (root.dataset.drawer === 'open' && e.target.closest('[data-gate], .theme-toggle, .nav-install')) setDrawer(false); });

  // Logo (and the Home tab): on the home timeline, scroll to the top; already at the top, refresh it, like X.
  document.querySelectorAll('[data-home]').forEach((a) => a.addEventListener('click', (e) => {
    if (location.pathname !== '/' || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    if (root.dataset.drawer === 'open') setDrawer(false);
    if (window.scrollY > 4) window.scrollTo({ top: 0, behavior: 'smooth' });
    else location.reload();
  }));

  // First-visit welcome: dismiss once, remembered.
  const wx = document.querySelector('.welcome-x');
  if (wx) wx.addEventListener('click', () => {
    root.dataset.welcomed = '1';
    try { localStorage.setItem('welcomed', '1'); } catch (e) {}
  });

  // Gate modal: replying, retaiking, following, logging in are not available yet.
  const modal = document.getElementById('gate-modal');
  const NLI = S('notLoggedIn', "You're not logged in");
  const ACCOUNTS = S('gate.login', "Accounts aren't open yet. Keep scrolling, the arguments are free.");
  const GATES = {
    reply: [NLI, S('gate.reply', 'Replying is for members only. The dead talk, you listen (for now).')],
    retaik: [NLI, S('gate.retaik', 'Retaiks and quotes are for members only.')],
    follow: [NLI, S('gate.follow', 'Following is for members only.')],
    login: [S('gate.loginTitle', 'Log in / Sign up is coming soon'), ACCOUNTS],
    signup: [S('gate.signupTitle', 'Sign up is coming soon'), ACCOUNTS],
    post: [NLI, S('gate.post', 'Posting is for members only. For now, only the dead get to taik.')],
    notifications: [S('gate.notificationsTitle', 'Notifications are coming soon'), S('gate.notifications', 'Nobody has mentioned you yet. The dead are busy arguing with each other.')],
    messages: [S('gate.messagesTitle', 'Messages are coming soon'), S('gate.messages', 'DMs with the dead are not open yet.')],
  };
  const openGate = (kind) => {
    const [t, m] = GATES[kind] ?? GATES.login;
    openInfo(t, m);
  };
  function openInfo(t, m) {
    if (!modal || typeof modal.showModal !== 'function') return toast(m);
    modal.querySelector('#gate-title').textContent = t;
    modal.querySelector('.modal-msg').textContent = m;
    if (!modal.open) modal.showModal();
  }
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  const toastEl = document.querySelector('.toast');
  let toastTimer;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  // Likes and bookmarks are local to this browser.
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)).replace('.0', '');
  const likes = new Set(store.get('likes', []));
  const marks = new Set(store.get('bookmarks', []));
  const paintLike = (b) => {
    const on = likes.has(b.dataset.like);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('span').textContent = fmt(Number(b.dataset.count || 0) + (on ? 1 : 0));
  };
  const paintMark = (b) => {
    const on = marks.has(b.dataset.bookmark);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  };

  // Polls: one vote per poll, results revealed after voting or once the poll has closed.
  // Real votes come from the Worker (/api, a Durable Object per poll) and are added to the simulated counts in
  // the HTML. If the API is unavailable (local preview, outage), the vote stays local and polls work as before.
  const votes = store.get('pollVotes', {});
  const sent = store.get('pollSent', {}); // poll id -> server time the vote was counted
  const real = {}; // poll id -> { c: {opt: n}, at } (null while loading)
  const API = /^https?:$/.test(location.protocol);
  const queued = new Set();
  let pollTimer = 0;
  const repaintPoll = (id) => document.querySelectorAll(`.poll[data-poll="${CSS.escape(id)}"]`).forEach(paintPoll);
  const loadReal = () => {
    const ids = [...queued].slice(0, 20);
    ids.forEach((id) => { queued.delete(id); real[id] = null; });
    if (queued.size) pollTimer = setTimeout(loadReal, 50);
    fetch(`/api/polls?ids=${ids.map(encodeURIComponent).join(',')}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => ids.forEach((id) => { if (d[id]?.c) { real[id] = d[id]; repaintPoll(id); } }))
      .catch(() => {});
  };
  const wantReal = (id) => {
    if (!API || id in real || queued.has(id)) return;
    queued.add(id);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadReal, 50);
  };
  const sendVote = (id, opt) => {
    if (!API) return;
    fetch(`/api/poll/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opt }) })
      .then((r) => r.json().then((d) => {
        // 409: this browser/network already voted (e.g. storage was cleared), so the totals include that vote.
        if ((r.ok || r.status === 409) && d?.c) { real[id] = { c: d.c, at: d.at }; sent[id] = d.at; store.set('pollSent', sent); repaintPoll(id); }
      }))
      .catch(() => {});
  };
  const paintPoll = (poll) => {
    const id = poll.dataset.poll;
    wantReal(id);
    const mine = votes[id];
    const live = real[id];
    const counted = live && sent[id] && live.at >= sent[id];
    const left = Date.parse(poll.dataset.ends) - Date.now();
    const closed = !(left > 0);
    const opts = [...poll.querySelectorAll('.poll-opt')];
    const counts = opts.map((o) => Number(o.dataset.votes) + (live?.c?.[o.dataset.opt] ?? 0) + (o.dataset.opt === mine && !counted ? 1 : 0));
    const total = counts.reduce((a, b) => a + b, 0);
    const max = Math.max(...counts);
    opts.forEach((o, i) => {
      const pct = total ? Math.round((counts[i] / total) * 100) : 0;
      o.querySelector('.po-bar').style.width = `${pct}%`;
      o.querySelector('.po-pct').textContent = `${pct}%`;
      o.classList.toggle('lead', counts[i] === max);
      o.classList.toggle('mine', o.dataset.opt === mine);
      o.disabled = closed || mine != null;
      o.setAttribute('aria-label', mine != null || closed ? `${o.querySelector('.po-label').textContent}, ${pct}%` : o.querySelector('.po-label').textContent);
    });
    poll.classList.toggle('closed', closed);
    poll.classList.toggle('voted', mine != null);
    poll.querySelector('.poll-total').textContent = S('votes', '{count} votes', { count: total.toLocaleString(LOC), n: total });
    const h = Math.floor(left / 3600000);
    const ago = (k, n, one, other) => S(k, { one, other }, { n });
    poll.querySelector('.poll-state').textContent = closed ? S('final', 'Final results') : h >= 24 ? ago('days', Math.floor(h / 24), '{n} day left', '{n} days left') : h >= 1 ? ago('hours', h, '{n} hour left', '{n} hours left') : ago('minutes', Math.max(1, Math.round(left / 60000)), '{n} minute left', '{n} minutes left');
  };

  // Image viewer: post photos, profile avatar and header open full size, like X.
  const lightbox = document.getElementById('lightbox');
  let lbFrom = null;
  function openLightbox(src, alt, from) {
    if (!lightbox || typeof lightbox.showModal !== 'function') { window.open(src, '_blank', 'noopener'); return; }
    const img = lightbox.querySelector('img');
    img.src = src;
    img.alt = alt;
    lightbox.querySelector('figcaption').textContent = alt;
    lbFrom = from;
    lightbox.showModal();
  }
  if (lightbox) {
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox || e.target.tagName === 'FIGURE') lightbox.close(); });
    lightbox.addEventListener('close', () => { lightbox.querySelector('img').removeAttribute('src'); lbFrom?.focus(); });
  }
  document.addEventListener('click', (e) => {
    const opt = e.target.closest('.poll-opt');
    if (opt) {
      const poll = opt.closest('.poll');
      if (!opt.disabled && votes[poll.dataset.poll] == null) {
        votes[poll.dataset.poll] = opt.dataset.opt;
        store.set('pollVotes', votes);
        repaintPoll(poll.dataset.poll);
        sendVote(poll.dataset.poll, opt.dataset.opt);
      }
      return;
    }
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) { openLightbox(zoom.dataset.zoom, zoom.dataset.zoomAlt || '', zoom); return; }
    const alt = e.target.closest('[data-alt]');
    if (alt) { openInfo(S('alt', 'Image description'), alt.dataset.alt); return; }
    const like = e.target.closest('[data-like]');
    if (like) {
      const id = like.dataset.like;
      likes.has(id) ? likes.delete(id) : likes.add(id);
      store.set('likes', [...likes]);
      document.querySelectorAll(`[data-like="${CSS.escape(id)}"]`).forEach(paintLike);
      if (likes.has(id)) { like.classList.remove('pop'); void like.offsetWidth; like.classList.add('pop'); bumpAffinity(like.closest('[data-author]')?.dataset.author, 1); }
      return;
    }
    const mark = e.target.closest('[data-bookmark]');
    if (mark) {
      const id = mark.dataset.bookmark;
      marks.has(id) ? marks.delete(id) : marks.add(id);
      store.set('bookmarks', [...marks]);
      document.querySelectorAll(`[data-bookmark="${CSS.escape(id)}"]`).forEach(paintMark);
      toast(marks.has(id) ? S('bmAdded', 'Added to your Bookmarks') : S('bmRemoved', 'Removed from your Bookmarks'));
      return;
    }
    const share = e.target.closest('[data-share]');
    if (share) {
      const u = new URL(share.dataset.share, location.origin).href;
      if (navigator.share) navigator.share({ url: u }).catch(() => {});
      else if (navigator.clipboard) navigator.clipboard.writeText(u).then(() => toast(S('copied', 'Copied to clipboard')), () => toast(u));
      else toast(u);
      return;
    }
    const gate = e.target.closest('[data-gate]');
    if (gate) { openGate(gate.dataset.gate); return; }
    // Whole post card is clickable (except inner links/buttons), like X.
    if (e.target.closest('a, button, dialog')) return;
    const card = e.target.closest('.post[data-href]:not(.focal)');
    if (card && !window.getSelection().toString()) location.href = card.dataset.href;
  });

  // Relative timestamps for recent posts.
  const relTimes = (scope) => {
    const now = Date.now();
    scope.querySelectorAll('time[data-rel]').forEach((t) => {
      const d = Date.parse(t.getAttribute('datetime'));
      const s = Math.round((now - d) / 1000);
      if (s < 0 || s > 86400 * 6) return;
      t.textContent = s < 3600 ? S('relM', '{n}m', { n: Math.max(1, Math.round(s / 60)) }) : s < 86400 ? S('relH', '{n}h', { n: Math.round(s / 3600) }) : S('relD', '{n}d', { n: Math.round(s / 86400) });
      t.title = new Date(d).toLocaleString();
    });
  };

  // Follows live in a first-party cookie (taiku_follows, 1 year) mirrored to localStorage.
  const COOKIE = 'taiku_follows';
  const readFollows = () => {
    const m = document.cookie.match(/(?:^|;\s*)taiku_follows=([^;]*)/);
    const list = m ? decodeURIComponent(m[1]).split('.').filter(Boolean) : store.get('follows', []);
    return new Set(list.filter((id) => /^[a-z0-9_-]+$/.test(id)));
  };
  const follows = readFollows();
  const saveFollows = () => {
    const v = [...follows].join('.');
    document.cookie = `${COOKIE}=${encodeURIComponent(v)}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    store.set('follows', [...follows]);
  };
  if (follows.size) saveFollows();
  // Followed topics/trends: same format in taiku_topics.
  const readTopics = () => {
    const m = document.cookie.match(/(?:^|;\s*)taiku_topics=([^;]*)/);
    const list = m ? decodeURIComponent(m[1]).split('.').filter(Boolean) : store.get('topics', []);
    return new Set(list.filter((k) => /^[a-z0-9_-]+$/.test(k)));
  };
  const topics = readTopics();
  const saveTopics = () => {
    document.cookie = `taiku_topics=${encodeURIComponent([...topics].join('.'))}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    store.set('topics', [...topics]);
  };
  if (topics.size) saveTopics();
  const relabel = (b, on) => {
    const l = b.getAttribute('aria-label');
    if (!l) return;
    b.dataset.n ??= (l.match(/@\w+/) || [l.replace(/^\S+\s+/, '')])[0];
    b.setAttribute('aria-label', on ? S('unfollowName', 'Unfollow {name}', { name: b.dataset.n }) : S('followName', 'Follow {name}', { name: b.dataset.n }));
  };
  const paintFollow = (b) => {
    const on = follows.has(b.dataset.follow);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    relabel(b, on);
  };
  const paintTopic = (b) => {
    const on = topics.has(b.dataset.topic);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    relabel(b, on);
  };
  let topicData = null;
  const loadTopics = () => (topicData ??= fetch(`/data/topics.json?v=${document.body.dataset.build || ''}`).then((r) => r.json()).catch(() => ({ topics: [], trends: [], labels: {} })));
  const paintFollowers = (el) => { el.textContent = fmt(Number(el.dataset.count || 0) + (follows.has(el.dataset.followers) ? 1 : 0)); };

  function hydrate(scope) {
    scope.querySelectorAll('[data-like]').forEach(paintLike);
    scope.querySelectorAll('[data-bookmark]').forEach(paintMark);
    scope.querySelectorAll('.poll[data-poll]').forEach(paintPoll);
    scope.querySelectorAll('[data-follow]').forEach(paintFollow);
    scope.querySelectorAll('[data-topic]').forEach(paintTopic);
    scope.querySelectorAll('[data-followers]').forEach(paintFollowers);
    relTimes(scope);
  }
  hydrate(document);

  // Home timelines: For you (static) and Following (client-side, from /data/u/<id>.json).
  const build = document.body.dataset.build || '';
  const fFeed = document.querySelector('.following-feed');
  const authorCache = new Map();
  const loadAuthor = (id) => {
    if (!authorCache.has(id)) authorCache.set(id, fetch(`/data/${id.startsWith('../t/') ? `t/${encodeURIComponent(id.slice(5))}` : `u/${encodeURIComponent(id)}`}.json?v=${build}`).then((r) => (r.ok ? r.json() : { posts: [] })).catch(() => ({ posts: [] })));
    return authorCache.get(id);
  };
  let renderSeq = 0;
  async function renderFollowing() {
    if (!fFeed) return;
    const seq = ++renderSeq;
    root.dataset.following = follows.size || topics.size ? 'some' : 'none';
    if (!follows.size && !topics.size) { fFeed.innerHTML = ''; return; }
    fFeed.setAttribute('aria-busy', 'true');
    const [lists, tlists, td] = await Promise.all([
      Promise.all([...follows].map(loadAuthor)),
      Promise.all([...topics].map((k) => loadAuthor(`../t/${k}`).then((l) => (l.posts || []).map((p) => ({ ...p, topic: k }))))),
      topics.size ? loadTopics() : null,
    ]);
    if (seq !== renderSeq) return;
    const seen = new Set();
    const items = [...lists.flatMap((l) => l.posts || []), ...tlists.flat()].sort((a, b) => b.t.localeCompare(a.t) || (a.topic ? 1 : -1)).filter((p) => !seen.has(p.k || p.id) && seen.add(p.k || p.id)).slice(0, 60);
    const ctx = (p) => (p.topic && !follows.has(p.a) ? `<div class="topic-ctx"><a href="/connect/#topics">${esc(td?.labels?.[p.topic] || p.topic)}</a></div>` : '');
    fFeed.innerHTML = items.length ? items.map((p) => ctx(p) + p.h).join('') : `<p class="empty">${S('followingEmpty', 'The accounts you follow haven\u2019t posted yet.')}</p>`;
    fFeed.setAttribute('aria-busy', 'false');
    hydrate(fFeed);
  }
  // "For you": client-side ranking (public/rank.js) over /data/foryou.json, with seen-tracking and infinite scroll.
  const R = window.TaikuRank;
  function bumpAffinity(author, w) {
    if (!author) return;
    const aff = store.get('taiku_aff', {});
    aff[author] = Math.min(20, (aff[author] || 0) + w);
    store.set('taiku_aff', aff);
  }
  const focal = document.querySelector('.post.focal[data-author]');
  if (focal) bumpAffinity(focal.dataset.author, 0.5);
  const profileFollow = document.querySelector('.profile [data-follow]');
  if (profileFollow) bumpAffinity(profileFollow.dataset.follow, 0.5);

  const seenNow = new Set();
  const seenTimers = new Map();
  const recordSeen = (id) => {
    if (!R || seenNow.has(id)) return;
    seenNow.add(id);
    const seen = R.markSeen(store.get('taiku_seen', {}), id, Date.now());
    store.set('taiku_seen', R.pruneSeen(seen));
  };
  const seenObs = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      const id = en.target.dataset.pid;
      if (en.isIntersecting) { if (!seenTimers.has(id)) seenTimers.set(id, setTimeout(() => { recordSeen(id); seenObs.unobserve(en.target); }, 1000)); }
      else { clearTimeout(seenTimers.get(id)); seenTimers.delete(id); }
    }
  }, { threshold: 0.5 }) : null;
  const watchSeen = (scope) => { if (seenObs) scope.querySelectorAll('.post[data-pid]').forEach((el) => seenObs.observe(el)); };

  const fyFeed = document.querySelector('#panel-foryou .feed');
  if (fyFeed && R && window.fetch) {
    let seed = Number(sessionStorage.getItem('taiku_seed'));
    if (!seed) { seed = Math.floor(Math.random() * 2 ** 31) + 1; try { sessionStorage.setItem('taiku_seed', String(seed)); } catch (e) {} }
    const shards = new Map();
    const shard = (n) => {
      if (!shards.has(n)) shards.set(n, fetch(`/data/f/${n}.json?v=${build}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
      return shards.get(n);
    };
    fetch(`/data/foryou.json?v=${build}`).then((r) => (r.ok ? r.json() : Promise.reject())).then(async (data) => {
      const { fresh, seen } = R.rankFeed(data.items, { now: Date.now(), seed, seen: store.get('taiku_seen', {}), follows, topics, affinity: store.get('taiku_aff', {}) });
      const queue = [...fresh, ...(seen.length ? [{ divider: true }] : []), ...seen];
      if (queue.length > 6) queue.splice(5, 0, { strip: 'people' });
      if (queue.length > 18) queue.splice(17, 0, { strip: 'topics' });
      const BATCH = 15;
      let pos = 0;
      let busy = false;
      const sentinel = document.createElement('div');
      sentinel.className = 'feed-sentinel';
      const more = async () => {
        if (busy || pos >= queue.length) return;
        busy = true;
        const batch = queue.slice(pos, pos + BATCH);
        pos += batch.length;
        const html = await Promise.all(batch.map(async (it) => (it.strip ? feedStrip(it.strip) : it.divider
          ? `<div class="caught-up" role="separator"><b>${S('caughtUp', 'You\u2019re all caught up')}</b><span>${S('seenBefore', 'You\u2019ve seen the new posts. Here\u2019s what you scrolled past before.')}</span></div>`
          : (await shard(it.s))[it.id] || '')));
        const frag = document.createElement('div');
        frag.innerHTML = html.join('');
        hydrate(frag);
        const nodes = [...frag.childNodes];
        sentinel.before(...nodes);
        nodes.forEach((n) => n.nodeType === 1 && watchSeen(n));
        if (pos >= queue.length) {
          sentinel.remove();
          fyFeed.insertAdjacentHTML('beforeend', `<div class="caught-up end"><b>${fresh.length ? S('everything', 'That\u2019s everything for now') : S('caughtUp', 'You\u2019re all caught up')}</b><span>${S('caughtUpText', 'New taiks land every few hours. Meanwhile, <a href="/thinkers/">meet the thinkers</a>.')}</span></div>`);
        }
        busy = false;
        if (pos < queue.length && sentinel.getBoundingClientRect().top < innerHeight * 2) more();
      };
      fyFeed.replaceChildren(sentinel);
      fyFeed.dataset.ranked = '1';
      document.querySelector('#panel-foryou .pager')?.setAttribute('hidden', '');
      await more();
      if ('IntersectionObserver' in window) new IntersectionObserver((en) => { if (en[0].isIntersecting) more(); }, { rootMargin: '1200px 0px' }).observe(sentinel);
    }).catch(() => watchSeen(fyFeed));
  }

  const tabs = [...document.querySelectorAll('.home-top .feed-tabs [role="tab"]')];
  const selectTab = (name, focus) => {
    root.dataset.tab = name;
    try { localStorage.setItem('feedTab', name); } catch (e) {}
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    if (name === 'following') renderFollowing();
  };
  if (tabs.length) {
    selectTab(root.dataset.tab === 'following' ? 'following' : 'foryou');
    tabs.forEach((t) => {
      t.addEventListener('click', () => { const was = root.dataset.tab; selectTab(t.dataset.tab); if (was === t.dataset.tab) window.scrollTo({ top: 0, behavior: 'smooth' }); });
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const i = (tabs.indexOf(t) + ((e.key === 'ArrowRight') !== RTL ? 1 : tabs.length - 1)) % tabs.length;
        selectTab(tabs[i].dataset.tab, true);
      });
    });
  }

  document.addEventListener('click', (e) => {
    const fb = e.target.closest('[data-follow]');
    if (!fb) return;
    e.preventDefault();
    const id = fb.dataset.follow;
    const on = !follows.has(id);
    on ? follows.add(id) : follows.delete(id);
    saveFollows();
    document.querySelectorAll(`[data-follow="${CSS.escape(id)}"]`).forEach(paintFollow);
    document.querySelectorAll(`[data-followers="${CSS.escape(id)}"]`).forEach(paintFollowers);
    if (on) bumpAffinity(id, 1);
    followChanged(fb, on ? S('followed', 'Followed. Their posts now show in Following.') : S('unfollowed', 'Unfollowed'));
  });
  document.addEventListener('click', (e) => {
    const tb = e.target.closest('[data-topic]');
    if (!tb) return;
    e.preventDefault();
    const k = tb.dataset.topic;
    const on = !topics.has(k);
    on ? topics.add(k) : topics.delete(k);
    saveTopics();
    document.querySelectorAll(`[data-topic="${CSS.escape(k)}"]`).forEach(paintTopic);
    followChanged(tb, on ? S('topicFollowed', 'Topic followed. Posts about it now show in Following.') : S('topicUnfollowed', 'Topic unfollowed'));
  });
  function followChanged(from, msg) {
    if (msg && !from.closest('.onboard')) toast(msg);
    else paintOnboard();
    if (root.dataset.tab === 'following' && !from.closest('.onboard')) renderFollowing();
    else if (fFeed) root.dataset.following = follows.size || topics.size ? 'some' : 'none';
    document.querySelectorAll('[data-me-n="follows"]').forEach((el) => { el.textContent = follows.size; });
    document.querySelectorAll('[data-me-n="topics"]').forEach((el) => { el.textContent = topics.size; });
  }

  // Hovercards on avatars and names (mouse only; profiles have the same info for keyboard/touch users).
  let people = null;
  const loadPeople = () => (people ??= fetch(`/data/personas.json?v=${build}`).then((r) => r.json()).then((d) => d.personas).catch(() => ({})));
  let card = null, showT = 0, hideT = 0, anchor = null;
  const hideCard = () => { clearTimeout(showT); hideT = setTimeout(() => { if (card) card.hidden = true; anchor = null; }, 250); };
  const showCard = async (a) => {
    const m = a.getAttribute('href').match(/^\/thinkers\/([^/]+)\/$/);
    if (!m) return;
    const p = (await loadPeople())[m[1]];
    if (!p || anchor !== a) return;
    if (!card) {
      card = document.createElement('div');
      card.className = 'hovercard';
      card.addEventListener('mouseenter', () => clearTimeout(hideT));
      card.addEventListener('mouseleave', hideCard);
      document.body.appendChild(card);
    }
    const href = `/thinkers/${m[1]}/`;
    card.innerHTML = `<div class="hc-top"><a href="${href}" tabindex="-1">${p.a ? `<img class="avatar md" src="${esc(p.a)}" alt="" width="64" height="64">` : ''}</a><button type="button" class="btn follow-btn btn-sm" data-follow="${esc(m[1])}" aria-pressed="false" aria-label="${esc(S('followAria', 'Follow @{handle}', { handle: p.h }))}"><span class="fb-off">${S('follow', 'Follow')}</span><span class="fb-on">${S('following', 'Following')}</span><span class="fb-un">${S('unfollow', 'Unfollow')}</span></button></div><a class="hc-name"${CA} href="${href}">${esc(p.n)}</a><div class="handle">@${esc(p.h)}</div><p class="hc-bio"${CA}>${esc(p.b)}</p><div class="hc-stats"><span><b>${fmt(p.fg)}</b> ${S('following', 'Following')}</span><span><b data-followers="${esc(m[1])}" data-count="${p.fr}">${fmt(p.fr)}</b> ${S('followers', 'Followers')}</span></div>`;
    hydrate(card);
    const r = a.getBoundingClientRect();
    card.hidden = false;
    const top = r.bottom + window.scrollY + 8;
    const left = Math.min(Math.max(8, r.left + window.scrollX - 20), window.scrollX + document.documentElement.clientWidth - card.offsetWidth - 8);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  };
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.addEventListener('mouseover', (e) => {
      const a = e.target.closest('.post .avatar-link, .post-head .name, .wtf-link');
      if (!a || a === anchor) { if (a) clearTimeout(hideT); return; }
      clearTimeout(hideT); clearTimeout(showT);
      anchor = a;
      showT = setTimeout(() => showCard(a), 450);
    });
    document.addEventListener('mouseout', (e) => {
      const a = e.target.closest('.post .avatar-link, .post-head .name, .wtf-link');
      if (a && !a.contains(e.relatedTarget)) hideCard();
    });
  }

  // Discovery: Who to follow, topics, onboarding, /connect/ and the local "You" profile (/me/).
  const TX = {
    whoToFollow: S('whoToFollow', 'Who to follow'), showMore: S('showMore', 'Show more'), topicsToFollow: S('topicsToFollow', 'Topics to follow'),
    follow: S('follow', 'Follow'), following: S('following', 'Following'), unfollow: S('unfollow', 'Unfollow'),
    meEmpty: { likes: S('meEmptyLikes', 'No likes yet. Tap the heart on a post and it shows up here.'), bookmarks: S('meEmptyBookmarks', 'No bookmarks yet. Save posts with the bookmark button to find them later.'), following: S('meEmptyFollowing', 'You aren\u2019t following anyone yet.'), topics: S('meEmptyTopics', 'You aren\u2019t following any topics yet.'), viewed: S('meEmptyViewed', 'Posts you open show up here.') },
    loading: S('loading', 'Loading\u2026'), picked: (n) => S('picked', '{n} picked', { n }),
  };
  const L = (k) => TX[k];
  const seeds = () => follows.size || topics.size || Object.keys(store.get('taiku_aff', {})).length;
  const avatarHtml = (p, size) => (p.a ? `<img class="avatar ${size}" src="${esc(p.a)}" alt="" width="${size === 'md' ? 64 : 40}" height="${size === 'md' ? 64 : 40}" loading="lazy" decoding="async">` : `<span class="avatar ${size}" style="--c:${esc(p.c)}" aria-hidden="true">${esc(p.n[0])}</span>`);
  const followBtnHtml = (id, p) => `<button type="button" class="btn follow-btn btn-sm" data-follow="${esc(id)}" aria-pressed="false" aria-label="${esc(S('followAria', 'Follow @{handle}', { handle: p.h }))}"><span class="fb-off">${esc(L('follow'))}</span><span class="fb-on">${esc(L('following'))}</span><span class="fb-un">${esc(L('unfollow'))}</span></button>`;
  function personRow(id, p, bio = true) {
    return `<div class="wtf-wide"><div class="wtf"><a class="wtf-link" href="/thinkers/${esc(id)}/">${avatarHtml(p, 'sm')}<span class="wtf-names"><b>${esc(p.n)}</b><span class="handle">@${esc(p.h)}</span></span></a>${followBtnHtml(id, p)}</div>${bio ? `<p class="wtf-bio">${esc(p.b)}</p>` : ''}</div>`;
  }
  const chipHtml = (k, label) => `<button type="button" class="tchip" data-topic="${esc(k)}" aria-pressed="false"><span>${esc(label)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path class="tc-plus" d="M12 6v12M6 12h12"/><path class="tc-tick" d="m6 12.5 4 4 8-9"/></svg></button>`;
  const suggest = async () => {
    const ppl = await loadPeople();
    return { ppl, list: R ? R.suggestPeople(ppl, { follows, topics, affinity: store.get('taiku_aff', {}), seed: Number(sessionStorage.getItem('taiku_seed')) || 1 }) : [] };
  };
  // In-feed strips (X shows a "Who to follow" carousel and topic chips between posts).
  async function feedStrip(kind) {
    if (kind === 'people') {
      const { ppl, list } = await suggest();
      const cards = list.filter((x) => ppl[x.id].k === 'thinker').slice(0, 10).map(({ id }) => {
        const p = ppl[id];
        return `<div class="ws-card"><a class="ws-link" href="/thinkers/${esc(id)}/">${avatarHtml(p, 'md')}<b>${esc(p.n)}</b><span class="handle">@${esc(p.h)}</span></a>${followBtnHtml(id, p)}</div>`;
      }).join('');
      return cards ? `<section class="wtf-strip" aria-label="${esc(L('whoToFollow'))}"><h2>${esc(L('whoToFollow'))}</h2><div class="ws-cards">${cards}</div><a class="more" href="/connect/">${esc(L('showMore'))}</a></section>` : '';
    }
    const td = await loadTopics();
    const chips = td.topics.filter(([k]) => !topics.has(k)).slice(0, 12).map(([k, l]) => chipHtml(k, l)).join('');
    return chips ? `<section class="topic-strip" aria-label="${esc(L('topicsToFollow'))}"><h2>${esc(L('topicsToFollow'))}</h2><div class="topic-chips">${chips}</div><a class="more" href="/connect/#topics">${esc(L('showMore'))}</a></section>` : '';
  }
  // Sidebar "Who to follow": personalised once there's something to go on.
  const wtfRows = document.querySelector('.wtf-panel .wtf-rows');
  if (wtfRows && seeds()) suggest().then(({ ppl, list }) => {
    const top = list.filter((x) => ppl[x.id].k === 'thinker').slice(0, 3);
    if (top.length) { wtfRows.innerHTML = top.map(({ id }) => personRow(id, ppl[id], false).replace(/^<div class="wtf-wide">|<\/div>$/g, '')).join(''); hydrate(wtfRows); }
  });
  // Simple tab sets driven by the URL hash (/connect/ and /me/).
  function hashTabs(sel, attr, onSelect) {
    const tbs = [...document.querySelectorAll(sel)];
    if (!tbs.length) return;
    const names = tbs.map((b) => b.dataset[attr]);
    const pick = (name, focus) => {
      tbs.forEach((b) => { const on = b.dataset[attr] === name; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
      onSelect(name);
    };
    const fromHash = () => pick(names.includes(location.hash.slice(1)) ? location.hash.slice(1) : names[0]);
    tbs.forEach((b, i) => {
      b.addEventListener('click', () => { history.replaceState(null, '', `#${b.dataset[attr]}`); pick(b.dataset[attr]); });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const n = tbs[(i + (e.key === 'ArrowRight' ? 1 : tbs.length - 1)) % tbs.length];
        history.replaceState(null, '', `#${n.dataset[attr]}`);
        pick(n.dataset[attr], true);
      });
    });
    addEventListener('hashchange', fromHash);
    fromHash();
  }
  // /connect/: re-rank the people list by similarity to what this browser follows and likes.
  const cPeople = document.querySelector('.connect-people');
  if (cPeople) {
    hashTabs('.connect-tabs [role="tab"]', 'ctab', (name) => document.querySelectorAll('.ctab-panel').forEach((p) => { p.hidden = p.id !== `cpanel-${name}`; }));
    if (seeds()) suggest().then(({ list }) => {
      const rows = new Map([...cPeople.children].map((el) => [el.dataset.pid, el]));
      const order = [...list.map((x) => x.id), ...[...follows]].filter((id) => rows.has(id));
      cPeople.append(...order.map((id) => rows.get(id)));
    });
  }
  // Onboarding picker: optional; opens once on a first visit to the home timeline, or from "Pick thinkers and topics".
  const onboard = document.getElementById('onboard');
  const obDone = onboard?.querySelector('.ob-done');
  function paintOnboard() {
    if (!obDone) return;
    const n = follows.size + topics.size;
    obDone.disabled = n < 3;
    const c = onboard.querySelector('.ob-count');
    if (c) c.textContent = L('picked')(n);
  }
  if (onboard) {
    const open = () => { paintOnboard(); hydrate(onboard); onboard.showModal(); };
    document.addEventListener('click', (e) => { if (e.target.closest('[data-onboard]')) { e.preventDefault(); open(); } });
    onboard.addEventListener('close', () => store.set('taiku_onboarded', 1));
    onboard.addEventListener('click', (e) => { if (e.target === onboard) onboard.close(); });
    onboard.querySelector('.ob-skip').addEventListener('click', () => onboard.close());
    obDone.addEventListener('click', () => { onboard.close(); const tb = document.getElementById('tab-following'); if (tb) tb.click(); else location.href = '/'; });
    if (!store.get('taiku_onboarded', 0) && !follows.size && !topics.size && !navigator.webdriver && !matchMedia('(display-mode: standalone)').matches) setTimeout(() => { if (!document.querySelector('dialog[open]')) open(); }, 2500);
  }
  // Posts opened on this device, for the "Viewed" tab of /me/.
  const focalPost = document.querySelector('.post.focal[data-pid]');
  if (focalPost) store.set('taiku_opened', [focalPost.dataset.pid, ...store.get('taiku_opened', []).filter((id) => id !== focalPost.dataset.pid)].slice(0, 50));
  // /me/: likes, bookmarks, follows and viewed posts from this browser's storage, rendered with the search shards.
  const mePanel = document.getElementById('me-panel');
  if (mePanel) {
    followChanged(mePanel, '');
    let sIdx = null;
    const postIndex = () => (sIdx ??= fetch(`/data/search.json?v=${build}`).then((r) => r.json()).then((d) => new Map(d.posts.map((row) => [row[0], { t: row[3], s: row[6] }]))).catch(() => new Map()));
    const meShards = new Map();
    const meShard = (n) => { if (!meShards.has(n)) meShards.set(n, fetch(`/data/s/${n}.json?v=${build}`).then((r) => r.json()).catch(() => ({}))); return meShards.get(n); };
    const empty = (k) => `<p class="empty">${esc(L('meEmpty')[k])}</p>`;
    let seq = 0;
    const show = async (name) => {
      const my = ++seq;
      mePanel.setAttribute('aria-busy', 'true');
      let html = '';
      if (name === 'following') {
        const ppl = await loadPeople();
        html = [...follows].filter((id) => ppl[id]).map((id) => personRow(id, ppl[id])).join('') || empty(name);
      } else if (name === 'topics') {
        const td = await loadTopics();
        html = topics.size ? `<div class="topic-chips me-chips">${[...topics].map((k) => chipHtml(k, td.labels[k] || k)).join('')}</div>` : empty(name);
      } else {
        const ids = name === 'likes' ? [...likes].reverse() : name === 'bookmarks' ? [...marks].reverse() : store.get('taiku_opened', []);
        const pi = await postIndex();
        const rows = ids.filter((id) => pi.has(id)).slice(0, 50);
        const cards = await Promise.all(rows.map(async (id) => (await meShard(pi.get(id).s))[id] || ''));
        html = cards.join('') || empty(name);
      }
      if (my !== seq) return;
      mePanel.innerHTML = html;
      mePanel.setAttribute('aria-busy', 'false');
      hydrate(mePanel);
    };
    hashTabs('.me-tabs [role="tab"]', 'mtab', show);
  }

  // Search (static): a lazily loaded index and HTML shards from /data; the query lives in the URL (?q=&f=).
  const sRes = document.getElementById('search-results');
  if (sRes) {
    const FILTERS = ['top', 'live', 'user', 'media'];
    const sTabs = [...document.querySelectorAll('.search-tabs [role="tab"]')];
    const tablist = document.querySelector('.search-tabs');
    const explore = document.querySelector('.search-explore');
    const inputs = [...document.querySelectorAll('.search-form input[name="q"]')];
    const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let index = null;
    const loadIndex = () => (index ??= Promise.all([fetch(`/data/search.json?v=${build}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))), loadPeople()]).then(([d, ppl]) =>
      d.posts.map(([id, a, text, t, l, m, s]) => ({ id, a, text, t, l, m, s, who: fold(`${ppl[a]?.n || ''} ${ppl[a]?.h || ''}`) }))));
    const sShards = new Map();
    const sShard = (n) => {
      if (!sShards.has(n)) sShards.set(n, fetch(`/data/s/${n}.json?v=${build}`).then((r) => r.json()).catch(() => ({})));
      return sShards.get(n);
    };
    const parse = (raw) => {
      const terms = [], from = [];
      String(raw).replace(/"([^"]+)"|(\S+)/g, (_, ph, w) => {
        const t = fold(ph || w);
        const m = t.match(/^from:@?([\w]+)$/);
        if (m) from.push(m[1]);
        else if (t.replace(/^@/, '')) terms.push(t.replace(/^@/, ''));
        return '';
      });
      return { terms, from, res: terms.map((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${reEsc(t)}`, 'u')) };
    };
    const matchPeople = async (qq) => {
      const ppl = await loadPeople();
      return Object.entries(ppl)
        .map(([id, p]) => {
          const who = fold(`${p.n} ${p.h}`), bio = fold(p.b);
          if (qq.from.length && !qq.from.some((h) => fold(p.h) === h)) return null;
          let sc = 0;
          for (const re of qq.res) { if (re.test(who)) sc += 3; else if (re.test(bio)) sc += 1; else return null; }
          return { id, p, sc: sc + Math.log10(1 + (p.fr || 0)) / 10 };
        })
        .filter(Boolean).sort((x, y) => y.sc - x.sc);
    };
    const matchPosts = async (qq, f) => {
      const rows = await loadIndex();
      const now = Date.now();
      const out = [];
      for (const r of rows) {
        if (qq.from.length && !qq.from.some((h) => r.who.split(' ').pop() === h)) continue;
        if (f === 'media' && r.m !== 2) continue;
        let rel = 0, ok = true;
        for (const re of qq.res) { const a = re.test(r.text), b = re.test(r.who); if (!a && !b) { ok = false; break; } rel += a ? 1 : 0.5; }
        if (ok) out.push({ r, sc: rel * 3 + Math.log1p(r.l) + 3 * Math.exp(-(now - r.t) / 6048e5) });
      }
      if (f !== 'top') return out.map((x) => x.r).sort((x, y) => y.t - x.t);
      // Top: best first, but each further post by the same author ranks a little lower so one account can't fill the page.
      const per = new Map();
      return out.sort((x, y) => y.sc - x.sc)
        .map((x) => { const n = per.get(x.r.a) || 0; per.set(x.r.a, n + 1); return { r: x.r, sc: x.sc - n * 1.5 }; })
        .sort((x, y) => y.sc - x.sc).map((x) => x.r);
    };
    let q = '', f = 'top', results = [], shown = 0, runSeq = 0;
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'search-more';
    moreBtn.textContent = S('showMore', 'Show more');
    const PAGE = 20;
    const page = async () => {
      const seq = runSeq;
      const slice = results.slice(shown, shown + PAGE);
      shown += slice.length;
      const html = await Promise.all(slice.map(async (r) => (await sShard(r.s))[r.id] || ''));
      if (seq !== runSeq) return;
      const frag = document.createElement('div');
      frag.innerHTML = html.join('');
      hydrate(frag);
      moreBtn.remove();
      sRes.append(...frag.childNodes);
      if (shown < results.length) sRes.append(moreBtn);
    };
    moreBtn.addEventListener('click', page);
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && moreBtn.isConnected) page(); }, { rootMargin: '600px' }).observe(moreBtn);
    const run = async () => {
      const seq = ++runSeq;
      inputs.forEach((i) => { i.value = q; });
      sTabs.forEach((t) => { const on = t.dataset.f === f; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
      tablist.hidden = !q;
      explore.hidden = !!q;
      document.title = q ? S('searchTitleQ', '{q} - Search | {site}', { q }) : S('searchTitle', 'Search | {site}');
      sRes.innerHTML = '';
      results = []; shown = 0;
      if (!q) return;
      const qq = parse(q);
      sRes.setAttribute('aria-busy', 'true');
      try {
        const people = f === 'user' || f === 'top' ? await matchPeople(qq) : [];
        const found = f === 'user' ? [] : await matchPosts(qq, f);
        if (seq !== runSeq) return;
        const top = f === 'top' ? people.slice(0, 3) : people;
        if (top.length) {
          sRes.insertAdjacentHTML('beforeend', `${f === 'top' ? `<h2 class="section-h">${S('people', 'People')}</h2>` : ''}${top.map((x) => personRow(x.id, x.p)).join('')}${f === 'top' && people.length > 3 ? `<a class="more" href="?q=${encodeURIComponent(q)}&f=user" data-f="user">${S('viewAll', 'View all')}</a>` : ''}`);
          hydrate(sRes);
        }
        results = found;
        if (!top.length && !found.length) sRes.innerHTML = `<div class="search-empty"><h2>${S('noResults', 'No results for \u201c{q}\u201d', { q: esc(q) })}</h2><p>${S('noResultsText', 'Try searching for something else, or check the spelling. Search covers posts, thinkers and topics.')}</p></div>`;
        else await page();
      } catch (err) {
        sRes.innerHTML = `<p class="empty">${S('searchDown', 'Search is unavailable right now. Please try again.')}</p>`;
      }
      sRes.setAttribute('aria-busy', 'false');
    };
    const go = (nq, nf, push) => {
      q = String(nq || '').trim().slice(0, 120);
      f = FILTERS.includes(nf) ? nf : 'top';
      const u = q ? `/search/?q=${encodeURIComponent(q)}${f !== 'top' ? `&f=${f}` : ''}` : '/search/';
      history[push ? 'pushState' : 'replaceState'](null, '', u);
      run();
    };
    document.querySelectorAll('.search-form').forEach((form) => form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = form.querySelector('input[name="q"]').value;
      go(v, v.trim() === q ? f : 'top', true);
      form.querySelector('input').blur();
    }));
    sTabs.forEach((t) => {
      t.addEventListener('click', () => go(q, t.dataset.f, false));
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const i = (sTabs.indexOf(t) + ((e.key === 'ArrowRight') !== RTL ? 1 : sTabs.length - 1)) % sTabs.length;
        go(q, sTabs[i].dataset.f, false);
        sTabs[i].focus();
      });
    });
    sRes.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-f]');
      if (a) { e.preventDefault(); go(q, a.dataset.f, false); window.scrollTo(0, 0); }
    });
    const fromUrl = () => { const p = new URLSearchParams(location.search); go(p.get('q'), p.get('f'), false); };
    window.addEventListener('popstate', fromUrl);
    fromUrl();
  }
  // PWA: offline-capable service worker, plus an "Install app" menu item when the browser allows it.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  const installBtn = document.querySelector('.nav-install');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installEvt = null;
  if (installBtn && !standalone) {
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvt = e;
      installBtn.hidden = false;
    });
    addEventListener('appinstalled', () => { installBtn.hidden = true; installEvt = null; });
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) installBtn.hidden = false;
    installBtn.addEventListener('click', async () => {
      if (installEvt) {
        installEvt.prompt();
        const { outcome } = await installEvt.userChoice;
        if (outcome === 'accepted') installBtn.hidden = true;
        installEvt = null;
      } else if (ios) {
        openInfo(S('installTitle', 'Install {site}'), S('installIos', 'In Safari, tap the Share button, then "Add to Home Screen".'));
      }
    });
  }
})();