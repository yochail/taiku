// Counts additions/clicks, not unique people or active balances. No persisted event queue or identifier.
(() => {
  globalThis.TaikuEngagement = {
    create(store) {
      const seen = new Set();
      const optedOut = () => store.get('engagementOptOut', false) === true
        || navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';
      return {
        optedOut,
        track(type, id, active, trusted) {
          if (!trusted || !active || optedOut() || !/^https?:$/.test(location.protocol)
            || !['like', 'bookmark', 'follow', 'share'].includes(type)
            || typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(id)) return;
          const key = `${type}:${id}`;
          if (seen.has(key)) return;
          seen.add(key);
          fetch('/api/engagement', {
            method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, id }),
          }).then((r) => {
            if (!r.ok && r.status !== 503 && r.status !== 429) console.warn('Engagement event rejected');
          }, () => console.warn('Engagement event unavailable'));
        },
      };
    },
  };
})();
