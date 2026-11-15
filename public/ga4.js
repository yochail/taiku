// Google is loaded only after an explicit, persisted choice; Cloudflare tracking is independent.
(() => {
  const consentKey = 'ga4Consent';
  globalThis.TaikuGA4 = {
    create(id, store) {
      const seen = new Set();
      const privacySignal = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';
      const allowed = () => /^G-[A-Z0-9]{4,20}$/.test(id || '')
        && globalThis[`ga-disable-${id}`] !== true && store.get(consentKey, null) === true
        && !store.get('engagementOptOut', false) && !privacySignal();
      let loaded = false;
      const start = () => {
        if (loaded || !allowed() || !/^https?:$/.test(location.protocol)) return;
        loaded = true;
        globalThis.dataLayer = globalThis.dataLayer || [];
        globalThis.gtag = function () { globalThis.dataLayer.push(arguments); };
        gtag('consent', 'default', {
          analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
        });
        gtag('js', new Date());
        gtag('config', id, {
          send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, cookie_domain: 'none',
          page_location: `${location.origin}/`, page_referrer: '', page_title: 'Site',
        });
        const script = document.createElement('script');
        script.async = true;
        script.referrerPolicy = 'no-referrer';
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
        script.onerror = () => console.warn('Google Analytics unavailable');
        document.head.appendChild(script);
      };
      const change = (choice) => {
        if (!choice) globalThis[`ga-disable-${id}`] = true;
        try {
          localStorage.setItem(consentKey, JSON.stringify(choice));
          if (JSON.parse(localStorage.getItem(consentKey)) !== choice) throw new Error('preference not saved');
        } catch {
          document.querySelectorAll('[data-ga4-error]').forEach((error) => { error.hidden = false; });
          return;
        }
        globalThis[`ga-disable-${id}`] = true;
        location.reload();
      };
      if (/^G-[A-Z0-9]{4,20}$/.test(id || '')) {
        const banner = document.querySelector('[data-ga4-consent]');
        if (banner && store.get(consentKey, null) === null && !privacySignal() && !store.get('engagementOptOut', false)) banner.hidden = false;
        document.querySelectorAll('[data-ga4-choice]').forEach((button) => {
          button.addEventListener('click', () => change(button.dataset.ga4Choice === 'accept'));
        });
        const preference = document.querySelector('[data-ga4-preference]');
        if (preference) {
          preference.checked = store.get(consentKey, null) === true;
          preference.addEventListener('change', () => change(preference.checked));
        }
        globalThis.addEventListener('storage', (event) => {
          if (event.key === consentKey || event.key === 'engagementOptOut' || event.key === null) {
            globalThis[`ga-disable-${id}`] = true;
            location.reload();
          }
        });
        start();
      }
      const analytics = {
        allowed,
        track(type, target, active, trusted) {
          if (!allowed() || !loaded || !active || !trusted
            || !['like', 'bookmark', 'follow', 'share', 'poll_vote'].includes(type)
            || typeof target !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(target)) return;
          const key = `${type}:${target}`;
          if (seen.has(key)) return;
          seen.add(key);
          gtag('event', `engagement_${type}`, {
            send_to: id, page_location: `${location.origin}/`, page_referrer: '', page_title: 'Site',
          });
        },
      };
      analytics.trackAcceptedVote = (response, target, trusted, allowedAtClick) => {
        if (response.ok && allowedAtClick) analytics.track('poll_vote', target, true, trusted);
      };
      return analytics;
    },
  };
})();
