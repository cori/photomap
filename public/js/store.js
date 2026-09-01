/**
 * Application state: albums, photos, filters, selection.
 *
 * Deliberately tiny — a plain object plus a subscribe() so views can redraw.
 * Every photo moves through: pending -> located | nolocation | error.
 */

const LISTENERS = new Map();
const EXIF_CACHE_KEY = 'photomap.exif.v2';
const ALBUMS_KEY = 'photomap.albums.v1';
const MAX_CACHE_ENTRIES = 8000;

export const state = {
  albums: new Map(),   // token -> {token, name, owner, count, located, visible}
  photos: new Map(),   // id -> photo
  order: [],           // photo ids, chronological
  filters: { albums: new Set(), from: null, to: null },
  selectedId: null,
  loading: 0,
};

export function on(event, fn) {
  if (!LISTENERS.has(event)) LISTENERS.set(event, new Set());
  LISTENERS.get(event).add(fn);
  return () => LISTENERS.get(event).delete(fn);
}

let pending = new Set();
let flushHandle = null;

export function emit(event, detail) {
  // Geo results arrive in a flurry; coalesce redraws into animation frames.
  pending.add(event);
  if (flushHandle) return;
  flushHandle = requestAnimationFrame(() => {
    const events = pending;
    pending = new Set();
    flushHandle = null;
    for (const name of events) {
      for (const fn of LISTENERS.get(name) || []) fn(detail);
    }
  });
}

export function emitNow(event, detail) {
  for (const fn of LISTENERS.get(event) || []) fn(detail);
}

// ---------------------------------------------------------------------------
// EXIF cache — coordinates never change, so re-reading them on every visit
// would just be re-downloading megabytes for nothing.
// ---------------------------------------------------------------------------

let exifCache = {};
try {
  exifCache = JSON.parse(localStorage.getItem(EXIF_CACHE_KEY) || '{}') || {};
} catch { exifCache = {}; }

let cacheDirty = false;
export function cachedExif(key) {
  return key ? exifCache[key] || null : null;
}

export function cacheExif(key, value) {
  if (!key) return;
  exifCache[key] = value;
  cacheDirty = true;
  scheduleCacheWrite();
}

let cacheTimer = null;
function scheduleCacheWrite() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      const keys = Object.keys(exifCache);
      if (keys.length > MAX_CACHE_ENTRIES) {
        for (const k of keys.slice(0, keys.length - MAX_CACHE_ENTRIES)) delete exifCache[k];
      }
      localStorage.setItem(EXIF_CACHE_KEY, JSON.stringify(exifCache));
    } catch { /* storage full or disabled — the app still works */ }
  }, 1500);
}

// ---------------------------------------------------------------------------
// Remembered albums
// ---------------------------------------------------------------------------

export function rememberedAlbums() {
  try {
    const list = JSON.parse(localStorage.getItem(ALBUMS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
  } catch { return []; }
}

export function rememberAlbum(token) {
  const list = rememberedAlbums().filter((t) => t !== token);
  list.unshift(token);
  try { localStorage.setItem(ALBUMS_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* ignore */ }
}

export function forgetAlbum(token) {
  try { localStorage.setItem(ALBUMS_KEY, JSON.stringify(rememberedAlbums().filter((t) => t !== token))); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function addAlbum(album) {
  state.albums.set(album.token, {
    token: album.token,
    name: album.name,
    owner: album.owner,
    count: album.photos.length,
    located: 0,
    visible: true,
  });
  state.filters.albums.add(album.token);
}

export function removeAlbum(token) {
  state.albums.delete(token);
  state.filters.albums.delete(token);
  for (const [id, photo] of state.photos) {
    if (photo.albumToken === token) state.photos.delete(id);
  }
  state.order = state.order.filter((id) => state.photos.has(id));
  if (state.selectedId && !state.photos.has(state.selectedId)) state.selectedId = null;
  emit('photos');
}

export function addPhotos(photos) {
  for (const photo of photos) {
    if (state.photos.has(photo.id)) continue;
    state.photos.set(photo.id, photo);
    state.order.push(photo.id);
  }
  sortOrder();
  emit('photos');
}

function sortOrder() {
  state.order.sort((a, b) => {
    const pa = state.photos.get(a);
    const pb = state.photos.get(b);
    const ta = Date.parse(pa.takenAt || pa.dateCreated || 0) || 0;
    const tb = Date.parse(pb.takenAt || pb.dateCreated || 0) || 0;
    return ta - tb || (pa.id < pb.id ? -1 : 1);
  });
}

export function applyExif(id, exif) {
  const photo = state.photos.get(id);
  if (!photo) return;
  photo.exif = exif;
  photo.takenAt = exif.takenAt || photo.dateCreated || null;
  if (exif.gps) {
    photo.lat = exif.gps.lat;
    photo.lon = exif.gps.lon;
    photo.status = 'located';
    const album = state.albums.get(photo.albumToken);
    if (album) album.located += 1;
  } else {
    photo.status = 'nolocation';
  }
  emit('photos');
}

export function markFailed(id, message) {
  const photo = state.photos.get(id);
  if (!photo) return;
  photo.status = 'error';
  photo.error = message;
  emit('photos');
}

export function select(id) {
  state.selectedId = id;
  emitNow('select', id);
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export function passesFilters(photo) {
  if (state.albums.size && !state.filters.albums.has(photo.albumToken)) return false;
  const { from, to } = state.filters;
  if (from || to) {
    const t = Date.parse(photo.takenAt || photo.dateCreated || '') || null;
    if (t === null) return false;
    if (from && t < from) return false;
    if (to && t > to) return false;
  }
  return true;
}

/** Photos that have coordinates and pass the current filters, chronological. */
export function locatedPhotos() {
  const out = [];
  for (const id of state.order) {
    const photo = state.photos.get(id);
    if (photo && photo.status === 'located' && passesFilters(photo)) out.push(photo);
  }
  return out;
}

export function allFilteredPhotos() {
  const out = [];
  for (const id of state.order) {
    const photo = state.photos.get(id);
    if (photo && passesFilters(photo)) out.push(photo);
  }
  return out;
}

export function counts() {
  let located = 0;
  let pendingCount = 0;
  let nolocation = 0;
  let failed = 0;
  for (const photo of state.photos.values()) {
    if (photo.status === 'located') located++;
    else if (photo.status === 'nolocation') nolocation++;
    else if (photo.status === 'error') failed++;
    else pendingCount++;
  }
  return { total: state.photos.size, located, pending: pendingCount, nolocation, failed };
}

export function dateRange() {
  let min = Infinity;
  let max = -Infinity;
  for (const photo of state.photos.values()) {
    const t = Date.parse(photo.takenAt || photo.dateCreated || '');
    if (!t) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return Number.isFinite(min) ? { min, max } : null;
}
