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

// 영상을 blob: URL로 재생시키는 대신, 이 가상 경로로 서비스워커가 직접
// IndexedDB에서 꺼내 "진짜" 같은 출처(same-origin) URL로 응답해줌 — iOS
// Safari가 PIP(및 AirPlay)를 blob: URL 영상에서는 거부하는 경우가 있는데
// (예: "The video element does not support the Picture-in-Picture mode"),
// 실제 네트워크 URL처럼 보이는 응답으로 바꾸면 이 제약을 피할 수 있음.
// 덤으로 메인 스레드가 영상을 메모리에 통째로 읽어들일 필요도 없어져서,
// 이전에 겪었던 "큰 영상 재생 시 크래시"/"디코딩 거부" 문제의 근본 원인
// 자체가 사라짐 (둘 다 blob: URL + 메모리 복사 방식이 원인이었음).
const VIDEO_URL_PREFIX = '/webtoon-pwa/__video__/';

function openAppDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('webtoon-db');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function getVideoByEpisodeId(episodeId) {
  return openAppDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const idx = tx.objectStore('videos').index('episodeId');
    const req = idx.get(episodeId);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  }));
}

async function handleVideoRequest(request, episodeId) {
  try {
    const record = await getVideoByEpisodeId(episodeId);
    if (!record || !record.videoData) {
      return new Response('Video not found', { status: 404 });
    }
    const type = record.videoType || 'video/mp4';
    const blob = record.videoData instanceof Blob ? record.videoData : new Blob([record.videoData], { type });
    const size = blob.size;

    // Range 요청 지원 — 이게 없으면 영상 재생 중 구간 이동(seek)이 안 됨.
    // "접미사 범위"(bytes=-500 = 마지막 500바이트)도 별도로 처리해야 함 —
    // 웹 최적화 안 된(moov atom이 파일 끝에 있는) mp4는 플레이어가 파일
    // 구조를 전부 확인할 때 이런 요청으로 끝부분을 먼저 읽어오는 경우가
    // 흔한데, 이전 코드는 이 패턴을 지원 안 해서(앞부분 바이트를 잘못
    // 돌려줌) PIP 같은 더 엄격한 기능에서 실패할 수 있었음
    const range = request.headers.get('range');
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      let start, end;
      if (match && match[1] === '' && match[2] !== '') {
        // 접미사 범위: 마지막 N바이트
        const suffixLength = parseInt(match[2], 10);
        start = Math.max(0, size - suffixLength);
        end = size - 1;
      } else {
        start = match && match[1] ? parseInt(match[1], 10) : 0;
        end = match && match[2] ? parseInt(match[2], 10) : size - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= size) end = size - 1;
      }
      return new Response(blob.slice(start, end + 1, type), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes'
        }
      });
    }

    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    });
  } catch (err) {
    return new Response('Error: ' + ((err && err.message) || err), { status: 500 });
  }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith(VIDEO_URL_PREFIX)) {
    const episodeId = Number(url.pathname.slice(VIDEO_URL_PREFIX.length));
    e.respondWith(handleVideoRequest(e.request, episodeId));
    return;
  }

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
