(() => {
  const root = document.documentElement;
  const btn = document.querySelector('.theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const dark = root.dataset.theme
        ? root.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      try { localStorage.setItem('theme', root.dataset.theme); } catch (e) {}
    });
  }

  // Whole post card is clickable (except inner links), like X.
  document.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
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
