// ── DB ──────────────────────────────────────────────────────────────────────
const DB_NAME = 'webtoon-db', DB_VER = 1;
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

// ── STATE ────────────────────────────────────────────────────────────────────
let state = { screen: 'home', seriesId: null, episodeId: null };
let seriesCache = [];
let episodeCache = [];
let imageCache = [];
let pendingFiles = null;
let longPressTimer = null;

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

async function renderHome() {
  seriesCache = await dbGetAll('series');
  seriesCache.sort((a, b) => b.createdAt - a.createdAt);

  const header = document.getElementById('home-header');
  header.innerHTML = `<span class="header-logo">📚 내 웹툰</span>`;

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

  // Count episodes per series
  const allEps = await dbGetAll('episodes');
  const epCount = {};
  allEps.forEach(ep => { epCount[ep.seriesId] = (epCount[ep.seriesId] || 0) + 1; });

  const grid = seriesCache.map(s => {
    const count = epCount[s.id] || 0;
    const coverHtml = s.coverUrl
      ? `<img class="cover" src="${s.coverUrl}" loading="lazy">`
      : `<div class="cover-empty">📚</div>`;
    return `
      <div class="series-card" data-id="${s.id}"
           onclick="navigate('episodes',{seriesId:${s.id}})"
           oncontextmenu="showCtxMenu(event,'series',${s.id})"
      >
        ${coverHtml}
        <div class="card-info">
          <div class="card-title">${escHtml(s.title)}</div>
          <div class="card-count">${count}화</div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="section-title">전체 시리즈</div>
    <div class="series-grid">${grid}</div>`;

  // long press for context menu on mobile
  container.querySelectorAll('.series-card').forEach(card => {
    card.addEventListener('touchstart', e => {
      const id = +card.dataset.id;
      longPressTimer = setTimeout(() => showCtxMenuTouch(e.touches[0], 'series', id), 500);
    }, { passive: true });
    card.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
    card.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
  });
}

async function renderEpisodes() {
  const series = await dbGet('series', state.seriesId);
  if (!series) { navigate('home'); return; }

  const header = document.getElementById('ep-header-ui');
  header.innerHTML = `
    <button class="header-back" onclick="navigate('home')">‹</button>
    <span class="header-title">${escHtml(series.title)}</span>
    <button class="header-action" onclick="openAddEpisodeModal()">+ 추가</button>`;

  episodeCache = await dbGetAll('episodes', 'seriesId', state.seriesId);
  episodeCache.sort((a, b) => a.order - b.order);

  const coverHtml = series.coverUrl
    ? `<img class="ep-header-cover" src="${series.coverUrl}">`
    : `<div class="ep-header-cover-empty">📚</div>`;

  const epItems = episodeCache.length === 0
    ? `<div class="empty-state" style="padding:40px 24px">
        <div class="emoji">🗂️</div>
        <h3>회차가 없어요</h3>
        <p>위의 + 추가를 눌러<br>이미지를 업로드하세요</p>
       </div>`
    : episodeCache.map((ep, i) => {
        const thumbHtml = ep.thumbUrl
          ? `<img class="ep-thumb" src="${ep.thumbUrl}" loading="lazy">`
          : `<div class="ep-thumb-empty">🖼️</div>`;
        return `
          <div class="ep-item" data-id="${ep.id}"
               onclick="navigate('reader',{seriesId:${state.seriesId},episodeId:${ep.id}})"
               oncontextmenu="showCtxMenu(event,'episode',${ep.id})"
          >
            ${thumbHtml}
            <div class="ep-info">
              <div class="ep-title">${escHtml(ep.title)}</div>
              <div class="ep-sub">${ep.imageCount || 0}장</div>
            </div>
            <span class="ep-arrow">›</span>
          </div>`;
      }).join('');

  const container = document.getElementById('ep-content');
  container.innerHTML = `
    ${coverHtml}
    <div class="ep-meta">
      <h2>${escHtml(series.title)}</h2>
      <p>${episodeCache.length}화 등록됨</p>
    </div>
    <div class="ep-list">${epItems}</div>`;

  // long press
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

  const header = document.getElementById('reader-header');
  header.innerHTML = `
    <button class="header-back" onclick="navigate('episodes',{seriesId:${state.seriesId}})">‹</button>
    <span class="header-title">${escHtml(episode?.title || '')}</span>`;

  const container = document.getElementById('reader-content');
  container.innerHTML = `<div style="text-align:center;padding:40px;color:#666">이미지 로딩중...</div>`;

  imageCache = await dbGetAll('images', 'episodeId', state.episodeId);
  imageCache.sort((a, b) => a.order - b.order);

  if (!imageCache.length) {
    container.innerHTML = `<div class="empty-state"><div class="emoji">🖼️</div><h3>이미지가 없어요</h3></div>`;
    return;
  }

  // Revoke old blob URLs to avoid memory leak
  revokeOldUrls();

  const imgs = imageCache.map(img => {
    const url = bufToUrl(img.data, img.type);
    img._blobUrl = url;
    return `<img src="${url}" loading="lazy" decoding="async">`;
  }).join('');

  container.innerHTML = `<div class="reader-images">${imgs}</div>`;
}

let blobUrlsToRevoke = [];
function revokeOldUrls() {
  blobUrlsToRevoke.forEach(u => URL.revokeObjectURL(u));
  blobUrlsToRevoke = [];
}

// ── MODALS ───────────────────────────────────────────────────────────────────
function openAddSeriesModal() {
  pendingFiles = null;
  document.getElementById('series-name-input').value = '';
  document.getElementById('series-file-count').textContent = '';
  document.getElementById('series-file-input').value = '';
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

// ── SAVE SERIES ──────────────────────────────────────────────────────────────
async function saveSeries() {
  const title = document.getElementById('series-name-input').value.trim();
  if (!title) { alert('시리즈 이름을 입력해주세요'); return; }

  const id = await dbAdd('series', { title, coverUrl: null, createdAt: Date.now() });

  // If files were picked, auto-create first episode
  if (pendingFiles && pendingFiles.length > 0) {
    const epId = await dbAdd('episodes', {
      seriesId: id, title: '1화', order: 0, thumbUrl: null, imageCount: 0, createdAt: Date.now()
    });
    await importImages(epId, pendingFiles);
    // Set cover from first image
    const imgs = await dbGetAll('images', 'episodeId', epId);
    if (imgs.length) {
      const url = bufToUrl(imgs[0].data, imgs[0].type);
      await dbPut('series', { ...(await dbGet('series', id)), coverUrl: url });
      const ep = await dbGet('episodes', epId);
      await dbPut('episodes', { ...ep, thumbUrl: url, imageCount: imgs.length });
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
    const thumbUrl = bufToUrl(imgs[0].data, imgs[0].type);
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

  document.getElementById('ctx-rename').style.display = type === 'series' ? 'flex' : 'flex';
  document.getElementById('ctx-delete').style.display = 'flex';
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('show');
  ctxTarget = null;
}

async function ctxRename() {
  hideCtxMenu();
  if (!ctxTarget) return;
  const { type, id } = ctxTarget;
  const label = type === 'series' ? '시리즈 이름' : '회차 이름';
  const current = type === 'series'
    ? seriesCache.find(s => s.id === id)?.title
    : episodeCache.find(e => e.id === id)?.title;

  const name = prompt(label + ' 변경', current || '');
  if (!name || !name.trim()) return;

  const store = type === 'series' ? 'series' : 'episodes';
  const item = await dbGet(store, id);
  await dbPut(store, { ...item, title: name.trim() });
  render();
}

async function ctxDelete() {
  hideCtxMenu();
  if (!ctxTarget) return;
  const { type, id } = ctxTarget;
  const label = type === 'series' ? '이 시리즈' : '이 회차';
  if (!confirm(`${label}를 삭제할까요? 이미지도 모두 삭제됩니다.`)) return;

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

// ── UTILS ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
async function init() {
  db = await openDB();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Event listeners
  document.getElementById('fab').addEventListener('click', () => {
    if (state.screen === 'home') openAddSeriesModal();
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

  checkInstallBanner();
  await render();
}

document.addEventListener('DOMContentLoaded', init);
