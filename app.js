// ── DB ──────────────────────────────────────────────────────────────────────
// DB_VER 3 only ADDS the 'videos' store below (onupgradeneeded never touches
// existing stores) — bumping this never erases series/episodes/images/tags
// that are already saved in a visitor's browser.
const DB_NAME = 'webtoon-db', DB_VER = 3;
let db;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('series')) {
        const s = d.createObjectStore('series', { keyPath: 'id', autoIncrement: true });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains('episodes')) {
        const ep = d.createObjectStore('episodes', { keyPath: 'id', autoIncrement: true });
        ep.createIndex('seriesId', 'seriesId');
      }
      if (!d.objectStoreNames.contains('images')) {
        const img = d.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
        img.createIndex('episodeId', 'episodeId');
      }
      if (!d.objectStoreNames.contains('tags')) {
        d.createObjectStore('tags', { keyPath: 'id', autoIncrement: true });
      }
      if (!d.objectStoreNames.contains('videos')) {
        const vid = d.createObjectStore('videos', { keyPath: 'id', autoIncrement: true });
        vid.createIndex('episodeId', 'episodeId');
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

function tx(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function dbGetAll(store, index, query) {
  return new Promise((res, rej) => {
    const s = tx(store);
    const req = index ? s.index(index).getAll(query) : s.getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((res, rej) => {
    const req = tx(store).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

function dbAdd(store, data) {
  return new Promise((res, rej) => {
    const req = tx(store, 'readwrite').add(data);
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

function dbPut(store, data) {
  return new Promise((res, rej) => {
    const req = tx(store, 'readwrite').put(data);
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const req = tx(store, 'readwrite').delete(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

// blob 없이 키만 가져옴 — 큰 데이터를 전혀 안 건드리므로 항상 가벼움
function dbGetAllKeys(store) {
  return new Promise((res, rej) => {
    const req = tx(store).getAllKeys();
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

// 저장소 전체 비우기 — getAll() 후 하나씩 delete하는 것보다 훨씬 가볍고,
// 큰 blob들을 메모리에 올릴 필요가 없음
function dbClear(store) {
  return new Promise((res, rej) => {
    const req = tx(store, 'readwrite').clear();
    req.onsuccess = () => res();
    req.onerror = e => rej(e.target.error);
  });
}

function dbDeleteByIndex(store, index, query) {
  return new Promise(async (res, rej) => {
    const items = await dbGetAll(store, index, query);
    const t = db.transaction(store, 'readwrite').objectStore(store);
    let count = items.length;
    if (!count) return res();
    items.forEach(item => {
      const r = t.delete(item.id);
      r.onsuccess = () => { if (--count === 0) res(); };
      r.onerror = e => rej(e.target.error);
    });
  });
}

function readFileAsBlob(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => res(e.target.result);
    reader.onerror = rej;
    reader.readAsArrayBuffer(file);
  });
}

async function storeImages(episodeId, files, onProgress) {
  const sorted = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (let i = 0; i < sorted.length; i++) {
    const buf = await readFileAsBlob(sorted[i]);
    await dbAdd('images', {
      episodeId,
      order: i,
      name: sorted[i].name,
      type: sorted[i].type || 'image/jpeg',
      data: buf
    });
    onProgress && onProgress(i + 1, sorted.length);
  }
}

function bufToUrl(buf, type) {
  const blob = new Blob([buf], { type });
  return URL.createObjectURL(blob);
}

function bufToDataUrl(buf, type) {
  return new Promise(res => {
    const blob = new Blob([buf], { type });
    const reader = new FileReader();
    reader.onload = e => res(e.target.result);
    reader.readAsDataURL(blob);
  });
}

// ── STATE ────────────────────────────────────────────────────────────────────
let state = { screen: 'home', seriesId: null, episodeId: null };
let seriesCache = [];
let episodeCache = [];
let imageCache = [];
let tagsCache = [];
let pendingFiles = null;
let longPressTimer = null;
let activeTagIds = new Set(); // 현재 선택된 태그 필터
let selectedTagIdsForNew = new Set(); // 새 시리즈 만들기에서 선택된 태그

const TAG_COLORS = ['#00d4aa','#7b5ea7','#ff6b6b','#ffd166','#06d6a0','#118ab2','#ef476f','#f77f00'];
function tagColor(id) { return TAG_COLORS[id % TAG_COLORS.length]; }

let currentTab = 'normal'; // 'normal' | 'adult'

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-normal').classList.toggle('active', tab === 'normal');
  document.getElementById('tab-adult').classList.toggle('active', tab === 'adult');
  activeTagIds.clear();
  document.getElementById('search-input').value = '';
  document.getElementById('tag-filter-bar').classList.remove('visible');
  renderHome();
}

// ── ROUTING ──────────────────────────────────────────────────────────────────
function navigate(screen, params = {}) {
  state = { screen, ...params };
  render();
}

// ── RENDER ───────────────────────────────────────────────────────────────────
async function render() {
  const screens = ['home', 'episodes', 'reader'];
  screens.forEach(s => {
    document.getElementById('screen-' + s).classList.toggle('hidden', state.screen !== s);
  });

  const fab = document.getElementById('fab');
  fab.classList.toggle('hidden', state.screen === 'reader');

  if (state.screen === 'home') {
    await renderHome();
  } else if (state.screen === 'episodes') {
    await renderEpisodes();
  } else if (state.screen === 'reader') {
    await renderReader();
  }
}

// 시리즈 커버: 커스텀 표지가 있으면 우선 사용, 없으면 첫 회차의 커버
async function getSeriesCoverUrl(seriesId) {
  const series = await dbGet('series', seriesId);
  if (series?.coverUrl && series.coverUrl.startsWith('data:')) return series.coverUrl;
  const eps = await dbGetAll('episodes', 'seriesId', seriesId);
  if (!eps.length) return null;
  eps.sort((a, b) => a.order - b.order);
  return await getEpisodeCoverUrl(eps[0].id);
}

// 회차의 커버를 IndexedDB에서 직접 가져옴 — 영상 회차는 업로드된 썸네일
// (없으면 시리즈 표지로 대체), 이미지 회차는 첫 번째 이미지를 사용
async function getEpisodeCoverUrl(episodeId) {
  const episode = await dbGet('episodes', episodeId);
  if (episode?.type === 'video') {
    const vids = await dbGetAll('videos', 'episodeId', episodeId);
    if (vids.length && vids[0].thumbData) {
      return bufToUrl(vids[0].thumbData, vids[0].thumbType);
    }
    const series = await dbGet('series', episode.seriesId);
    if (series?.coverUrl && series.coverUrl.startsWith('data:')) return series.coverUrl;
    return null;
  }
  const imgs = await dbGetAll('images', 'episodeId', episodeId);
  if (!imgs.length) return null;
  imgs.sort((a, b) => a.order - b.order);
  return bufToUrl(imgs[0].data, imgs[0].type);
}

let thumbBlobUrls = [];
function revokeThumbs() {
  thumbBlobUrls.forEach(u => URL.revokeObjectURL(u));
  thumbBlobUrls = [];
}

async function renderHome() {
  revokeThumbs();
  const searchEl = document.getElementById('search-input');
  if (searchEl) searchEl.value = '';
  seriesCache = await dbGetAll('series');
  seriesCache = seriesCache.filter(s => currentTab === 'adult' ? s.isAdult === true : s.isAdult !== true);
  seriesCache.sort((a, b) => b.createdAt - a.createdAt);

  const container = document.getElementById('home-content');

  if (!seriesCache.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="emoji">📖</div>
        <h3>아직 웹툰이 없어요</h3>
        <p>+ 버튼을 눌러서<br>첫 번째 시리즈를 만들어 보세요!</p>
        <button class="empty-cta" onclick="openAddSeriesModal()">+ 시리즈 추가</button>
      </div>`;
    return;
  }

  const allEps = await dbGetAll('episodes');
  const epCount = {};
  allEps.forEach(ep => { epCount[ep.seriesId] = (epCount[ep.seriesId] || 0) + 1; });

  await renderTagFilterBar();

  // 플레이스홀더로 먼저 렌더링
  const grid = seriesCache.map(s => {
    const count = epCount[s.id] || 0;
    const tagIds = JSON.stringify(s.tagIds || []);
    return `
      <div class="series-card" data-id="${s.id}" data-tags='${tagIds}'
           onclick="navigate('episodes',{seriesId:${s.id}})"
           oncontextmenu="showCtxMenu(event,'series',${s.id})"
      >
        <div class="cover-empty" id="cover-${s.id}">📚</div>
        <div class="card-info">
          <div class="card-title">${escHtml(s.title)}</div>
          <div class="card-count">${count}화</div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="section-title">전체 시리즈</div>
    <div class="series-grid">${grid}</div>`;

  container.querySelectorAll('.series-card').forEach(card => {
    card.addEventListener('touchstart', e => {
      const id = +card.dataset.id;
      longPressTimer = setTimeout(() => showCtxMenuTouch(e.touches[0], 'series', id), 500);
    }, { passive: true });
    card.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
    card.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
  });

  // 이미지 비동기 로드 후 필터 적용
  for (const s of seriesCache) {
    const url = await getSeriesCoverUrl(s.id);
    if (url) {
      thumbBlobUrls.push(url);
      const el = document.getElementById(`cover-${s.id}`);
      if (el) el.outerHTML = `<img class="cover" src="${url}">`;
    }
  }
  applyFilter();
}

async function renderEpisodes() {
  revokeThumbs();
  const series = await dbGet('series', state.seriesId);
  if (!series) { navigate('home'); return; }

  const header = document.getElementById('ep-header-ui');
  header.innerHTML = `
    <button class="header-back" onclick="navigate('home')">‹</button>
    <span class="header-title">${escHtml(series.title)}</span>
    <button class="header-tag-btn" onclick="openSeriesTagModal()">🏷️ 태그</button>
    <button class="header-action" onclick="openAddEpisodeModal()">+ 추가</button>`;

  episodeCache = await dbGetAll('episodes', 'seriesId', state.seriesId);
  episodeCache.sort((a, b) => a.order - b.order);

  const epItems = episodeCache.length === 0
    ? `<div class="empty-state" style="padding:40px 24px">
        <div class="emoji">🗂️</div>
        <h3>회차가 없어요</h3>
        <p>위의 + 추가를 눌러<br>이미지를 업로드하세요</p>
       </div>`
    : episodeCache.map(ep => {
        const sub = ep.type === 'video' ? '🎥 영상' : `${ep.imageCount || 0}장`;
        return `
          <div class="ep-item" data-id="${ep.id}"
               onclick="navigate('reader',{seriesId:${state.seriesId},episodeId:${ep.id}})"
               oncontextmenu="showCtxMenu(event,'episode',${ep.id})"
          >
            <div class="ep-thumb-empty" id="epthumb-${ep.id}">🖼️</div>
            <div class="ep-info">
              <div class="ep-title">${escHtml(ep.title)}</div>
              <div class="ep-sub">${sub}</div>
            </div>
            <span class="ep-drag-handle" data-ep-id="${ep.id}">☰</span>
          </div>`;
      }).join('');

  // 시리즈 태그 렌더링
  tagsCache = await dbGetAll('tags');
  const seriesTags = (series.tagIds || [])
    .map(id => tagsCache.find(t => t.id === id))
    .filter(Boolean);
  const tagsHtml = seriesTags.length
    ? `<div class="ep-tags">${seriesTags.map(t =>
        `<span class="tag-chip" style="--tc:${tagColor(t.id)}">${escHtml(t.name)}</span>`
      ).join('')}</div>`
    : '';

  const container = document.getElementById('ep-content');
  container.innerHTML = `
    <div class="ep-header-cover-empty" id="series-cover-img">📚</div>
    <div class="ep-meta">
      <h2>${escHtml(series.title)}</h2>
      ${tagsHtml}
      <p style="margin-top:6px">${episodeCache.length}화 등록됨</p>
    </div>
    <div class="ep-list">${epItems}</div>`;

  // 시리즈 커버 비동기 로드
  const coverUrl = await getSeriesCoverUrl(state.seriesId);
  if (coverUrl) {
    thumbBlobUrls.push(coverUrl);
    const el = document.getElementById('series-cover-img');
    if (el) el.outerHTML = `<img class="ep-header-cover" src="${coverUrl}">`;
  }

  // 회차 썸네일 비동기 로드
  for (const ep of episodeCache) {
    const url = await getEpisodeCoverUrl(ep.id);
    if (url) {
      thumbBlobUrls.push(url);
      const el = document.getElementById(`epthumb-${ep.id}`);
      if (el) el.outerHTML = `<img class="ep-thumb" src="${url}">`;
    }
  }

  initEpDragDrop();
}

async function renderReader() {
  const episode = await dbGet('episodes', state.episodeId);
  const series = await dbGet('series', state.seriesId);

  // Load all episodes for prev/next navigation
  episodeCache = await dbGetAll('episodes', 'seriesId', state.seriesId);
  episodeCache.sort((a, b) => a.order - b.order);
  const epIdx = episodeCache.findIndex(e => e.id === state.episodeId);

  // Overlay titles
  document.getElementById('reader-series-title').textContent = series?.title || '';
  document.getElementById('reader-episode-title').textContent = episode?.title || '';

  // Prev/Next buttons
  document.getElementById('btn-prev-ep').disabled = epIdx <= 0;
  document.getElementById('btn-next-ep').disabled = epIdx >= episodeCache.length - 1;

  // Hide overlays initially
  document.getElementById('reader-overlay-top').classList.remove('visible');
  document.getElementById('reader-overlay-bottom').classList.remove('visible');

  const container = document.getElementById('reader-content');
  container.innerHTML = `<div style="text-align:center;padding:40px;color:#666">불러오는 중...</div>`;

  revokeOldUrls();

  if (episode?.type === 'video') {
    const vids = await dbGetAll('videos', 'episodeId', state.episodeId);
    if (!vids.length) {
      container.innerHTML = `<div class="empty-state"><div class="emoji">🎥</div><h3>영상이 없어요</h3></div>`;
      return;
    }
    const v = vids[0];
    const videoUrl = bufToUrl(v.videoData, v.videoType);
    blobUrlsToRevoke.push(videoUrl);
    container.innerHTML = `
      <div class="reader-video-wrap">
        <video src="${videoUrl}" controls playsinline autoplay></video>
      </div>`;
    document.getElementById('screen-reader').scrollTop = 0;
    return;
  }

  imageCache = await dbGetAll('images', 'episodeId', state.episodeId);
  imageCache.sort((a, b) => a.order - b.order);

  if (!imageCache.length) {
    container.innerHTML = `<div class="empty-state"><div class="emoji">🖼️</div><h3>이미지가 없어요</h3></div>`;
    return;
  }

  const imgs = imageCache.map(img => {
    const url = bufToUrl(img.data, img.type);
    img._blobUrl = url;
    blobUrlsToRevoke.push(url);
    return `<img src="${url}" loading="lazy" decoding="async">`;
  }).join('');

  container.innerHTML = `<div class="reader-images">${imgs}</div>`;

  // Scroll to top
  document.getElementById('screen-reader').scrollTop = 0;
}

let overlayVisible = false;
function toggleReaderOverlay() {
  overlayVisible = !overlayVisible;
  document.getElementById('reader-overlay-top').classList.toggle('visible', overlayVisible);
  document.getElementById('reader-overlay-bottom').classList.toggle('visible', overlayVisible);
}

async function navigateEpisode(dir) {
  episodeCache = await dbGetAll('episodes', 'seriesId', state.seriesId);
  episodeCache.sort((a, b) => a.order - b.order);
  const epIdx = episodeCache.findIndex(e => e.id === state.episodeId);
  const next = episodeCache[epIdx + dir];
  if (!next) return;
  state.episodeId = next.id;
  overlayVisible = false;
  await renderReader();
}

let blobUrlsToRevoke = [];
function revokeOldUrls() {
  blobUrlsToRevoke.forEach(u => URL.revokeObjectURL(u));
  blobUrlsToRevoke = [];
}

// ── MODALS ───────────────────────────────────────────────────────────────────
async function openAddSeriesModal() {
  pendingFiles = null;
  selectedTagIdsForNew = new Set();
  document.getElementById('series-name-input').value = '';
  document.getElementById('series-file-count').textContent = '';
  document.getElementById('series-file-input').value = '';
  await refreshSeriesTagSelector();
  showModal('modal-add-series');
}

function openAddEpisodeModal() {
  pendingFiles = null;
  document.getElementById('ep-name-input').value = '';
  document.getElementById('ep-file-count').textContent = '';
  document.getElementById('ep-file-input').value = '';
  showModal('modal-add-episode');
}

// ── VIDEO UPLOAD (영상 파일 + 썸네일 사진을 그대로 저장) ─────────────────────
let pendingVideoFile = null;
let pendingThumbFile = null;

function openVideoUploadModal() {
  hideModal('modal-add-episode');
  pendingVideoFile = null;
  pendingThumbFile = null;
  document.getElementById('video-ep-name-input').value = '';
  document.getElementById('video-upload-file-count').textContent = '';
  document.getElementById('video-upload-thumb-count').textContent = '';
  document.getElementById('video-upload-file-input').value = '';
  document.getElementById('video-upload-thumb-input').value = '';
  showModal('modal-add-video');
}

function pickVideoUploadFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  pendingVideoFile = file;
  document.getElementById('video-upload-file-count').textContent = `🎬 ${file.name}`;
}

function pickVideoUploadThumb(e) {
  const file = e.target.files[0];
  if (!file) return;
  pendingThumbFile = file;
  document.getElementById('video-upload-thumb-count').textContent = `🖼️ ${file.name}`;
}

async function saveVideoEpisode() {
  const title = document.getElementById('video-ep-name-input').value.trim();
  if (!title) { alert('회차 이름을 입력해주세요'); return; }
  if (!pendingVideoFile) { alert('영상을 선택해주세요'); return; }

  showProgress();
  setProgress(20);

  const order = episodeCache.length;
  const epId = await dbAdd('episodes', {
    seriesId: state.seriesId, title, order, type: 'video', thumbUrl: null, imageCount: 0, createdAt: Date.now()
  });

  const videoBuf = await readFileAsBlob(pendingVideoFile);
  setProgress(55);

  // 썸네일은 선택 사항 — 안 고르면 아예 저장 안 하고, getEpisodeCoverUrl이
  // 표시할 때 시리즈 표지로 대체해서 보여줌
  let thumbBuf = null, thumbType = null;
  if (pendingThumbFile) {
    thumbBuf = await readFileAsBlob(pendingThumbFile);
    thumbType = pendingThumbFile.type || 'image/jpeg';
  }
  setProgress(75);

  await dbAdd('videos', {
    episodeId: epId,
    videoData: videoBuf, videoType: pendingVideoFile.type || 'video/mp4', videoName: pendingVideoFile.name,
    thumbData: thumbBuf, thumbType: thumbType
  });

  // 썸네일을 직접 골랐고, 시리즈 표지가 아직 없으면 이걸로 채워줌
  if (thumbBuf) {
    const thumbDataUrl = await bufToDataUrl(thumbBuf, thumbType);
    const series = await dbGet('series', state.seriesId);
    if (!series.coverUrl) {
      await dbPut('series', { ...series, coverUrl: thumbDataUrl });
    }
  }

  pendingVideoFile = null;
  pendingThumbFile = null;
  hideProgress();
  hideModal('modal-add-video');
  await renderEpisodes();
}

function showModal(id) {
  document.getElementById(id).classList.add('show');
}

function hideModal(id) {
  document.getElementById(id).classList.remove('show');
}

// ── FAB MENU ──────────────────────────────────────────────────────────────────
let fabMenuOpen = false;
function toggleFabMenu() {
  fabMenuOpen = !fabMenuOpen;
  document.getElementById('fab-menu').classList.toggle('hidden', !fabMenuOpen);
  document.getElementById('fab-backdrop').classList.toggle('hidden', !fabMenuOpen);
  document.getElementById('fab').style.transform = fabMenuOpen ? 'rotate(45deg)' : '';
}
function closeFabMenu() {
  fabMenuOpen = false;
  document.getElementById('fab-menu').classList.add('hidden');
  document.getElementById('fab-backdrop').classList.add('hidden');
  document.getElementById('fab').style.transform = '';
}
function fabMenuSelect(type) {
  closeFabMenu();
  if (type === 'series') openAddSeriesModal();
  else if (type === 'tag') openAddTagModal();
  else if (type === 'tag-delete') openDeleteTagModal();
}

// ── SERIES TAG EDIT ──────────────────────────────────────────────────────────
async function openSeriesTagModal() {
  tagsCache = await dbGetAll('tags');
  const series = await dbGet('series', state.seriesId);
  const currentTagIds = series.tagIds || [];

  const wrap = document.getElementById('series-tag-edit-list');
  if (!tagsCache.length) {
    wrap.innerHTML = '<p style="color:var(--text2);font-size:14px;text-align:center;padding:12px">태그가 없어요.<br>홈의 + 버튼에서 태그를 먼저 만들어 주세요.</p>';
  } else {
    wrap.innerHTML = tagsCache.map(t => {
      const has = currentTagIds.includes(t.id);
      return `<button class="tag-chip${has ? ' active' : ''}" style="--tc:${tagColor(t.id)}"
        data-id="${t.id}" data-has="${has}" onclick="toggleSeriesTag(${t.id})">${escHtml(t.name)}</button>`;
    }).join('');
  }
  showModal('modal-series-tags');
}

async function toggleSeriesTag(id) {
  const series = await dbGet('series', state.seriesId);
  const tagIds = series.tagIds || [];
  if (tagIds.includes(id)) {
    await showConfirm('이미 추가된 태그예요', '이 태그를 시리즈에서 제거할까요?', '제거', 'background:var(--danger);color:#fff');
    const updated = tagIds.filter(t => t !== id);
    await dbPut('series', { ...series, tagIds: updated });
  } else {
    await dbPut('series', { ...series, tagIds: [...tagIds, id] });
  }
  await openSeriesTagModal();
  await renderEpisodes();
}

// ── TAG DELETE ────────────────────────────────────────────────────────────────
let selectedDeleteTagIds = new Set();

async function openDeleteTagModal() {
  tagsCache = await dbGetAll('tags');
  selectedDeleteTagIds = new Set();
  renderDeleteTagList();
  showModal('modal-delete-tags');
}

function renderDeleteTagList() {
  const wrap = document.getElementById('tag-delete-list');
  if (!tagsCache.length) {
    wrap.innerHTML = '<p style="color:var(--text2);font-size:14px;text-align:center;padding:12px">태그가 없어요.</p>';
    document.getElementById('tag-delete-confirm-btn').style.display = 'none';
    return;
  }
  wrap.innerHTML = tagsCache.map(t => {
    const sel = selectedDeleteTagIds.has(t.id);
    return `<div class="tag-delete-row${sel ? ' selected' : ''}" onclick="toggleDeleteTag(${t.id})">
      <span class="tag-chip" style="--tc:${tagColor(t.id)}">${escHtml(t.name)}</span>
      <span class="tag-delete-check">${sel ? '✓' : ''}</span>
    </div>`;
  }).join('');
  document.getElementById('tag-delete-confirm-btn').style.display = selectedDeleteTagIds.size > 0 ? '' : 'none';
}

function toggleDeleteTag(id) {
  if (selectedDeleteTagIds.has(id)) selectedDeleteTagIds.delete(id);
  else selectedDeleteTagIds.add(id);
  renderDeleteTagList();
}

async function confirmDeleteTags() {
  if (!selectedDeleteTagIds.size) return;
  const names = [...selectedDeleteTagIds].map(id => tagsCache.find(t => t.id === id)?.name).filter(Boolean).join(', ');
  const ok = await showConfirm('태그 삭제', `"${names}" 태그를 삭제할까요?\n연결된 시리즈에서도 제거돼요.`);
  if (!ok) { await openDeleteTagModal(); return; }
  for (const id of selectedDeleteTagIds) {
    await dbDelete('tags', id);
    const allSeries = await dbGetAll('series');
    for (const s of allSeries) {
      if ((s.tagIds || []).includes(id)) {
        await dbPut('series', { ...s, tagIds: s.tagIds.filter(t => t !== id) });
      }
    }
  }
  hideModal('modal-delete-tags');
}

// ── TAGS ─────────────────────────────────────────────────────────────────────
function openAddTagModal() {
  document.getElementById('new-tag-input').value = '';
  showModal('modal-add-tag');
  setTimeout(() => document.getElementById('new-tag-input').focus(), 300);
}

async function saveNewTag() {
  const name = document.getElementById('new-tag-input').value.trim();
  if (!name) return;
  const existing = await dbGetAll('tags');
  if (existing.find(t => t.name.trim() === name)) {
    hideModal('modal-add-tag');
    await showConfirm('같은 태그가 있어요', `"${name}" 태그가 이미 있어요.\n다른 이름을 사용해 주세요.`, '확인', 'background:var(--accent);color:#000');
    showModal('modal-add-tag');
    return;
  }
  await dbAdd('tags', { name, createdAt: Date.now() });
  hideModal('modal-add-tag');
  await refreshSeriesTagSelector();
}

async function refreshSeriesTagSelector() {
  tagsCache = await dbGetAll('tags');
  const wrap = document.getElementById('series-tag-selector');
  if (!tagsCache.length) { wrap.innerHTML = '<span style="color:var(--text2);font-size:13px">태그 없음 — 오른쪽 상단에서 추가</span>'; return; }
  wrap.innerHTML = tagsCache.map(t =>
    `<button class="tag-chip${selectedTagIdsForNew.has(t.id) ? ' active' : ''}" data-id="${t.id}"
      style="--tc:${tagColor(t.id)}" onclick="toggleNewSeriesTag(${t.id})">${escHtml(t.name)}</button>`
  ).join('');
}

function toggleNewSeriesTag(id) {
  if (selectedTagIdsForNew.has(id)) selectedTagIdsForNew.delete(id);
  else selectedTagIdsForNew.add(id);
  document.querySelectorAll('#series-tag-selector .tag-chip').forEach(btn => {
    btn.classList.toggle('active', selectedTagIdsForNew.has(+btn.dataset.id));
  });
}

// ── SAVE SERIES ──────────────────────────────────────────────────────────────
async function saveSeries() {
  const title = document.getElementById('series-name-input').value.trim();
  if (!title) { alert('시리즈 이름을 입력해주세요'); return; }

  const existing = await dbGetAll('series');
  if (existing.find(s => s.title.trim() === title)) {
    hideModal('modal-add-series');
    await showConfirm('같은 이름이 있어요', `"${title}" 이름의 시리즈가 이미 있어요.\n다른 이름을 사용해 주세요.`, '확인', 'background:var(--accent);color:#000');
    showModal('modal-add-series');
    return;
  }

  const id = await dbAdd('series', { title, coverUrl: null, tagIds: [...selectedTagIdsForNew], createdAt: Date.now() });

  // If files were picked, auto-create first episode
  if (pendingFiles && pendingFiles.length > 0) {
    const epId = await dbAdd('episodes', {
      seriesId: id, title: '1화', order: 0, thumbUrl: null, imageCount: 0, createdAt: Date.now()
    });
    await importImages(epId, pendingFiles);
    // Set cover from first image
    const imgs = await dbGetAll('images', 'episodeId', epId);
    if (imgs.length) {
      const dataUrl = await bufToDataUrl(imgs[0].data, imgs[0].type);
      await dbPut('series', { ...(await dbGet('series', id)), coverUrl: dataUrl });
      const ep = await dbGet('episodes', epId);
      await dbPut('episodes', { ...ep, thumbUrl: dataUrl, imageCount: imgs.length });
    }
  }

  hideModal('modal-add-series');
  navigate('episodes', { seriesId: id });
}

async function saveEpisode() {
  const title = document.getElementById('ep-name-input').value.trim();
  if (!title) { alert('회차 이름을 입력해주세요'); return; }
  if (!pendingFiles || !pendingFiles.length) { alert('이미지를 선택해주세요'); return; }

  const order = episodeCache.length;
  const epId = await dbAdd('episodes', {
    seriesId: state.seriesId, title, order, thumbUrl: null, imageCount: 0, createdAt: Date.now()
  });

  showProgress();
  await importImages(epId, pendingFiles, (cur, total) => setProgress(cur / total * 100));
  hideProgress();

  const imgs = await dbGetAll('images', 'episodeId', epId);
  if (imgs.length) {
    const thumbUrl = await bufToDataUrl(imgs[0].data, imgs[0].type);
    await dbPut('episodes', { ...(await dbGet('episodes', epId)), thumbUrl, imageCount: imgs.length });

    // Set series cover if not set
    const series = await dbGet('series', state.seriesId);
    if (!series.coverUrl) {
      await dbPut('series', { ...series, coverUrl: thumbUrl });
    }
  }

  hideModal('modal-add-episode');
  await renderEpisodes();
}

async function importImages(epId, files, onProgress) {
  const sorted = Array.from(files).filter(f => f.type.startsWith('image/')).sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })
  );
  for (let i = 0; i < sorted.length; i++) {
    const buf = await readFileAsBlob(sorted[i]);
    await dbAdd('images', { episodeId: epId, order: i, name: sorted[i].name, type: sorted[i].type, data: buf });
    onProgress && onProgress(i + 1, sorted.length);
  }
}

function showProgress() {
  document.getElementById('progress-bar').classList.remove('hidden');
}
function hideProgress() {
  document.getElementById('progress-bar').classList.add('hidden');
  setProgress(0);
}
function setProgress(pct) {
  document.getElementById('progress-fill').style.width = pct + '%';
}

// ── FILE PICK ─────────────────────────────────────────────────────────────────
function pickSeriesFiles(e) {
  const files = e.target.files;
  if (!files || !files.length) return;
  pendingFiles = files;
  const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
  document.getElementById('series-file-count').textContent = `📷 ${imgs.length}장 선택됨`;
}

function pickEpFiles(e) {
  const files = e.target.files;
  if (!files || !files.length) return;
  pendingFiles = files;
  const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
  document.getElementById('ep-file-count').textContent = `📷 ${imgs.length}장 선택됨`;
}

// ── COVER EDITOR ─────────────────────────────────────────────────────────────
let coverEditor = {
  seriesId: null, img: null,
  x: 0, y: 0, scale: 1,
  frameW: 0, frameH: 0, frameX: 0, frameY: 0,
  dragging: false, lastTX: 0, lastTY: 0,
  pinching: false, lastDist: 0
};

function ctxChangeCover() {
  const target = ctxTarget;
  hideCtxMenu();
  if (!target || target.type !== 'series') return;
  coverEditor.seriesId = target.id;
  document.getElementById('cover-file-input').click();
}

function onCoverFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    coverEditor.img = img;
    openCoverEditor();
  };
  img.src = url;
}

function openCoverEditor() {
  const editor = document.getElementById('cover-editor');
  const body = document.getElementById('cover-editor-body');
  editor.classList.add('show');

  // 캔버스 크기를 body에 맞춤
  requestAnimationFrame(() => {
    const bw = body.clientWidth, bh = body.clientHeight;
    const canvas = document.getElementById('cover-canvas');
    canvas.width = bw; canvas.height = bh;

    // 3:4 프레임 크기 계산
    const margin = 40;
    const frameW = Math.min(bw - margin * 2, bh * 0.55);
    const frameH = frameW * 4 / 3;
    const frameX = (bw - frameW) / 2;
    const frameY = (bh - frameH) / 2;

    coverEditor.frameW = frameW; coverEditor.frameH = frameH;
    coverEditor.frameX = frameX; coverEditor.frameY = frameY;

    // 프레임 div 위치
    const frame = document.getElementById('cover-frame');
    frame.style.left = frameX + 'px'; frame.style.top = frameY + 'px';
    frame.style.width = frameW + 'px'; frame.style.height = frameH + 'px';

    // 이미지 초기 위치: 프레임을 꽉 채우도록
    const img = coverEditor.img;
    const scaleW = frameW / img.naturalWidth;
    const scaleH = frameH / img.naturalHeight;
    coverEditor.scale = Math.max(scaleW, scaleH);
    coverEditor.x = bw / 2;
    coverEditor.y = bh / 2;

    drawCoverCanvas();
    attachCoverEditorEvents();
  });
}

function closeCoverEditor() {
  document.getElementById('cover-editor').classList.remove('show');
  coverEditor.img = null;
  detachCoverEditorEvents();
}

function drawCoverCanvas() {
  const canvas = document.getElementById('cover-canvas');
  const ctx = canvas.getContext('2d');
  const { img, x, y, scale } = coverEditor;
  const w = canvas.width, h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);

  if (!img) return;
  const iw = img.naturalWidth * scale;
  const ih = img.naturalHeight * scale;
  ctx.drawImage(img, x - iw / 2, y - ih / 2, iw, ih);
}

async function saveCoverEdit() {
  const { img, x, y, scale, frameX, frameY, frameW, frameH } = coverEditor;
  if (!img) return;

  // 오프스크린 캔버스에 크롭 영역 렌더링
  const out = document.createElement('canvas');
  out.width = frameW * 2; out.height = frameH * 2;
  const ctx = out.getContext('2d');

  const ox = (x - frameX) * 2;
  const oy = (y - frameY) * 2;
  const iw = img.naturalWidth * scale * 2;
  const ih = img.naturalHeight * scale * 2;
  ctx.drawImage(img, ox - iw / 2, oy - ih / 2, iw, ih);

  const dataUrl = out.toDataURL('image/jpeg', 0.85);
  const series = await dbGet('series', coverEditor.seriesId);
  await dbPut('series', { ...series, coverUrl: dataUrl });

  closeCoverEditor();
  if (state.screen === 'home') await renderHome();
  else if (state.screen === 'episodes') await renderEpisodes();
}

// 터치/마우스 이벤트
function attachCoverEditorEvents() {
  const body = document.getElementById('cover-editor-body');
  body.addEventListener('touchstart', onCoverTouchStart, { passive: false });
  body.addEventListener('touchmove', onCoverTouchMove, { passive: false });
  body.addEventListener('touchend', onCoverTouchEnd, { passive: false });
  body.addEventListener('mousedown', onCoverMouseDown);
  body.addEventListener('mousemove', onCoverMouseMove);
  body.addEventListener('mouseup', onCoverMouseUp);
  body.addEventListener('wheel', onCoverWheel, { passive: false });
}
function detachCoverEditorEvents() {
  const body = document.getElementById('cover-editor-body');
  body.removeEventListener('touchstart', onCoverTouchStart);
  body.removeEventListener('touchmove', onCoverTouchMove);
  body.removeEventListener('touchend', onCoverTouchEnd);
  body.removeEventListener('mousedown', onCoverMouseDown);
  body.removeEventListener('mousemove', onCoverMouseMove);
  body.removeEventListener('mouseup', onCoverMouseUp);
  body.removeEventListener('wheel', onCoverWheel);
}

function getTouchDist(t) {
  const dx = t[0].clientX - t[1].clientX;
  const dy = t[0].clientY - t[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}
function getTouchCenter(t) {
  return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
}

function onCoverTouchStart(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    coverEditor.dragging = true;
    coverEditor.pinching = false;
    coverEditor.lastTX = e.touches[0].clientX;
    coverEditor.lastTY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    coverEditor.pinching = true;
    coverEditor.dragging = false;
    coverEditor.lastDist = getTouchDist(e.touches);
    const c = getTouchCenter(e.touches);
    coverEditor.lastTX = c.x; coverEditor.lastTY = c.y;
  }
}
function onCoverTouchMove(e) {
  e.preventDefault();
  if (e.touches.length === 2 && coverEditor.pinching) {
    const dist = getTouchDist(e.touches);
    const ratio = dist / coverEditor.lastDist;
    coverEditor.scale = Math.max(0.2, coverEditor.scale * ratio);
    coverEditor.lastDist = dist;
    const c = getTouchCenter(e.touches);
    coverEditor.x += c.x - coverEditor.lastTX;
    coverEditor.y += c.y - coverEditor.lastTY;
    coverEditor.lastTX = c.x; coverEditor.lastTY = c.y;
  } else if (e.touches.length === 1 && coverEditor.dragging) {
    coverEditor.x += e.touches[0].clientX - coverEditor.lastTX;
    coverEditor.y += e.touches[0].clientY - coverEditor.lastTY;
    coverEditor.lastTX = e.touches[0].clientX;
    coverEditor.lastTY = e.touches[0].clientY;
  }
  drawCoverCanvas();
}
function onCoverTouchEnd(e) {
  if (e.touches.length === 0) { coverEditor.dragging = false; coverEditor.pinching = false; }
}

function onCoverMouseDown(e) { coverEditor.dragging = true; coverEditor.lastTX = e.clientX; coverEditor.lastTY = e.clientY; }
function onCoverMouseMove(e) {
  if (!coverEditor.dragging) return;
  coverEditor.x += e.clientX - coverEditor.lastTX;
  coverEditor.y += e.clientY - coverEditor.lastTY;
  coverEditor.lastTX = e.clientX; coverEditor.lastTY = e.clientY;
  drawCoverCanvas();
}
function onCoverMouseUp() { coverEditor.dragging = false; }
function onCoverWheel(e) {
  e.preventDefault();
  coverEditor.scale = Math.max(0.2, coverEditor.scale * (e.deltaY < 0 ? 1.1 : 0.9));
  drawCoverCanvas();
}

// ── EPISODE DRAG & DROP ───────────────────────────────────────────────────────
let drag = {
  el: null, ghost: null, id: null,
  startY: 0, offsetY: 0,
  fromIdx: 0, toIdx: 0,
  items: [], rects: []
};

function initEpDragDrop() {
  const list = document.querySelector('.ep-list');
  if (!list) return;

  // 꾹 누르기 → 컨텍스트 메뉴 (이름변경/삭제)
  list.querySelectorAll('.ep-item').forEach((item, idx) => {
    const id = +item.dataset.id;
    item.addEventListener('touchstart', e => {
      if (e.target.closest('.ep-drag-handle')) return; // 핸들은 별도 처리
      longPressTimer = setTimeout(() => showCtxMenuTouch(e.touches[0], 'episode', id), 500);
    }, { passive: true });
    item.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
    item.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
    item.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e, 'episode', id); });
  });

  // 핸들 터치 → 드래그 순서 변경
  list.querySelectorAll('.ep-drag-handle').forEach((handle, idx) => {
    handle.addEventListener('touchstart', e => {
      e.stopPropagation();
      const item = handle.closest('.ep-item');
      const touch = e.touches[0];
      drag.id = +handle.dataset.epId;
      drag.el = item;
      drag.fromIdx = idx;
      drag.toIdx = idx;
      startDrag(touch);
    }, { passive: true });

    handle.addEventListener('touchmove', e => {
      if (drag.ghost) {
        e.preventDefault();
        moveDrag(e.touches[0]);
      }
    }, { passive: false });

    handle.addEventListener('touchend', () => {
      if (drag.ghost) endDrag();
    }, { passive: true });
  });
}

function startDrag(touch) {
  const item = drag.el;
  if (!item) return;

  // 진동 피드백
  if (navigator.vibrate) navigator.vibrate(30);

  const list = document.querySelector('.ep-list');
  drag.items = [...list.querySelectorAll('.ep-item')];
  drag.rects = drag.items.map(el => el.getBoundingClientRect());

  // 고스트 생성
  const rect = item.getBoundingClientRect();
  drag.offsetY = touch.clientY - rect.top;

  const ghost = item.cloneNode(true);
  ghost.style.cssText = `
    position:fixed; left:${rect.left}px; top:${rect.top}px;
    width:${rect.width}px; z-index:500; pointer-events:none;
    opacity:0.92; transform:scale(1.03);
    box-shadow:0 8px 32px rgba(0,0,0,.5); border-radius:12px;
    transition:none;
  `;
  document.body.appendChild(ghost);
  drag.ghost = ghost;

  item.style.opacity = '0.3';
}

function moveDrag(touch) {
  if (!drag.ghost) return;
  const y = touch.clientY - drag.offsetY;
  drag.ghost.style.top = y + 'px';

  // 어느 위치에 삽입할지 계산
  const centerY = touch.clientY;
  let newIdx = drag.fromIdx;
  drag.rects.forEach((rect, i) => {
    if (i !== drag.fromIdx && centerY > rect.top + rect.height * 0.5) {
      newIdx = i;
    }
  });
  drag.toIdx = newIdx;

  // 시각적 인디케이터
  drag.items.forEach((el, i) => {
    el.style.borderTop = i === drag.toIdx && drag.toIdx !== drag.fromIdx
      ? '2px solid var(--accent)' : '';
  });
}

async function endDrag() {
  const ghost = drag.ghost;
  if (!ghost) return;

  ghost.remove();
  drag.ghost = null;

  if (drag.el) {
    drag.el.style.opacity = '';
  }
  drag.items.forEach(el => el.style.borderTop = '');

  if (drag.fromIdx !== drag.toIdx) {
    // 순서 저장
    const reordered = [...episodeCache];
    const [moved] = reordered.splice(drag.fromIdx, 1);
    reordered.splice(drag.toIdx, 0, moved);
    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i].order !== i) {
        await dbPut('episodes', { ...reordered[i], order: i });
      }
    }
    await renderEpisodes();
  }

  drag.el = null;
  drag.id = null;
}

// ── CONTEXT MENU ──────────────────────────────────────────────────────────────
let ctxTarget = null;

function showCtxMenu(e, type, id) {
  e.preventDefault();
  showCtxAt(e.clientX, e.clientY, type, id);
}

function showCtxMenuTouch(touch, type, id) {
  showCtxAt(touch.clientX, touch.clientY, type, id);
}

function showCtxAt(x, y, type, id) {
  ctxTarget = { type, id };
  const menu = document.getElementById('ctx-menu');
  menu.classList.add('show');

  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 180, mh = 100;
  const left = Math.min(x, vw - mw - 8);
  const top = Math.min(y, vh - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  document.getElementById('ctx-cover').style.display = type === 'series' ? 'flex' : 'none';
  document.getElementById('ctx-adult-toggle').style.display = type === 'series' ? 'flex' : 'none';
  document.getElementById('ctx-rename').style.display = 'flex';
  document.getElementById('ctx-delete').style.display = 'flex';

  // 성인 토글 버튼 텍스트 업데이트
  if (type === 'series') {
    const s = seriesCache.find(s => s.id === id);
    const isAdult = s?.isAdult === true;
    document.getElementById('ctx-adult-toggle').textContent = isAdult ? '✅ 일반으로 설정' : '🔞 성인으로 설정';
  }
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('show');
  ctxTarget = null;
}

async function ctxRename() {
  const target = ctxTarget;
  hideCtxMenu();
  if (!target) return;
  const { type, id } = target;
  const label = type === 'series' ? '시리즈 이름' : '회차 이름';
  const current = type === 'series'
    ? seriesCache.find(s => s.id === id)?.title
    : episodeCache.find(e => e.id === id)?.title;

  const name = await showRename(label, current || '');
  if (!name || !name.trim()) return;

  const store = type === 'series' ? 'series' : 'episodes';
  const item = await dbGet(store, id);
  await dbPut(store, { ...item, title: name.trim() });
  render();
}

async function ctxToggleAdult() {
  const target = ctxTarget;
  hideCtxMenu();
  if (!target || target.type !== 'series') return;
  const series = await dbGet('series', target.id);
  await dbPut('series', { ...series, isAdult: !series.isAdult });
  await renderHome();
}

async function ctxDelete() {
  const target = ctxTarget;
  hideCtxMenu();
  if (!target) return;
  const { type, id } = target;
  const label = type === 'series' ? '이 시리즈' : '이 회차';
  const ok = await showConfirm('삭제할까요?', `${label}를 삭제하면 이미지도 모두 삭제됩니다.`);
  if (!ok) return;

  if (type === 'series') {
    // delete all episodes and their images/videos
    const eps = await dbGetAll('episodes', 'seriesId', id);
    for (const ep of eps) {
      await dbDeleteByIndex('images', 'episodeId', ep.id);
      await dbDeleteByIndex('videos', 'episodeId', ep.id);
    }
    await dbDeleteByIndex('episodes', 'seriesId', id);
    await dbDelete('series', id);
    navigate('home');
  } else {
    await dbDeleteByIndex('images', 'episodeId', id);
    await dbDeleteByIndex('videos', 'episodeId', id);
    await dbDelete('episodes', id);
    await renderEpisodes();
  }
}

// ── CUSTOM DIALOGS ────────────────────────────────────────────────────────────
let _confirmResolve = null;
function showConfirm(title, msg, okLabel = '삭제', okStyle = 'background:var(--danger);color:#fff') {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent = msg;
  const btn = document.getElementById('confirm-ok-btn');
  btn.textContent = okLabel;
  btn.style.cssText = okStyle;
  showModal('modal-confirm');
  return new Promise(res => { _confirmResolve = res; });
}
function confirmResolve(val) {
  hideModal('modal-confirm');
  if (_confirmResolve) { _confirmResolve(val); _confirmResolve = null; }
}

let _renameResolve = null;
function showRename(label, current) {
  document.getElementById('rename-label').textContent = label;
  document.getElementById('rename-input').value = current || '';
  showModal('modal-rename');
  setTimeout(() => document.getElementById('rename-input').focus(), 300);
  return new Promise(res => { _renameResolve = res; });
}
function renameResolve(val) {
  hideModal('modal-rename');
  if (_renameResolve) { _renameResolve(val); _renameResolve = null; }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── SEARCH & TAG FILTER ──────────────────────────────────────────────────────
function normalize(str) { return str.replace(/\s+/g, '').toLowerCase(); }

function applyFilter() {
  const q = normalize(document.getElementById('search-input')?.value || '');
  document.querySelectorAll('.series-card').forEach(card => {
    const titleMatch = !q || normalize(card.querySelector('.card-title')?.textContent || '').includes(q);
    let tagMatch = true;
    if (activeTagIds.size > 0) {
      const cardTags = JSON.parse(card.dataset.tags || '[]');
      tagMatch = [...activeTagIds].every(tid => cardTags.includes(tid));
    }
    card.style.display = (titleMatch && tagMatch) ? '' : 'none';
  });
}

function onSearch() { applyFilter(); }

function onSearchFocus() {
  document.getElementById('tag-filter-bar').classList.add('visible');
}

function toggleTagFilter(id) {
  if (activeTagIds.has(id)) activeTagIds.delete(id);
  else activeTagIds.add(id);
  // 버튼 active 상태 업데이트
  document.querySelectorAll('.tag-filter-btn').forEach(btn => {
    const tid = +btn.dataset.id;
    btn.classList.toggle('active', activeTagIds.has(tid));
  });
  applyFilter();
}

function goHomeReset() {
  activeTagIds.clear();
  currentTab = 'normal';
  document.getElementById('tab-normal')?.classList.add('active');
  document.getElementById('tab-adult')?.classList.remove('active');
  navigate('home');
}

async function renderTagFilterBar() {
  tagsCache = await dbGetAll('tags');
  const bar = document.getElementById('tag-filter-bar');
  // 태그 필터는 검색창 포커스 시에만 보임 — 렌더 시 항상 숨김
  bar.classList.remove('visible');
  if (!tagsCache.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = tagsCache.map(t =>
    `<button class="tag-filter-btn${activeTagIds.has(t.id) ? ' active' : ''}" data-id="${t.id}"
      style="--tc:${tagColor(t.id)}" onclick="toggleTagFilter(${t.id})">${escHtml(t.name)}</button>`
  ).join('');
  // 활성 태그가 있으면 항상 보이게
  if (activeTagIds.size > 0) bar.classList.add('visible');
}

// ── VIDEO MODE ────────────────────────────────────────────────────────────────
let videoFrames = []; // Array of {blob, url} | null (deleted)
let videoFile = null;

// Sensitivity thresholds: higher = extract more cuts
const SENS_THRESHOLDS = [0.93, 0.88, 0.80]; // low / medium / high

function openVideoMode() {
  hideModal('modal-add-episode');
  document.getElementById('video-file-input').click();
}

function onVideoFileSelected(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) { openAddEpisodeModal(); return; }
  videoFile = file;
  videoFrames = [];
  document.getElementById('video-frames-grid').innerHTML = '';
  document.getElementById('video-setup-area').classList.remove('hidden');
  document.getElementById('video-frames-area').classList.add('hidden');
  document.getElementById('video-status').textContent = '설정 후 시작';
  document.getElementById('video-save-btn').disabled = true;
  document.getElementById('video-save-btn').textContent = '저장';
  document.getElementById('video-mode').classList.remove('hidden');
}

function updateSensLabel() {
  const v = parseInt(document.getElementById('sensitivity-input').value);
  document.getElementById('sensitivity-val').textContent = ['낮음','보통','높음'][v];
}

async function startVideoExtraction() {
  if (!videoFile) return;
  const file = videoFile;

  document.getElementById('video-setup-area').classList.add('hidden');
  document.getElementById('video-frames-area').classList.remove('hidden');
  document.getElementById('video-frames-grid').innerHTML = '';
  document.getElementById('video-status').textContent = '영상 불러오는 중...';
  document.getElementById('video-save-btn').disabled = true;
  showProgress();

  const cropTop = parseInt(document.getElementById('crop-top-input').value) || 0;
  const cropBottom = parseInt(document.getElementById('crop-bottom-input').value) || 0;
  const sensIdx = parseInt(document.getElementById('sensitivity-input').value);
  const threshold = SENS_THRESHOLDS[sensIdx];

  try {
    await doExtractFrames(file, cropTop, cropBottom, threshold);
  } catch (err) {
    hideProgress();
    document.getElementById('video-status').textContent = '오류: ' + (err.message || err);
  }
}

function seekTo(video, time) {
  return new Promise(res => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); res(); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

async function doExtractFrames(file, cropTop, cropBottom, threshold) {
  const objUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = objUrl;

  await new Promise((res, rej) => {
    video.onloadedmetadata = res;
    video.onerror = () => rej(new Error('영상을 읽을 수 없어요'));
  });

  const duration = video.duration;
  const vW = video.videoWidth;
  const vH = video.videoHeight;
  const croppedH = Math.max(1, vH - cropTop - cropBottom);

  // Main canvas for full-res cropped output
  const canvas = document.getElementById('video-extract-canvas');
  canvas.width = vW;
  canvas.height = croppedH;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  // Thumb canvas for fingerprinting (tiny, fast)
  const thumbW = 80;
  const thumbH = Math.round(80 * croppedH / vW);
  const tc = document.createElement('canvas');
  tc.width = thumbW; tc.height = thumbH;
  const tctx = tc.getContext('2d', { willReadFrequently: true });

  const FPS = 3; // 3 frames/sec
  const totalSteps = Math.floor(duration * FPS);
  let lastFP = null;
  videoFrames = [];
  const grid = document.getElementById('video-frames-grid');

  for (let i = 0; i < totalSteps; i++) {
    await seekTo(video, i / FPS);

    // Fingerprint (small)
    tctx.drawImage(video, 0, cropTop, vW, croppedH, 0, 0, thumbW, thumbH);
    const fp = getFrameFingerprint(tctx, thumbW, thumbH);

    const pct = (i + 1) / totalSteps * 100;
    setProgress(pct);
    const kept = videoFrames.filter(f => f && !f.deleted).length;
    document.getElementById('video-status').textContent =
      `분석 중 ${Math.round(pct)}% — ${kept}컷`;

    const sim = lastFP ? frameSim(fp, lastFP) : 0;
    if (lastFP === null || sim < threshold) {
      lastFP = fp;
      // Draw full-res cropped frame
      ctx.drawImage(video, 0, cropTop, vW, croppedH, 0, 0, vW, croppedH);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
      if (!blob) continue;
      const blobUrl = URL.createObjectURL(blob);
      const idx = videoFrames.length;
      videoFrames.push({ blob, url: blobUrl });

      const wrap = document.createElement('div');
      wrap.className = 'vf-wrap';
      wrap.id = `vf-${idx}`;
      wrap.innerHTML =
        `<img class="vf-thumb" src="${blobUrl}" loading="lazy">` +
        `<div class="vf-num">${idx + 1}</div>` +
        `<button class="vf-del" onclick="toggleVideoFrame(${idx})">✕</button>`;
      grid.appendChild(wrap);
      // scroll to show latest
      const area = document.getElementById('video-frames-area');
      area.scrollTop = area.scrollHeight;
    }
  }

  URL.revokeObjectURL(objUrl);
  hideProgress();
  const kept = videoFrames.filter(f => f && !f.deleted).length;
  document.getElementById('video-status').textContent = `${kept}컷 추출 완료`;
  document.getElementById('video-save-btn').disabled = kept === 0;
  document.getElementById('video-save-btn').textContent = `${kept}컷 저장`;
}

// Fingerprint: sample top 40% + bottom 40% (scroll-sensitive bands)
// Returns flat array of luminance values for ALL pixels (including background)
function getFrameFingerprint(ctx, w, h) {
  const bandH = Math.max(1, Math.floor(h * 0.40));
  const STEP = 3;
  const fp = [];
  const topData = ctx.getImageData(0, 0, w, bandH).data;
  for (let i = 0; i < topData.length; i += 4 * STEP)
    fp.push((topData[i] * 77 + topData[i+1] * 150 + topData[i+2] * 29) >> 8);
  const botData = ctx.getImageData(0, h - bandH, w, bandH).data;
  for (let i = 0; i < botData.length; i += 4 * STEP)
    fp.push((botData[i] * 77 + botData[i+1] * 150 + botData[i+2] * 29) >> 8);
  return fp;
}

// Content-aware similarity: skip near-white (≥228) and near-black (≤18) pixels
// — these are background/whitespace common to all webtoon pages.
// Only the actual "ink" pixels are compared.
function frameSim(a, b) {
  const len = Math.min(a.length, b.length);
  let inkDiff = 0, inkCount = 0, totalDiff = 0;

  for (let i = 0; i < len; i++) {
    const d = Math.abs(a[i] - b[i]);
    totalDiff += d;
    const avg = (a[i] + b[i]) >> 1;
    if (avg > 18 && avg < 228) {   // "ink" pixel — not white, not black
      inkDiff += d;
      inkCount++;
    }
  }

  // If page is mostly blank (< 3% ink pixels), fall back to full comparison
  if (inkCount < len * 0.03) return 1 - totalDiff / (len * 255);

  return 1 - inkDiff / (inkCount * 255);
}

// Cache of fingerprints for all frames (built once, reused for live preview)
let _dedupFPCache = null;

async function buildFPCache() {
  const tc = document.createElement('canvas');
  tc.width = 80; tc.height = 142;
  const tctx = tc.getContext('2d', { willReadFrequently: true });
  _dedupFPCache = [];

  for (let i = 0; i < videoFrames.length; i++) {
    if (!videoFrames[i]) { _dedupFPCache.push(null); continue; }
    const img = new Image();
    img.src = videoFrames[i].url;
    await new Promise(res => { img.onload = res; });
    tctx.drawImage(img, 0, 0, tc.width, tc.height);
    _dedupFPCache.push(getFrameFingerprint(tctx, tc.width, tc.height));
    setProgress((i + 1) / videoFrames.length * 100);
  }
}

// Simulate dedup and return count of kept frames (no DOM changes)
// Strategy: compare each frame only to the immediately preceding frame by index.
// Scroll duplicates are always temporally adjacent — this prevents false-positives
// between unrelated scenes that happen to look similar.
function simulateDedup(threshold) {
  let keptCount = 0;
  let prevFP = null; // fingerprint of frame at [i-1], regardless of kept/deleted

  for (let i = 0; i < videoFrames.length; i++) {
    if (!videoFrames[i]) continue;
    const fp = _dedupFPCache ? _dedupFPCache[i] : null;
    if (!fp) continue;

    const tooSimilar = prevFP !== null && frameSim(fp, prevFP) >= threshold;
    prevFP = fp; // always advance — compare to actual previous frame
    if (videoFrames[i].deleted) continue; // already manually deleted
    if (!tooSimilar) keptCount++;
  }
  return keptCount;
}

function toggleDedupPanel() {
  const panel = document.getElementById('dedup-panel');
  const arrow = document.getElementById('dedup-arrow');
  const open = panel.classList.toggle('open');
  arrow.textContent = open ? '▲' : '▼';
  if (open && !_dedupFPCache) {
    // Build cache in background for live preview
    document.getElementById('dedup-preview').textContent = '분석 중...';
    showProgress();
    buildFPCache().then(() => {
      hideProgress();
      updateDedupPreview();
    });
  }
}

function getDedupThreshold() {
  return parseInt(document.getElementById('dedup-strength').value) / 100;
}

function onDedupSlider() {
  const v = document.getElementById('dedup-strength').value;
  document.getElementById('dedup-strength-val').textContent = v + '%';
  updateDedupPreview();
}

function setDedupVal(pct) {
  document.getElementById('dedup-strength').value = pct;
  document.getElementById('dedup-strength-val').textContent = pct + '%';
  updateDedupPreview();
}

function updateDedupPreview() {
  if (!_dedupFPCache) return;
  const threshold = getDedupThreshold();
  const count = simulateDedup(threshold);
  const total = videoFrames.filter(f => f && !f.deleted).length;
  document.getElementById('dedup-preview').textContent = `→ ${count}컷 남음 (${total - count}컷 제거)`;
}

async function applyDedup() {
  if (!_dedupFPCache) {
    showProgress();
    document.getElementById('video-status').textContent = '분석 중...';
    await buildFPCache();
    hideProgress();
  }

  const threshold = getDedupThreshold();

  // ── 먼저 모든 컷을 복구 (이전 dedup 결과 초기화) ──
  for (let i = 0; i < videoFrames.length; i++) {
    if (!videoFrames[i]) continue;
    if (videoFrames[i].deleted) {
      videoFrames[i].deleted = false;
      const el = document.getElementById(`vf-${i}`);
      if (el) {
        el.classList.remove('deleted');
        const btn = el.querySelector('.vf-del');
        if (btn) btn.textContent = '✕';
      }
    }
  }

  // ── 전체 컷에 새 기준으로 dedup 적용 ──
  const all = videoFrames.map((f, i) => f ? i : null).filter(i => i !== null);
  if (all.length < 2) return;

  let removed = 0;
  let prevFP = null; // 직전 프레임 (index 기준, kept/deleted 무관)

  for (let i = 0; i < all.length; i++) {
    const idx = all[i];
    const fp = _dedupFPCache[idx];
    if (!fp) { prevFP = null; continue; }

    const tooSimilar = prevFP !== null && frameSim(fp, prevFP) >= threshold;
    prevFP = fp; // 항상 직전 프레임 업데이트

    if (tooSimilar) {
      videoFrames[idx].deleted = true;
      const el = document.getElementById(`vf-${idx}`);
      if (el) {
        el.classList.add('deleted');
        const btn = el.querySelector('.vf-del');
        if (btn) btn.textContent = '↩';
      }
      removed++;
    }
  }

  const kept = videoFrames.filter(f => f && !f.deleted).length;
  document.getElementById('video-status').textContent = `${removed}컷 제거 → ${kept}컷 남음`;
  document.getElementById('video-save-btn').disabled = kept === 0;
  document.getElementById('video-save-btn').textContent = `${kept}컷 저장`;

  document.getElementById('dedup-panel').classList.remove('open');
  document.getElementById('dedup-arrow').textContent = '▼';
}

function togglePostcropPanel() {
  const panel = document.getElementById('postcrop-panel');
  const arrow = document.getElementById('postcrop-arrow');
  const open = panel.classList.toggle('open');
  arrow.textContent = open ? '▲' : '▼';
}

async function applyPostCrop() {
  _dedupFPCache = null; // invalidate cache after crop
  const cropTop = parseInt(document.getElementById('postcrop-top').value) || 0;
  const cropBottom = parseInt(document.getElementById('postcrop-bottom').value) || 0;
  if (cropTop === 0 && cropBottom === 0) return;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let done = 0;
  const total = videoFrames.filter(f => f && !f.deleted).length;
  document.getElementById('video-status').textContent = '자르기 적용 중...';
  showProgress();

  for (let i = 0; i < videoFrames.length; i++) {
    if (!videoFrames[i] || videoFrames[i].deleted) continue;
    const img = new Image();
    img.src = videoFrames[i].url;
    await new Promise(res => { img.onload = res; });

    const newH = Math.max(1, img.height - cropTop - cropBottom);
    canvas.width = img.width;
    canvas.height = newH;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, cropTop, img.width, newH, 0, 0, img.width, newH);

    const newBlob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
    URL.revokeObjectURL(videoFrames[i].url);
    const newUrl = URL.createObjectURL(newBlob);
    videoFrames[i] = { blob: newBlob, url: newUrl };

    const thumbEl = document.querySelector(`#vf-${i} .vf-thumb`);
    if (thumbEl) thumbEl.src = newUrl;

    done++;
    setProgress(done / total * 100);
  }

  hideProgress();
  document.getElementById('video-status').textContent = '자르기 완료!';
  // Reset sliders
  document.getElementById('postcrop-top').value = 0;
  document.getElementById('postcrop-bottom').value = 0;
  document.getElementById('postcrop-top-val').textContent = '0px';
  document.getElementById('postcrop-bottom-val').textContent = '0px';
  // Close panel
  document.getElementById('postcrop-panel').classList.remove('open');
  document.getElementById('postcrop-arrow').textContent = '▼';
}

function toggleVideoFrame(idx) {
  const el = document.getElementById(`vf-${idx}`);
  if (!videoFrames[idx]) return;
  const isDeleted = videoFrames[idx].deleted;
  videoFrames[idx].deleted = !isDeleted;
  if (el) {
    el.classList.toggle('deleted', !isDeleted);
    const btn = el.querySelector('.vf-del');
    if (btn) btn.textContent = isDeleted ? '✕' : '↩';
  }
  updateVideoKeptCount();
}

function updateVideoKeptCount() {
  const kept = videoFrames.filter(f => f && !f.deleted).length;
  document.getElementById('video-save-btn').disabled = kept === 0;
  document.getElementById('video-save-btn').textContent = `${kept}컷 저장`;
  document.getElementById('video-status').textContent = `${kept}컷 선택됨`;
}

function closeVideoMode() {
  videoFrames.forEach(f => { if (f) URL.revokeObjectURL(f.url); });
  videoFrames = [];
  videoFile = null;
  hideProgress();
  document.getElementById('video-mode').classList.add('hidden');
  document.getElementById('video-frames-grid').innerHTML = '';
  openAddEpisodeModal();
}

async function saveVideoFrames() {
  const kept = videoFrames.filter(f => f && !f.deleted);
  if (!kept.length) return;

  document.getElementById('video-mode').classList.add('hidden');
  showProgress();

  const nextNum = episodeCache.length + 1;
  const epId = await dbAdd('episodes', {
    seriesId: state.seriesId,
    title: `${nextNum}화`,
    order: episodeCache.length,
    thumbUrl: null, imageCount: 0, createdAt: Date.now()
  });

  for (let i = 0; i < kept.length; i++) {
    const buf = await kept[i].blob.arrayBuffer();
    await dbAdd('images', {
      episodeId: epId, order: i,
      name: `frame_${String(i + 1).padStart(4, '0')}.jpg`,
      type: 'image/jpeg', data: buf
    });
    setProgress((i + 1) / kept.length * 100);
  }

  videoFrames.forEach(f => { if (f) URL.revokeObjectURL(f.url); });
  videoFrames = [];
  videoFile = null;
  hideProgress();

  const imgs = await dbGetAll('images', 'episodeId', epId);
  if (imgs.length) {
    const thumbUrl = await bufToDataUrl(imgs[0].data, imgs[0].type);
    await dbPut('episodes', { ...(await dbGet('episodes', epId)), thumbUrl, imageCount: imgs.length });
    const series = await dbGet('series', state.seriesId);
    if (!series.coverUrl) await dbPut('series', { ...series, coverUrl: thumbUrl });
  }

  await renderEpisodes();
}

// ── SCAN MODE ─────────────────────────────────────────────────────────────────
let scanStream = null;
let scanBlobs = []; // Array of {blob, url} captured so far

async function openScanMode() {
  hideModal('modal-add-episode');
  scanBlobs = [];
  renderScanStrip();

  const scanEl = document.getElementById('scan-mode');
  scanEl.classList.remove('hidden');

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    const video = document.getElementById('scan-video');
    video.srcObject = scanStream;
    await video.play();
  } catch (err) {
    closeScanMode();
    await showConfirm('카메라 오류', '카메라를 사용할 수 없어요.\n카메라 권한을 허용해 주세요.', '확인', '');
  }
}

function closeScanMode() {
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
  const video = document.getElementById('scan-video');
  video.srcObject = null;
  // Revoke blob URLs
  scanBlobs.forEach(b => URL.revokeObjectURL(b.url));
  scanBlobs = [];
  document.getElementById('scan-mode').classList.add('hidden');
  document.getElementById('scan-strip').innerHTML = '';
  updateScanUI();
  // Return to episode add modal
  openAddEpisodeModal();
}

function captureFrame() {
  const video = document.getElementById('scan-video');
  if (!video.videoWidth) return;

  const canvas = document.getElementById('scan-capture-canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  // Flash effect
  const flash = document.createElement('div');
  flash.className = 'scan-flash';
  document.body.appendChild(flash);
  flash.addEventListener('animationend', () => flash.remove());

  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    scanBlobs.push({ blob, url });
    renderScanStrip();
    updateScanUI();
    // Auto-scroll strip to end
    const strip = document.getElementById('scan-strip');
    setTimeout(() => { strip.scrollLeft = strip.scrollWidth; }, 50);
  }, 'image/jpeg', 0.92);
}

function deleteScanFrame(index) {
  URL.revokeObjectURL(scanBlobs[index].url);
  scanBlobs.splice(index, 1);
  renderScanStrip();
  updateScanUI();
}

function renderScanStrip() {
  const strip = document.getElementById('scan-strip');
  strip.innerHTML = scanBlobs.map((b, i) =>
    `<div class="scan-thumb-wrap">
      <img class="scan-thumb" src="${b.url}">
      <button class="scan-thumb-del" onclick="deleteScanFrame(${i})">✕</button>
    </div>`
  ).join('');
}

function updateScanUI() {
  const n = scanBlobs.length;
  document.getElementById('scan-count').textContent = `${n}장 촬영`;
  document.getElementById('scan-save-btn').disabled = n === 0;
}

async function saveScanImages() {
  if (!scanBlobs.length) return;

  // Stop camera
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
  document.getElementById('scan-mode').classList.add('hidden');

  // Convert blobs to File-like objects
  const files = scanBlobs.map((b, i) => new File([b.blob], `scan_${String(i + 1).padStart(4, '0')}.jpg`, { type: 'image/jpeg' }));

  // Revoke URLs
  scanBlobs.forEach(b => URL.revokeObjectURL(b.url));
  scanBlobs = [];
  document.getElementById('scan-strip').innerHTML = '';

  // Auto-generate episode name (e.g. 2화, 3화...)
  const nextNum = episodeCache.length + 1;
  const autoTitle = `${nextNum}화`;

  // Save directly as a new episode
  const epTitle = autoTitle;
  const order = episodeCache.length;
  showProgress();

  const epId = await dbAdd('episodes', {
    seriesId: state.seriesId, title: epTitle, order, thumbUrl: null, imageCount: 0, createdAt: Date.now()
  });

  await importImages(epId, files, (cur, total) => setProgress(cur / total * 100));
  hideProgress();

  const imgs = await dbGetAll('images', 'episodeId', epId);
  if (imgs.length) {
    const thumbUrl = await bufToDataUrl(imgs[0].data, imgs[0].type);
    await dbPut('episodes', { ...(await dbGet('episodes', epId)), thumbUrl, imageCount: imgs.length });
    const series = await dbGet('series', state.seriesId);
    if (!series.coverUrl) {
      await dbPut('series', { ...series, coverUrl: thumbUrl });
    }
  }

  await renderEpisodes();
}

// ── SETTINGS / BACKUP ─────────────────────────────────────────────────────────
// 브라우저 저장소(IndexedDB)는 이 기기 안에서만 유지되므로, 실수로 사이트
// 데이터가 지워지거나 다른 기기로 옮길 때를 위한 zip 백업/복원 기능.
function openSettingsModal() {
  showModal('modal-settings');
}

// 영상은 이 zip 백업에 절대 포함하지 않음 — JSZip은 파일을 하나씩
// "읽고 바로 버리는" 스트리밍이 아니라 generateAsync() 시점까지 추가된
// 데이터를 전부 메모리에 들고 있다가 한꺼번에 압축하는 구조라, 읽기를
// 아무리 쪼개도 영상 여러 개(수십~수백MB)를 하나의 zip에 합치는 순간
// 총 메모리 사용량은 그대로임. 실제로 사용자 기기에서 진행률 70%
// 부근(zip 생성 단계)에서 화면이 통째로 까맣게 변하며 죽는 것으로
// 확인됨 — 이건 JS 예외가 아니라 iOS WebKit 프로세스 자체의 OOM(메모리
// 부족) 크래시라 try/catch로 잡을 수도 없음. 그래서 영상은 아예 이
// 경로에서 빼고, 훨씬 가벼운 openVideoExportList()(영상 1개씩 개별
// 저장)로만 다루도록 분리함.
async function exportBackup() {
  showProgress();
  setProgress(5);
  const failedImages = [];
  try {
    const zip = new JSZip();
    const series = await dbGetAll('series');
    const episodes = await dbGetAll('episodes');
    const tags = await dbGetAll('tags');

    // 사진도 getAll()로 한꺼번에 훑지 않고, 키만 먼저 가져온 뒤 하나씩
    // 완전히 독립된 트랜잭션(dbGet)으로 읽음 — iOS Safari는 blob을 다루는
    // 트랜잭션이 오래 걸리거나 데이터가 누적되면 "internal error"를 내는
    // 경우가 있어서, 매번 새 트랜잭션으로 끊어서 그 여지를 최소화함.
    // 그래도 유독 큰 파일 하나가 실패하면 그것만 건너뛰고 나머지는 계속 백업.
    const imageMetas = [];
    const imageKeys = await dbGetAllKeys('images');
    const total = imageKeys.length || 1;
    let done = 0;

    for (const key of imageKeys) {
      try {
        const img = await dbGet('images', key);
        if (img) {
          zip.file(`images/${img.id}.bin`, img.data);
          imageMetas.push({ id: img.id, episodeId: img.episodeId, order: img.order, name: img.name, type: img.type });
        }
      } catch (err) {
        failedImages.push(key);
      }
      done++; setProgress(5 + (done / total) * 60);
    }

    const manifest = {
      version: 3,
      exportedAt: Date.now(),
      videosIncluded: false, // 영상은 "영상 개별로 저장"으로 따로 받아야 함
      series, episodes, tags,
      images: imageMetas
    };
    zip.file('data.json', JSON.stringify(manifest));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, meta => setProgress(65 + meta.percent * 0.35));

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `webtoon-backup-${stamp}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    if (failedImages.length) {
      hideProgress();
      await showConfirm(
        '일부만 백업됐어요',
        `사진 ${failedImages.length}장을 백업에 넣지 못했어요 (용량이 너무 커서 기기 제한에 걸렸을 수 있어요).\n나머지는 정상적으로 zip 파일로 저장됐습니다.`,
        '확인', 'background:var(--accent);color:#000'
      );
    }
  } catch (err) {
    await showConfirm('내보내기 실패', String(err.message || err), '확인', '');
  } finally {
    hideProgress();
  }
}

// zip 백업이 용량 때문에 계속 실패할 때를 위한 대안 — 영상을 zip으로 묶지
// 않고 한 번에 하나씩만 읽어서 원본 그대로 기기에 저장. 훨씬 가벼운 요청
// (개별 회차 인덱스 조회 1건)이라 zip 방식보다 실패할 여지가 적음
async function openVideoExportList() {
  hideModal('modal-settings');
  const episodes = await dbGetAll('episodes');
  const videoEps = episodes.filter(ep => ep.type === 'video').sort((a, b) => a.order - b.order);
  const wrap = document.getElementById('video-export-list');
  if (!videoEps.length) {
    wrap.innerHTML = '<p style="color:var(--text2);font-size:14px;text-align:center;padding:12px">저장된 영상이 없어요.</p>';
  } else {
    wrap.innerHTML = videoEps.map(ep => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:var(--surface2);border-radius:8px">
        <span style="font-size:14px">${escHtml(ep.title)}</span>
        <button class="header-action" onclick="downloadSingleVideo(${ep.id})">저장</button>
      </div>`
    ).join('');
  }
  showModal('modal-video-export-list');
}

async function downloadSingleVideo(episodeId) {
  try {
    const episode = await dbGet('episodes', episodeId);
    const vids = await dbGetAll('videos', 'episodeId', episodeId);
    if (!vids.length) { await showConfirm('저장 실패', '영상 데이터를 찾을 수 없어요.', '확인', ''); return; }
    const v = vids[0];
    const blob = new Blob([v.videoData], { type: v.videoType || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ext = (v.videoName && v.videoName.includes('.')) ? v.videoName.slice(v.videoName.lastIndexOf('.')) : '.mp4';
    a.href = url;
    a.download = `${(episode?.title || 'video').replace(/[\\/:*?"<>|]/g, '_')}${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    await showConfirm('저장 실패', String(err.message || err), '확인', '');
  }
}

async function onImportFileSelected(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const ok = await showConfirm(
    '백업 가져오기',
    '지금 기기에 있는 모든 시리즈·사진 정보가 이 백업 파일 내용으로 교체됩니다.\n(영상은 이 백업에 포함되지 않아서 그대로 남아있어요)\n계속할까요?',
    '가져오기', 'background:var(--accent);color:#000'
  );
  if (!ok) return;
  await importBackup(file);
}

async function importBackup(file) {
  hideModal('modal-settings');
  showProgress();
  setProgress(5);
  try {
    const zip = await JSZip.loadAsync(file);
    const manifestFile = zip.file('data.json');
    if (!manifestFile) throw new Error('올바른 백업 파일이 아니에요');
    const manifest = JSON.parse(await manifestFile.async('string'));

    // 기존 데이터 비우기 (백업 내용으로 대체) — 'videos'는 일부러 안 비움.
    // 이 백업엔 영상이 안 들어있어서(용량 문제로 exportBackup에서 제외함),
    // videos까지 지워버리면 기기에 남아있던 영상을 되살릴 방법이 없어짐.
    // clear()는 전체를 getAll()로 읽어서 하나씩 지우는 것보다 훨씬 가볍고
    // 큰 blob을 메모리에 올릴 필요가 없음 (Safari internal error 회피)
    for (const store of ['series', 'episodes', 'images', 'tags']) {
      await dbClear(store);
    }

    for (const s of manifest.series || []) await dbPut('series', s);
    for (const t of manifest.tags || []) await dbPut('tags', t);
    for (const ep of manifest.episodes || []) await dbPut('episodes', ep);

    const imgMetas = manifest.images || [];
    // manifest.videos는 이 기능 이전 버전(v1~2) 백업 파일과의 호환용 —
    // 새로 내보낸 백업엔 항상 없음(videosIncluded: false)
    const vidMetas = manifest.videos || [];
    const total = imgMetas.length + vidMetas.length || 1;
    let done = 0;

    for (const imgMeta of imgMetas) {
      const entry = zip.file(`images/${imgMeta.id}.bin`);
      if (entry) {
        const data = await entry.async('arraybuffer');
        await dbPut('images', { ...imgMeta, data });
      }
      done++; setProgress(5 + (done / total) * 90);
    }
    if (vidMetas.length) await dbClear('videos'); // 옛 백업이 영상을 갖고 있을 때만 교체
    for (const vMeta of vidMetas) {
      const videoEntry = zip.file(`videos/${vMeta.id}_video.bin`);
      const thumbEntry = zip.file(`videos/${vMeta.id}_thumb.bin`);
      if (videoEntry) {
        const videoData = await videoEntry.async('arraybuffer');
        const thumbData = thumbEntry ? await thumbEntry.async('arraybuffer') : null;
        await dbPut('videos', { ...vMeta, videoData, thumbData });
      }
      done++; setProgress(5 + (done / total) * 90);
    }

    hideProgress();
    await showConfirm('가져오기 완료', '백업을 복원했어요.\n확인을 누르면 새로고침됩니다.', '확인', 'background:var(--accent);color:#000');
    location.reload();
  } catch (err) {
    hideProgress();
    await showConfirm('가져오기 실패', '백업 파일을 읽을 수 없어요.\n' + (err.message || err), '확인', '');
  }
}

// ── INSTALL BANNER ────────────────────────────────────────────────────────────
function checkInstallBanner() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone;
  const dismissed = localStorage.getItem('install-dismissed');
  if (isIOS && !isStandalone && !dismissed) {
    document.getElementById('install-banner').classList.remove('hidden');
  }
}

function dismissInstallBanner() {
  document.getElementById('install-banner').classList.add('hidden');
  localStorage.setItem('install-dismissed', '1');
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function fixBrokenCovers() {
  // Fix any covers/thumbs stored as blob URLs (they start with "blob:")
  const allSeries = await dbGetAll('series');
  for (const s of allSeries) {
    if (s.coverUrl && s.coverUrl.startsWith('blob:')) {
      const eps = await dbGetAll('episodes', 'seriesId', s.id);
      eps.sort((a, b) => a.order - b.order);
      if (eps.length) {
        const imgs = await dbGetAll('images', 'episodeId', eps[0].id);
        imgs.sort((a, b) => a.order - b.order);
        if (imgs.length) {
          const dataUrl = await bufToDataUrl(imgs[0].data, imgs[0].type);
          await dbPut('series', { ...s, coverUrl: dataUrl });
        }
      }
    }
  }
  const allEps = await dbGetAll('episodes');
  for (const ep of allEps) {
    if (ep.thumbUrl && ep.thumbUrl.startsWith('blob:')) {
      const imgs = await dbGetAll('images', 'episodeId', ep.id);
      imgs.sort((a, b) => a.order - b.order);
      if (imgs.length) {
        const dataUrl = await bufToDataUrl(imgs[0].data, imgs[0].type);
        await dbPut('episodes', { ...ep, thumbUrl: dataUrl });
      }
    }
  }
}

async function init() {
  db = await openDB();
  await fixBrokenCovers();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/webtoon-pwa/sw.js').catch(() => {});
  }

  // Event listeners
  document.getElementById('fab').addEventListener('click', () => {
    if (state.screen === 'home') toggleFabMenu();
    else if (state.screen === 'episodes') openAddEpisodeModal();
  });

  document.getElementById('modal-add-series').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal('modal-add-series');
  });
  document.getElementById('modal-add-episode').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal('modal-add-episode');
  });
  document.getElementById('modal-add-video').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal('modal-add-video');
  });
  document.getElementById('modal-settings').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal('modal-settings');
  });
  document.getElementById('modal-video-export-list').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal('modal-video-export-list');
  });

  document.getElementById('series-pick-area').addEventListener('click', () => {
    document.getElementById('series-file-input').click();
  });
  document.getElementById('ep-pick-area').addEventListener('click', () => {
    document.getElementById('ep-file-input').click();
  });
  document.getElementById('video-upload-pick-area').addEventListener('click', () => {
    document.getElementById('video-upload-file-input').click();
  });
  document.getElementById('video-upload-thumb-area').addEventListener('click', () => {
    document.getElementById('video-upload-thumb-input').click();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#ctx-menu')) hideCtxMenu();
  });

  // Tap reader content to toggle overlay
  document.getElementById('reader-content').addEventListener('click', e => {
    if (state.screen === 'reader') toggleReaderOverlay();
  });

  // Back button in reader overlay
  document.getElementById('reader-overlay-top').addEventListener('click', e => {
    if (e.target.closest('.r-series') || e.target === e.currentTarget) {
      navigate('episodes', { seriesId: state.seriesId });
    }
  });

  checkInstallBanner();
  await render();
}

document.addEventListener('DOMContentLoaded', init);
