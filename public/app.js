(() => {
  const root = document.documentElement;
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

  // First-visit welcome: dismiss once, remembered.
  const wx = document.querySelector('.welcome-x');
  if (wx) wx.addEventListener('click', () => {
    root.dataset.welcomed = '1';
    try { localStorage.setItem('welcomed', '1'); } catch (e) {}
  });

  // Gate modal: replying, retaiking, following, logging in are not available yet.
  const modal = document.getElementById('gate-modal');
  const GATES = {
    reply: ["You're not logged in", 'Replying is for members only. The dead talk, you listen (for now).'],
    retaik: ["You're not logged in", 'Retaiks and quotes are for members only.'],
    follow: ["You're not logged in", 'Following is for members only.'],
    login: ['Log in / Sign up is coming soon', "Accounts aren't open yet. Keep scrolling, the arguments are free."],
    signup: ['Sign up is coming soon', "Accounts aren't open yet. Keep scrolling, the arguments are free."],
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
  document.querySelectorAll('[data-like]').forEach(paintLike);
  document.querySelectorAll('[data-bookmark]').forEach(paintMark);

  // Polls: one local vote per poll, results revealed after voting or once the poll has closed.
  const votes = store.get('pollVotes', {});
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const paintPoll = (poll) => {
    const id = poll.dataset.poll;
    const mine = votes[id];
    const left = Date.parse(poll.dataset.ends) - Date.now();
    const closed = !(left > 0);
    const opts = [...poll.querySelectorAll('.poll-opt')];
    const counts = opts.map((o) => Number(o.dataset.votes) + (o.dataset.opt === mine ? 1 : 0));
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
    poll.querySelector('.poll-total').textContent = `${total.toLocaleString('en-US')} votes`;
    const h = Math.floor(left / 3600000);
    poll.querySelector('.poll-state').textContent = closed ? 'Final results' : h >= 24 ? `${plural(Math.floor(h / 24), 'day')} left` : h >= 1 ? `${plural(h, 'hour')} left` : `${plural(Math.max(1, Math.round(left / 60000)), 'minute')} left`;
  };
  document.querySelectorAll('.poll[data-poll]').forEach(paintPoll);

  document.addEventListener('click', (e) => {
    const opt = e.target.closest('.poll-opt');
    if (opt) {
      const poll = opt.closest('.poll');
      if (!opt.disabled && votes[poll.dataset.poll] == null) {
        votes[poll.dataset.poll] = opt.dataset.opt;
        store.set('pollVotes', votes);
        document.querySelectorAll(`.poll[data-poll="${CSS.escape(poll.dataset.poll)}"]`).forEach(paintPoll);
      }
      return;
    }
    const alt = e.target.closest('[data-alt]');
    if (alt) { openInfo('Image description', alt.dataset.alt); return; }
    const like = e.target.closest('[data-like]');
    if (like) {
      const id = like.dataset.like;
      likes.has(id) ? likes.delete(id) : likes.add(id);
      store.set('likes', [...likes]);
      document.querySelectorAll(`[data-like="${CSS.escape(id)}"]`).forEach(paintLike);
      if (likes.has(id)) { like.classList.remove('pop'); void like.offsetWidth; like.classList.add('pop'); }
      return;
    }
    const mark = e.target.closest('[data-bookmark]');
    if (mark) {
      const id = mark.dataset.bookmark;
      marks.has(id) ? marks.delete(id) : marks.add(id);
      store.set('bookmarks', [...marks]);
      document.querySelectorAll(`[data-bookmark="${CSS.escape(id)}"]`).forEach(paintMark);
      toast(marks.has(id) ? 'Added to your Bookmarks' : 'Removed from your Bookmarks');
      return;
    }
    const share = e.target.closest('[data-share]');
    if (share) {
      const u = new URL(share.dataset.share, location.origin).href;
      if (navigator.share) navigator.share({ url: u }).catch(() => {});
      else if (navigator.clipboard) navigator.clipboard.writeText(u).then(() => toast('Copied to clipboard'), () => toast(u));
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
  const now = Date.now();
  document.querySelectorAll('time[data-rel]').forEach((t) => {
    const d = Date.parse(t.getAttribute('datetime'));
    const s = Math.round((now - d) / 1000);
    if (s < 0 || s > 86400 * 6) return;
    t.textContent = s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
    t.title = new Date(d).toLocaleString();
  });
})();
