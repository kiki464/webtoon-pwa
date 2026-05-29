// ── DB ──────────────────────────────────────────────────────────────────────
const DB_NAME = 'webtoon-db', DB_VER = 2;
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

// 시리즈 커버: 커스텀 표지가 있으면 우선 사용, 없으면 첫 이미지
async function getSeriesCoverUrl(seriesId) {
  const series = await dbGet('series', seriesId);
  if (series?.coverUrl && series.coverUrl.startsWith('data:')) return series.coverUrl;
  const eps = await dbGetAll('episodes', 'seriesId', seriesId);
  if (!eps.length) return null;
  eps.sort((a, b) => a.order - b.order);
  const imgs = await dbGetAll('images', 'episodeId', eps[0].id);
  if (!imgs.length) return null;
  imgs.sort((a, b) => a.order - b.order);
  return bufToUrl(imgs[0].data, imgs[0].type);
}

// 회차의 첫 번째 이미지를 IndexedDB에서 직접 가져옴
async function getEpisodeCoverUrl(episodeId) {
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
        return `
          <div class="ep-item" data-id="${ep.id}"
               onclick="navigate('reader',{seriesId:${state.seriesId},episodeId:${ep.id}})"
               oncontextmenu="showCtxMenu(event,'episode',${ep.id})"
          >
            <div class="ep-thumb-empty" id="epthumb-${ep.id}">🖼️</div>
            <div class="ep-info">
              <div class="ep-title">${escHtml(ep.title)}</div>
              <div class="ep-sub">${ep.imageCount || 0}장</div>
            </div>
            <span class="ep-arrow">›</span>
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

  container.querySelectorAll('.ep-item').forEach(item => {
    const id = +item.dataset.id;
    item.addEventListener('touchstart', e => {
      longPressTimer = setTimeout(() => showCtxMenuTouch(e.touches[0], 'episode', id), 500);
    }, { passive: true });
    item.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
    item.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
  });
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
  container.innerHTML = `<div style="text-align:center;padding:40px;color:#666">이미지 로딩중...</div>`;

  imageCache = await dbGetAll('images', 'episodeId', state.episodeId);
  imageCache.sort((a, b) => a.order - b.order);

  if (!imageCache.length) {
    container.innerHTML = `<div class="empty-state"><div class="emoji">🖼️</div><h3>이미지가 없어요</h3></div>`;
    return;
  }

  revokeOldUrls();

  const imgs = imageCache.map(img => {
    const url = bufToUrl(img.data, img.type);
    img._blobUrl = url;
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
  document.getElementById('ctx-rename').style.display = 'flex';
  document.getElementById('ctx-delete').style.display = 'flex';
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

async function ctxDelete() {
  const target = ctxTarget;
  hideCtxMenu();
  if (!target) return;
  const { type, id } = target;
  const label = type === 'series' ? '이 시리즈' : '이 회차';
  const ok = await showConfirm('삭제할까요?', `${label}를 삭제하면 이미지도 모두 삭제됩니다.`);
  if (!ok) return;

  if (type === 'series') {
    // delete all episodes and images
    const eps = await dbGetAll('episodes', 'seriesId', id);
    for (const ep of eps) {
      await dbDeleteByIndex('images', 'episodeId', ep.id);
    }
    await dbDeleteByIndex('episodes', 'seriesId', id);
    await dbDelete('series', id);
    navigate('home');
  } else {
    await dbDeleteByIndex('images', 'episodeId', id);
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
  navigate('home');
}

async function renderTagFilterBar() {
  tagsCache = await dbGetAll('tags');
  const bar = document.getElementById('tag-filter-bar');
  if (!tagsCache.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = tagsCache.map(t =>
    `<button class="tag-filter-btn${activeTagIds.has(t.id) ? ' active' : ''}" data-id="${t.id}"
      style="--tc:${tagColor(t.id)}" onclick="toggleTagFilter(${t.id})">${escHtml(t.name)}</button>`
  ).join('');
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

  document.getElementById('series-pick-area').addEventListener('click', () => {
    document.getElementById('series-file-input').click();
  });
  document.getElementById('ep-pick-area').addEventListener('click', () => {
    document.getElementById('ep-file-input').click();
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
