/**
 * Getting photos into the app: iCloud shared albums, direct image URLs and
 * local files. Each source produces the same photo shape, then a shared
 * pipeline reads EXIF to find out where each one was taken.
 */

import { parseExif } from './exif.js';
import { state, addAlbum, addPhotos, applyExif, markFailed, cachedExif, cacheExif, rememberAlbum, emit } from './store.js';

// EXIF lives in the first APP1 segment, which is capped at 64 KB — but it sits
// behind other segments, so grab a little more than that and stop.
const EXIF_BYTES = 192 * 1024;
const CONCURRENCY = 6;

export function parseAlbumInput(text) {
  return String(text || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isImageUrl(value) {
  return /^https?:\/\//i.test(value) && !/icloud\.com\/sharedalbum/i.test(value);
}

// ---------------------------------------------------------------------------
// iCloud shared albums
// ---------------------------------------------------------------------------

export async function loadSharedAlbum(input, { onStatus = () => {} } = {}) {
  onStatus(`Fetching album…`);
  const res = await fetch(`/api/album?url=${encodeURIComponent(input)}`);
  const data = await res.json().catch(() => ({ error: 'Album response was not JSON' }));
  if (!res.ok) throw new Error(data.error || `Album request failed (${res.status})`);
  if (state.albums.has(data.token)) throw new Error(`“${data.name}” is already loaded`);

  addAlbum(data);
  rememberAlbum(data.token);

  const photos = data.photos.map((p) => ({
    ...p,
    source: 'icloud',
    cacheKey: `icloud:${p.guid}`,
    takenAt: p.dateCreated,
    lat: null,
    lon: null,
    exif: null,
    status: 'pending',
  }));
  addPhotos(photos);
  onStatus(`Loaded “${data.name}” — reading locations…`);
  geolocateAll(photos, onStatus);
  return data;
}

// ---------------------------------------------------------------------------
// Direct image URLs
// ---------------------------------------------------------------------------

export function loadImageUrls(urls, { onStatus = () => {} } = {}) {
  const token = 'links';
  if (!state.albums.has(token)) {
    addAlbum({ token, name: 'Linked photos', owner: '', photos: [] });
  }
  const album = state.albums.get(token);
  const photos = urls.map((url, i) => {
    const proxied = `/api/image?url=${encodeURIComponent(url)}`;
    return {
      id: `link:${url}`,
      guid: url,
      albumToken: token,
      albumName: 'Linked photos',
      caption: decodeURIComponent(url.split('/').pop().split('?')[0] || `Photo ${i + 1}`),
      dateCreated: null,
      contributor: '',
      mediaType: 'photo',
      source: 'link',
      cacheKey: `link:${url}`,
      thumbUrl: proxied,
      fullUrl: proxied,
      lat: null,
      lon: null,
      exif: null,
      status: 'pending',
    };
  });
  album.count += photos.length;
  addPhotos(photos);
  geolocateAll(photos, onStatus);
  return photos;
}

// ---------------------------------------------------------------------------
// Local files
// ---------------------------------------------------------------------------

export async function loadFiles(fileList, { onStatus = () => {} } = {}) {
  const files = Array.from(fileList).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|heic|heif|tiff?|png)$/i.test(f.name));
  if (!files.length) throw new Error('No image files in that drop');

  const token = 'local';
  if (!state.albums.has(token)) addAlbum({ token, name: 'Local files', owner: '', photos: [] });
  const album = state.albums.get(token);

  const photos = files.map((file, i) => {
    const url = URL.createObjectURL(file);
    return {
      id: `local:${file.name}:${file.size}:${file.lastModified}:${i}`,
      guid: `${file.name}:${file.size}`,
      albumToken: token,
      albumName: 'Local files',
      caption: file.name,
      dateCreated: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      contributor: '',
      mediaType: 'photo',
      source: 'local',
      cacheKey: null, // object URLs die with the tab; caching them helps nobody
      thumbUrl: url,
      fullUrl: url,
      file,
      lat: null,
      lon: null,
      exif: null,
      status: 'pending',
    };
  });
  album.count += photos.length;
  addPhotos(photos);

  let done = 0;
  await runPool(photos, CONCURRENCY, async (photo) => {
    try {
      const head = await photo.file.slice(0, EXIF_BYTES).arrayBuffer();
      applyExif(photo.id, parseExif(head));
    } catch (err) {
      markFailed(photo.id, err.message);
    }
    onStatus(`Read ${++done} of ${photos.length} files`);
  });
  onStatus('');
  return photos;
}

// ---------------------------------------------------------------------------
// The shared "where was this taken" pipeline
// ---------------------------------------------------------------------------

async function geolocateAll(photos, onStatus) {
  state.loading += 1;
  emit('progress');

  const todo = [];
  for (const photo of photos) {
    const cached = cachedExif(photo.cacheKey);
    if (cached) applyExif(photo.id, cached);
    else todo.push(photo);
  }

  let done = 0;
  const total = todo.length;
  await runPool(todo, CONCURRENCY, async (photo) => {
    try {
      const exif = await readRemoteExif(photo);
      applyExif(photo.id, exif);
      cacheExif(photo.cacheKey, exif);
    } catch (err) {
      markFailed(photo.id, err.message || 'Could not read photo');
    }
    done += 1;
    if (done % 3 === 0 || done === total) onStatus(`Reading locations — ${done} of ${total}`);
  });

  state.loading -= 1;
  onStatus('');
  emit('progress');
}

async function readRemoteExif(photo) {
  if (photo.mediaType === 'video') return { gps: null, camera: {}, takenAt: photo.dateCreated };
  const head = await fetchHead(photo.fullUrl);
  return parseExif(head);
}

/**
 * Fetch just the front of an image. Apple's CDN honours Range and reflects
 * CORS, so this normally costs ~100 KB per photo instead of a full download.
 */
async function fetchHead(url) {
  const attempt = async (target, useRange) => {
    const res = await fetch(target, useRange ? { headers: { Range: `bytes=0-${EXIF_BYTES - 1}` } } : {});
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  };

  try {
    return await attempt(url, true);
  } catch (rangeError) {
    try {
      return await attempt(url, false);
    } catch {
      // Last resort: go through our own server (handles hosts without CORS).
      if (url.startsWith('/api/image')) throw rangeError;
      return attempt(`/api/image?url=${encodeURIComponent(url)}`, true);
    }
  }
}

/** Run `worker` over `items` with at most `limit` in flight. */
export async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Reverse geocoding (lazy: only for the photo being viewed)
// ---------------------------------------------------------------------------

const placeCache = new Map();

export async function placeFor(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (placeCache.has(key)) return placeCache.get(key);
  const promise = fetch(`/api/geocode?lat=${lat}&lon=${lon}`)
    .then((r) => (r.ok ? r.json() : { place: null }))
    .then((d) => d.place)
    .catch(() => null);
  placeCache.set(key, promise);
  return promise;
}
