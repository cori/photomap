/**
 * Wiring: input handling, the side panel, filters and the map/lightbox hookup.
 */

import { state, on, emit, emitNow, counts, dateRange, locatedPhotos, allFilteredPhotos, removeAlbum, forgetAlbum, rememberedAlbums } from './store.js';
import { loadSharedAlbum, loadFiles, loadImageUrls, parseAlbumInput, isImageUrl } from './sources.js';
import { initMap, mapView, render, fitAll, focusPhoto, setBasemap, basemapNames, setRouteVisible, closeSpider } from './mapview.js';
import { initLightbox, open as openLightbox, isOpen as lightboxOpen } from './lightbox.js';
import { encodeView, decodeView, copyText, isLinkablePhoto, DEFAULT_BASEMAP } from './share.js';

const SAMPLE = 'https://www.icloud.com/sharedalbum/#B0n5Uzl7V3IW57';
const MOBILE_MQ = '(max-width: 760px)';

const el = (id) => document.getElementById(id);
const dom = {};
let fitScheduled = null;
// While restoring, the map moves and filters change before the albums exist.
// Writing the URL from that half-built state would erase the very link we're
// reading, so hold the writes until the restore finishes.
let restoring = false;
let isMobile = false;
let desktopSidebarOpen = true;

function boot() {
  cacheDom();
  initMap(dom.map);
  initLightbox(dom.lightbox, {
    onShowOnMap: () => {},
    onShare: (photo) => share(photo.guid),
  });
  buildBasemapControl();
  wireEvents();

  on('photos', () => { renderAlbums(); renderStats(); renderTimeRange(); renderUnlocated(); maybeFit(); });
  on('progress', renderStats);
  on('viewport', renderInView);
  on('open', (id) => {
    if (isMobile) setSidebarOpen(false);
    openLightbox(id);
  });
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
  dom.share = el('share');
  dom.sidebarBackdrop = el('sidebar-backdrop');
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

  // --- Sidebar open / close ---
  el('sidebar-toggle').addEventListener('click', () => {
    toggleSidebar();
  });
  el('sidebar-open').addEventListener('click', () => {
    setSidebarOpen(true);
  });
  el('sidebar-close').addEventListener('click', () => {
    setSidebarOpen(false);
  });
  dom.sidebarBackdrop.addEventListener('click', () => {
    setSidebarOpen(false);
  });

  // On mobile, close the sidebar when the user starts interacting with the map.
  mapView.map.on('movestart', () => {
    if (isMobile && !document.body.classList.contains('is-collapsed')) {
      setSidebarOpen(false);
    }
  });

  // Track mobile breakpoint so we can auto-collapse.
  const mql = window.matchMedia(MOBILE_MQ);
  isMobile = mql.matches;
  if (isMobile) setSidebarOpen(false);
  mql.addEventListener('change', (e) => {
    const wasMobile = isMobile;
    isMobile = e.matches;
    if (isMobile) {
      // Entering mobile: remember the desktop state and collapse.
      desktopSidebarOpen = !document.body.classList.contains('is-collapsed');
      setSidebarOpen(false);
    } else if (wasMobile) {
      // Returning to desktop: restore whatever the user had before.
      setSidebarOpen(desktopSidebarOpen);
    }
  });

  el('route-toggle').addEventListener('change', (e) => setRouteVisible(e.target.checked));
  dom.share.addEventListener('click', () => share(null));

  // The address bar tracks the view, so copying it is as good as Share.
  mapView.map.on('moveend zoomend', syncUrl);
  on('filters', syncUrl);

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

function setSidebarOpen(open) {
  document.body.classList.toggle('is-collapsed', !open);
  dom.sidebarBackdrop.hidden = !open || !isMobile;
  setTimeout(() => mapView.map.invalidateSize(), 220);
}

function toggleSidebar() {
  setSidebarOpen(document.body.classList.contains('is-collapsed'));
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
// Shareable URL — see share.js for the fragment format
// ---------------------------------------------------------------------------

/** Album tokens only — local files and pasted URLs can't travel in a link. */
function shareableTokens() {
  return [...state.albums.keys()].filter((t) => t !== 'local' && t !== 'links');
}

/** The current view, as the thing share.js serialises. */
function currentView({ photo = null } = {}) {
  const albums = shareableTokens();
  const center = mapView.map ? mapView.map.getCenter() : null;
  const visible = albums.filter((t) => state.filters.albums.has(t));
  return {
    albums,
    center: center ? { lat: center.lat, lng: center.lng } : null,
    zoom: mapView.map ? mapView.map.getZoom() : null,
    basemap: mapView.basemap,
    photo,
    dates: { from: state.filters.from, to: state.filters.to },
    visible,
  };
}

/**
 * Keep the address bar shareable at all times, so copying from it is as good
 * as pressing Share. replaceState rather than pushState: panning a map should
 * not fill up the back button, and it doesn't fire hashchange, so this can't
 * loop back into restoreFromUrl.
 */
function syncUrl() {
  if (restoring) return;
  if (!shareableTokens().length) {
    if (location.hash) history.replaceState(null, '', location.pathname);
    return;
  }
  const hash = encodeView(currentView());
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname);
}

/** The link the Share button hands out. */
export function shareUrl({ photo = null } = {}) {
  return `${location.origin}${location.pathname}${encodeView(currentView({ photo }))}`;
}

async function share(photo) {
  if (!shareableTokens().length) {
    showHint('Load a shared album first — local files can’t travel in a link.');
    return;
  }
  // A local file or pasted URL has no linkable id, so the link can only carry
  // the view. Say so rather than handing over a link that quietly drops the
  // photo the button was pressed on.
  const droppedPhoto = photo && !isLinkablePhoto(photo);
  const ok = await copyText(shareUrl({ photo }));
  if (!ok) {
    showHint(shareUrl({ photo }));
    return;
  }
  showHint(droppedPhoto
    ? 'Link copied to this view — this photo isn’t from a shared album, so it can’t be linked directly.'
    : 'Link copied — it opens this exact view.');
}

/**
 * A "hotlink" is a shared URL that carries specific framing — a map position,
 * a photo to open, or a date filter. The recipient wants to see the shared
 * view, not the sidebar, so we collapse it automatically. A plain
 * `#album=TOKEN` with no framing is just "load this album", not a deep link,
 * so the sidebar stays as-is.
 */
function isHotlink(view) {
  return !!(view.center || view.photo || view.dates);
}

async function restoreFromUrl() {
  const view = decodeView(location.hash);
  if (isHotlink(view)) setSidebarOpen(false);
  restoring = true;
  try {
    await restoreView(view);
  } finally {
    restoring = false;
    syncUrl();
  }
}

async function restoreView(view) {

  // Apply the map view first: it doesn't depend on photos, and setting it now
  // stops the auto-fit from stealing the framing the link asked for.
  applyView(view);

  const missing = view.albums.filter((t) => !state.albums.has(t));
  if (missing.length) {
    await addFromText(missing.join(' '));
    applyView(view);          // albums finished loading; re-assert framing
    if (view.photo) openPhotoByGuid(view.photo);
    return;
  }

  if (view.photo) openPhotoByGuid(view.photo);

  if (!view.albums.length && !state.albums.size) {
    const remembered = rememberedAlbums();
    if (remembered.length) {
      dom.input.value = `https://www.icloud.com/sharedalbum/#${remembered[0]}`;
      showHint('Last album is in the box — press Add to reload it.');
    }
  }
}

function applyView(view) {
  // No b= means the sender was on the default, not "keep whatever I'm on":
  // pasting a link mid-session used to leave the recipient's own basemap in
  // place, showing them a different map from the one that was shared.
  const basemap = view.basemap || DEFAULT_BASEMAP;
  if (basemap !== mapView.basemap) setBasemap(basemap);
  // Read the key back rather than reusing the requested one: setBasemap falls
  // back for an unknown b=, and highlighting the requested value would leave
  // no button lit at all.
  document.querySelectorAll('[data-basemap]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.basemap === mapView.basemap));

  if (view.dates) {
    state.filters.from = view.dates.from;
    state.filters.to = view.dates.to;
    emitNow('filters');
  }

  // Array, not truthy-length: [] means "untick everything", and skipping it
  // left the recipient with filters the link didn't ask for.
  if (Array.isArray(view.visible)) {
    for (const token of state.albums.keys()) {
      if (token === 'local' || token === 'links') continue;
      if (view.visible.includes(token)) state.filters.albums.add(token);
      else state.filters.albums.delete(token);
    }
    emitNow('filters');
    renderAlbums();
  }

  if (view.center && Number.isFinite(view.zoom)) {
    // Counts as the viewer choosing a view, so streaming photos don't refit.
    mapView.userInteracted = true;
    mapView.map.setView([view.center.lat, view.center.lng], view.zoom, { animate: false });
  }
  render();
}

/**
 * Links carry a photo GUID rather than the internal id, so it stays stable
 * and readable. The photo exists as soon as the album JSON lands, well before
 * its EXIF does — the viewer fills the location in when it arrives.
 */
function openPhotoByGuid(guid) {
  for (const photo of state.photos.values()) {
    if (photo.guid === guid) {
      openLightbox(photo.id);
      return true;
    }
  }
  showHint('That photo isn’t in the loaded album any more.');
  return false;
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
  syncRangeInputs();
  updateRangeLabel();
}

/**
 * Move the sliders to match the active filter. Needed when a link arrives with
 * a date range: the filter is set before any photo (and so any date span)
 * exists, so the thumbs can only be placed once the span is known.
 */
function syncRangeInputs() {
  if (document.activeElement === dom.rangeFrom || document.activeElement === dom.rangeTo) return;
  const min = Number(dom.timePanel.dataset.min);
  const max = Number(dom.timePanel.dataset.max);
  const span = max - min;
  if (!span) return;
  const pos = (t) => Math.min(1000, Math.max(0, Math.round(((t - min) / span) * 1000)));
  dom.rangeFrom.value = state.filters.from ? pos(state.filters.from) : 0;
  dom.rangeTo.value = state.filters.to ? pos(state.filters.to) : 1000;
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
    syncUrl();
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
