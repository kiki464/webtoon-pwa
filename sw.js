const CACHE_NAME = 'webtoon-v7';
const ASSETS = [
  '/webtoon-pwa/',
  '/webtoon-pwa/index.html',
  '/webtoon-pwa/app.js?v=28',
  '/webtoon-pwa/style.css?v=28'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
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
  const isAppShell = ASSETS.some(a => url.pathname === a || url.pathname.endsWith(a.replace('/webtoon-pwa', '')));
  if (isAppShell) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
