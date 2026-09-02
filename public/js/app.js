/**
 * Wiring: input handling, the side panel, filters and the map/lightbox hookup.
 */

import { state, on, emit, emitNow, counts, dateRange, locatedPhotos, allFilteredPhotos, removeAlbum, forgetAlbum, rememberedAlbums } from './store.js';
import { loadSharedAlbum, loadFiles, loadImageUrls, parseAlbumInput, isImageUrl } from './sources.js';
import { initMap, mapView, render, fitAll, focusPhoto, setBasemap, basemapNames, setRouteVisible, closeSpider } from './mapview.js';
import { initLightbox, open as openLightbox, isOpen as lightboxOpen } from './lightbox.js';

const SAMPLE = 'https://www.icloud.com/sharedalbum/#B0n5Uzl7V3IW57';

const el = (id) => document.getElementById(id);
const dom = {};
let fitScheduled = null;

function boot() {
  cacheDom();
  initMap(dom.map);
  initLightbox(dom.lightbox, { onShowOnMap: () => {} });
  buildBasemapControl();
  wireEvents();

  on('photos', () => { renderAlbums(); renderStats(); renderTimeRange(); renderUnlocated(); maybeFit(); });
  on('progress', renderStats);
  on('viewport', renderInView);
  on('open', (id) => openLightbox(id));
  on('filters', () => { renderStats(); renderUnlocated(); });

  restoreFromUrl();
}

function cacheDom() {
  dom.map = el('map');
  dom.lightbox = el('lightbox');
  dom.status = el('status');
  dom.albums = el('albums');
  dom.albumsEmpty = el('albums-empty');
  dom.stats = el('stats');
  dom.statsPanel = el('stats-panel');
  dom.progress = el('progress');
  dom.timePanel = el('time-panel');
  dom.rangeFrom = el('range-from');
  dom.rangeTo = el('range-to');
  dom.rangeLabel = el('range-label');
  dom.inviewPanel = el('inview-panel');
  dom.inview = el('inview');
  dom.inviewCount = el('inview-count');
  dom.unlocatedPanel = el('unlocated-panel');
  dom.unlocated = el('unlocated');
  dom.unlocatedCount = el('unlocated-count');
  dom.input = el('album-input');
  dom.dropzone = el('dropzone');
  dom.hint = el('hint');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function wireEvents() {
  el('loader').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = dom.input.value.trim();
    if (!value) return;
    dom.input.value = '';
    addFromText(value);
  });

  el('try-sample').addEventListener('click', () => addFromText(SAMPLE));
  el('fit-all').addEventListener('click', () => { mapView.userInteracted = true; fitAll(); });
  el('sidebar-toggle').addEventListener('click', () => {
    document.body.classList.toggle('is-collapsed');
    setTimeout(() => mapView.map.invalidateSize(), 220);
  });

  el('route-toggle').addEventListener('change', (e) => setRouteVisible(e.target.checked));

  el('pick-files').addEventListener('click', () => el('file-input').click());
  el('file-input').addEventListener('change', (e) => {
    if (e.target.files?.length) ingestFiles(e.target.files);
    e.target.value = '';
  });

  for (const input of [dom.rangeFrom, dom.rangeTo]) {
    input.addEventListener('input', onRangeInput);
  }
  el('range-reset').addEventListener('click', () => {
    dom.rangeFrom.value = 0;
    dom.rangeTo.value = 1000;
    onRangeInput();
  });

  wireDragAndDrop();

  window.addEventListener('hashchange', restoreFromUrl);
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== dom.input && !lightboxOpen()) {
      e.preventDefault();
      dom.input.focus();
    }
  });
}

function wireDragAndDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    depth += 1;
    dom.dropzone.hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dom.dropzone.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    dom.dropzone.hidden = true;
    if (e.dataTransfer.files?.length) ingestFiles(e.dataTransfer.files);
  });
}

async function addFromText(text) {
  const tokens = parseAlbumInput(text);
  const albums = tokens.filter((t) => !isImageUrl(t));
  const images = tokens.filter(isImageUrl);

  if (images.length) {
    setStatus(`Adding ${images.length} linked photo${images.length > 1 ? '' : ''}…`);
    loadImageUrls(images, { onStatus: setStatus });
  }

  for (const token of albums) {
    try {
      setStatus('Fetching album…');
      const album = await loadSharedAlbum(token, { onStatus: setStatus });
      setStatus(`Loaded “${album.name}” — ${album.photos.length} items`);
      syncUrl();
    } catch (err) {
      setStatus('');
      showHint(err.message || 'Could not load that album');
    }
  }
}

async function ingestFiles(files) {
  try {
    setStatus('Reading files…');
    await loadFiles(files, { onStatus: setStatus });
    setStatus('');
  } catch (err) {
    setStatus('');
    showHint(err.message);
  }
}

function setStatus(text) {
  dom.status.textContent = text || '';
  dom.status.classList.toggle('is-busy', Boolean(text));
}

let hintTimer = null;
function showHint(message) {
  dom.hint.textContent = message;
  dom.hint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { dom.hint.hidden = true; }, 6000);
}

// ---------------------------------------------------------------------------
// Shareable URL (#album=TOKEN,TOKEN)
// ---------------------------------------------------------------------------

function syncUrl() {
  const tokens = [...state.albums.keys()].filter((t) => t !== 'local' && t !== 'links');
  const hash = tokens.length ? `#album=${tokens.join(',')}` : '';
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname);
}

function restoreFromUrl() {
  // Tokens may contain - and _ (newer base64url album tokens).
  const match = location.hash.match(/album=([A-Za-z0-9,_-]+)/);
  const tokens = match ? match[1].split(',').filter(Boolean) : [];
  const missing = tokens.filter((t) => !state.albums.has(t));
  if (missing.length) {
    addFromText(missing.join(' '));
    return;
  }
  if (!state.albums.size) {
    const remembered = rememberedAlbums();
    if (remembered.length) {
      dom.input.value = `https://www.icloud.com/sharedalbum/#${remembered[0]}`;
      showHint('Last album is in the box — press Add to reload it.');
    }
  }
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function renderAlbums() {
  const albums = [...state.albums.values()];
  dom.albumsEmpty.hidden = albums.length > 0;
  dom.albums.innerHTML = albums.map((album) => `
    <div class="album" data-token="${escapeAttr(album.token)}">
      <label class="album__main">
        <input type="checkbox" ${state.filters.albums.has(album.token) ? 'checked' : ''} data-toggle>
        <span class="album__text">
          <span class="album__name">${escapeHtml(album.name)}</span>
          <span class="album__meta">${album.located} of ${album.count} mapped${album.owner ? ` · ${escapeHtml(album.owner)}` : ''}</span>
        </span>
      </label>
      <button class="album__remove" data-remove title="Remove">&times;</button>
    </div>`).join('');

  dom.albums.querySelectorAll('.album').forEach((node) => {
    const token = node.dataset.token;
    node.querySelector('[data-toggle]').addEventListener('change', (e) => {
      if (e.target.checked) state.filters.albums.add(token);
      else state.filters.albums.delete(token);
      emitNow('filters');
      render();
    });
    node.querySelector('[data-remove]').addEventListener('click', () => {
      removeAlbum(token);
      forgetAlbum(token);
      closeSpider();
      syncUrl();
      render();
    });
  });
}

function renderStats() {
  const c = counts();
  dom.statsPanel.hidden = c.total === 0;
  dom.stats.innerHTML = `
    <div class="stat"><b>${c.located}</b><span>mapped</span></div>
    <div class="stat"><b>${c.total}</b><span>photos</span></div>
    ${c.nolocation ? `<div class="stat stat--muted"><b>${c.nolocation}</b><span>no GPS</span></div>` : ''}
    ${c.failed ? `<div class="stat stat--warn"><b>${c.failed}</b><span>failed</span></div>` : ''}`;

  const busy = c.pending > 0;
  dom.progress.hidden = !busy;
  if (busy) {
    const done = c.total - c.pending;
    dom.progress.firstElementChild.style.width = `${Math.round((done / Math.max(1, c.total)) * 100)}%`;
  }
}

function renderTimeRange() {
  const range = dateRange();
  dom.timePanel.hidden = !range || range.min === range.max;
  if (dom.timePanel.hidden) return;
  dom.timePanel.dataset.min = range.min;
  dom.timePanel.dataset.max = range.max;
  updateRangeLabel();
}

function onRangeInput() {
  const min = Number(dom.timePanel.dataset.min);
  const max = Number(dom.timePanel.dataset.max);
  if (!min || !max) return;
  let from = Number(dom.rangeFrom.value);
  let to = Number(dom.rangeTo.value);
  if (from > to) { [from, to] = [to, from]; }
  const span = max - min;
  state.filters.from = from === 0 ? null : min + (span * from) / 1000;
  state.filters.to = to === 1000 ? null : min + (span * to) / 1000;
  updateRangeLabel();
  emitNow('filters');
  render();
}

function updateRangeLabel() {
  const min = Number(dom.timePanel.dataset.min);
  const max = Number(dom.timePanel.dataset.max);
  const from = state.filters.from ?? min;
  const to = state.filters.to ?? max;
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  dom.rangeLabel.textContent = `${fmt(from)} → ${fmt(to)}`;
}

/**
 * Rebuild a thumbnail grid only when its contents actually change. Photos
 * stream in one at a time, and blowing away the DOM on every update would
 * cancel every image that hadn't finished loading yet.
 */
function paintGrid(container, photos, limit) {
  const shown = photos.slice(0, limit);
  const signature = shown.map((p) => p.id).join('|');
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.innerHTML = shown.map(thumbHtml).join('') +
    (photos.length > shown.length ? `<div class="thumbgrid__more">+${photos.length - shown.length} more</div>` : '');
  bindThumbs(container);
}

function renderInView(photos) {
  dom.inviewPanel.hidden = !photos || !photos.length;
  if (dom.inviewPanel.hidden) return;
  dom.inviewCount.textContent = photos.length;
  paintGrid(dom.inview, photos, 120);
}

function renderUnlocated() {
  const photos = allFilteredPhotos().filter((p) => p.status === 'nolocation' || p.status === 'error');
  dom.unlocatedPanel.hidden = !photos.length;
  if (!photos.length) return;
  dom.unlocatedCount.textContent = photos.length;
  paintGrid(dom.unlocated, photos, 60);
}

function thumbHtml(photo) {
  const label = [photo.caption, photo.takenAt ? new Date(photo.takenAt).toLocaleDateString() : ''].filter(Boolean).join(' · ');
  return `<button class="thumb" data-id="${escapeAttr(photo.id)}" title="${escapeAttr(label || 'Photo')}">
      <img src="${escapeAttr(photo.thumbUrl)}" alt="" loading="lazy" decoding="async">
    </button>`;
}

function bindThumbs(container) {
  container.querySelectorAll('.thumb').forEach((btn) => {
    btn.addEventListener('click', () => openLightbox(btn.dataset.id));
    btn.addEventListener('mouseenter', () => {
      const photo = state.photos.get(btn.dataset.id);
      if (photo && photo.status === 'located' && !lightboxOpen()) focusHighlight(photo);
    });
  });
}

let highlightTimer = null;
function focusHighlight(photo) {
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    for (const [, marker] of mapView.markers) {
      const holds = marker.cluster.photos.some((p) => p.id === photo.id);
      marker.getElement()?.classList.toggle('is-hot', holds);
    }
  }, 40);
}

function buildBasemapControl() {
  const container = el('basemaps');
  container.innerHTML = basemapNames().map(({ key, label }) =>
    `<button type="button" data-basemap="${key}" class="${key === mapView.basemap ? 'is-active' : ''}">${label}</button>`).join('');
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-basemap]');
    if (!btn) return;
    setBasemap(btn.dataset.basemap);
    container.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
  });
}

// ---------------------------------------------------------------------------
// Auto-fit while photos stream in
// ---------------------------------------------------------------------------

function maybeFit() {
  if (mapView.userInteracted || !locatedPhotos().length) return;
  clearTimeout(fitScheduled);
  fitScheduled = setTimeout(() => {
    if (mapView.userInteracted) return;
    fitAll();
  }, 400);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

boot();
