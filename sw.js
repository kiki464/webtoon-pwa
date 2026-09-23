const CACHE_NAME = 'webtoon-shell-v1';
// App shell paths, compared against request.pathname (query strings ignored).
// No manual version bump needed anymore — network-first below always prefers
// the live file and only falls back to this cache when offline.
const APP_SHELL = [
  '/webtoon-pwa/',
  '/webtoon-pwa/index.html',
  '/webtoon-pwa/app.js',
  '/webtoon-pwa/style.css'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isAppShell = APP_SHELL.includes(url.pathname);

  if (isAppShell) {
    // Network-first: always try to get the latest code; fall back to the
    // cached shell only when offline. This is what makes code updates show
    // up on a normal refresh — no cache-name/version bump required.
    //
    // IMPORTANT: fetch(e.request) still honors the browser's own HTTP cache
    // (a separate layer from the Cache Storage API used above/below) — if
    // GitHub Pages' response for e.g. app.js is still considered "fresh" by
    // that cache, this would silently return stale bytes even though we
    // "tried" the network, and different files can go stale independently
    // (index.html updates while app.js doesn't, etc). Fetching by URL string
    // with cache:'no-store' bypasses that HTTP cache entirely so every file
    // in the app shell is always genuinely re-fetched from the network.
    e.respondWith(
      fetch(url.pathname + url.search, { cache: 'no-store' })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  } else {
    // Everything else (icons, manifest, etc.) rarely changes — cache-first is fine.
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
