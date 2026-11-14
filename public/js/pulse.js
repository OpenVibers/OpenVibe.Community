/* OpenVibe.Community's /pulse: the shared feed (openvibe-shared/ov-home.js, OpenVibeHome.feed) — the same
   component the menu's Feed tab draws, on the same Network feed (Community's own /api/v1/feed proxy, which
   forwards the person's token). The page renders the first page itself; this replaces it with the shared feed. */
(function () {
  'use strict';
  var mount = document.getElementById('ov-pulse-feed');
  var H = window.OpenVibeHome;
  if (!mount || !H || typeof H.feed !== 'function') return;

  /** The person's own token: the ov_token cookie is JS-readable here, as it is for the navbar. */
  function token() {
    var m = String(document.cookie || '').match(/(?:^|;\s*)ov_token=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** The rows the page rendered: the wall the shared feed falls back to when the feed does not answer. */
  function seed() {
    var el = document.getElementById('ov-pulse-seed');
    try { return JSON.parse((el && el.textContent) || '[]'); } catch (e) { return []; }
  }

  var api = null;
  var opts = {
    frameBase: '/api/v1',        // Community's feed proxy: the same rows and the same ids as the menu's feed
    token: token(),
    user: null,
    sibling: function (name) { return '/shared/' + name; },
    pulseReady: Promise.resolve({ items: seed() }),
    // The feed's own example searches ("new photos") search this same feed, in place.
    onSearch: function (q) { if (api && typeof api.search === 'function') api.search(q); },
  };

  /** Who the person is: a signed-in reader gets their own feed (and the "Following" chip). */
  function who() {
    return fetch('/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.user) || null; })
      .catch(function () { return null; });
  }

  // The session decides whose feed this is; it never holds the page up.
  var wait = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 1500); });
  Promise.race([who(), wait]).then(function (user) {
    if (user) opts.user = user;
    api = H.feed(mount, opts);
  });
})();
