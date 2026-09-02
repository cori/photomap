#!/usr/bin/env node
'use strict';

/**
 * photomap — a tiny zero-dependency server.
 *
 * It exists for one reason: Apple's shared-album JSON endpoints
 * (*.sharedstreams.icloud.com) do not send CORS headers, so a browser cannot
 * call them directly. Everything else the app does — downloading thumbnails,
 * range-fetching EXIF headers, full-size images — goes straight from the
 * browser to Apple's CDN, which *does* send CORS headers.
 *
 * Endpoints:
 *   GET /api/album?url=<shared album url or token>  -> normalized album JSON
 *   GET /api/image?url=<https url>                  -> image proxy (fallback / direct URLs)
 *   GET /api/geocode?lat=&lon=                      -> rate-limited Nominatim reverse geocode
 *   GET /*                                          -> static files from ./public
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// Optional writable directory. Only used to persist the geocode cache so a
// restart doesn't re-ask Nominatim for places it already knows.
const CACHE_DIR = process.env.CACHE_DIR || '';
const USER_AGENT = 'photomap/1.0 (self-hosted photo map; https://github.com/)';

// ---------------------------------------------------------------------------
// HTTP client (with optional HTTPS_PROXY CONNECT tunnelling)
// ---------------------------------------------------------------------------

function proxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  const p = new URL(proxyUrl);
  const agent = new https.Agent({ keepAlive: true });
  agent.createConnection = (options, callback) => {
    const headers = {};
    if (p.username) {
      const creds = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`;
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(creds).toString('base64');
    }
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${options.host}:${options.port || 443}`,
      headers,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        callback(new Error(`proxy CONNECT returned ${res.statusCode}`));
        return;
      }
      callback(null, tls.connect({ socket, servername: options.host }));
    });
    req.once('error', callback);
    req.end();
    return undefined;
  };
  return agent;
}

const AGENT = proxyAgent();

function fetchRaw(urlStr, { method = 'GET', headers = {}, body = null, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const opts = { method, headers: { 'user-agent': USER_AGENT, ...headers } };
    if (u.protocol === 'https:' && AGENT) opts.agent = AGENT;
    const req = mod.request(u, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// iCloud shared albums
// ---------------------------------------------------------------------------

/** Pull the album token out of anything the user is likely to paste. */
function parseAlbumToken(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  // Tokens come in two shapes: the short old style (B0n5Uzl7V3IW57) and a much
  // longer newer one that is base64url, so `-` and `_` are part of the token
  // and stopping at them silently yields a prefix that 404s.
  // https://www.icloud.com/sharedalbum/#TOKEN  (also /sharedalbum/TOKEN and /en-us/#TOKEN)
  const m = raw.match(/icloud\.com\/sharedalbum\/?(?:[a-z]{2}-[a-z]{2}\/)?#?([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  if (/^#?[A-Za-z0-9_-]{8,}$/.test(raw)) return raw.replace(/^#/, '');
  return null;
}

const partitionCache = new Map(); // token -> host

async function streamPost(host, token, endpoint, payload) {
  const url = `https://${host}/${token}/sharedstreams/${endpoint}`;
  return fetchRaw(url, {
    method: 'POST',
    // text/plain keeps this a "simple" request; Apple accepts a JSON body either way.
    headers: { 'content-type': 'text/plain', origin: 'https://www.icloud.com', referer: 'https://www.icloud.com/' },
    body: JSON.stringify(payload),
  });
}

/**
 * Apple shards shared albums across numbered partitions. Any partition will
 * answer with HTTP 330 + the correct host, so we ask one and follow.
 */
async function resolvePartition(token) {
  if (partitionCache.has(token)) return partitionCache.get(token);
  let host = 'p01-sharedstreams.icloud.com';
  for (let hop = 0; hop < 4; hop++) {
    const res = await streamPost(host, token, 'webstream', { streamCtag: null });
    if (res.status === 330) {
      let next = res.headers['x-apple-mme-host'];
      if (!next) {
        try {
          next = JSON.parse(res.body.toString('utf8'))['X-Apple-MMe-Host'];
        } catch { /* fall through */ }
      }
      if (!next || next === host) throw httpError(502, 'iCloud redirect loop while locating album');
      host = next;
      continue;
    }
    if (res.status === 200) {
      partitionCache.set(token, host);
      return host;
    }
    if (res.status === 404) throw httpError(404, 'Album not found. The link may be wrong, or sharing was turned off.');
    throw httpError(502, `iCloud responded ${res.status} while locating the album`);
  }
  throw httpError(502, 'Too many iCloud redirects while locating the album');
}

async function streamJson(host, token, endpoint, payload) {
  const res = await streamPost(host, token, endpoint, payload);
  if (res.status !== 200) throw httpError(502, `iCloud ${endpoint} responded ${res.status}`);
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw httpError(502, `iCloud ${endpoint} returned malformed JSON`);
  }
}

function derivativeUrl(items, checksum) {
  const item = checksum && items[checksum];
  if (!item) return null;
  return `https://${item.url_location}${item.url_path}`;
}

/** Sort an asset's derivatives into a thumbnail and a full-size version. */
function pickDerivatives(photo, items) {
  const entries = Object.entries(photo.derivatives || {}).map(([key, d]) => ({
    key,
    width: Number(d.width) || 0,
    height: Number(d.height) || 0,
    fileSize: Number(d.fileSize) || 0,
    checksum: d.checksum,
    url: derivativeUrl(items, d.checksum),
    isPoster: !/^\d+$/.test(key),
  })).filter((d) => d.url);

  if (!entries.length) return { thumb: null, full: null };

  const stills = entries.filter((d) => d.isPoster || d.height <= 6000);
  const pool = stills.length ? stills : entries;
  const byPixels = [...pool].sort((a, b) => (a.width * a.height) - (b.width * b.height));
  const thumb = byPixels[0];
  const full = byPixels[byPixels.length - 1];
  return { thumb, full };
}

async function loadAlbum(token) {
  const host = await resolvePartition(token);
  const stream = await streamJson(host, token, 'webstream', { streamCtag: null });
  const photos = Array.isArray(stream.photos) ? stream.photos : [];

  // Asset URLs are signed and expire, so they come from a second call.
  const guids = photos.map((p) => p.photoGuid).filter(Boolean);
  const items = {};
  for (let i = 0; i < guids.length; i += 100) {
    const batch = await streamJson(host, token, 'webasseturls', { photoGuids: guids.slice(i, i + 100) });
    Object.assign(items, batch.items || {});
  }

  const normalized = [];
  for (const p of photos) {
    const { thumb, full } = pickDerivatives(p, items);
    if (!thumb && !full) continue;
    normalized.push({
      id: `${token}:${p.photoGuid}`,
      guid: p.photoGuid,
      albumToken: token,
      albumName: stream.streamName || 'Shared album',
      caption: p.caption || '',
      dateCreated: p.dateCreated || p.batchDateCreated || null,
      contributor: [p.contributorFirstName, p.contributorLastName].filter(Boolean).join(' '),
      mediaType: p.mediaAssetType === 'video' ? 'video' : 'photo',
      width: Number(p.width) || null,
      height: Number(p.height) || null,
      thumbUrl: (thumb || full).url,
      fullUrl: (full || thumb).url,
      fullWidth: (full || thumb).width,
      fullHeight: (full || thumb).height,
      fullBytes: (full || thumb).fileSize,
    });
  }

  return {
    token,
    name: stream.streamName || 'Shared album',
    owner: [stream.userFirstName, stream.userLastName].filter(Boolean).join(' '),
    host,
    fetchedAt: new Date().toISOString(),
    photos: normalized,
  };
}

// ---------------------------------------------------------------------------
// Reverse geocoding (Nominatim, serialised to stay inside their usage policy)
// ---------------------------------------------------------------------------

const geocodeCache = new Map();
let geocodeChain = Promise.resolve();
let lastGeocodeAt = 0;

const geocodeCacheFile = CACHE_DIR ? path.join(CACHE_DIR, 'geocode-cache.json') : '';
if (geocodeCacheFile) {
  try {
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(geocodeCacheFile, 'utf8')))) {
      geocodeCache.set(key, value);
    }
    console.log(`[photomap] loaded ${geocodeCache.size} cached places from ${geocodeCacheFile}`);
  } catch {
    // No cache yet, or it's unreadable — we'll write a fresh one.
  }
}

let cacheWriteTimer = null;
function persistGeocodeCache() {
  if (!geocodeCacheFile || cacheWriteTimer) return;
  cacheWriteTimer = setTimeout(async () => {
    cacheWriteTimer = null;
    try {
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
      await fs.promises.writeFile(geocodeCacheFile, JSON.stringify(Object.fromEntries(geocodeCache)));
    } catch (err) {
      console.warn('[photomap] could not write geocode cache:', err.message);
    }
  }, 5000);
}

function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key));

  geocodeChain = geocodeChain.then(async () => {
    if (geocodeCache.has(key)) return geocodeCache.get(key);
    const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lon}`;
    let place = null;
    try {
      const res = await fetchRaw(url, { headers: { accept: 'application/json' }, timeout: 12000 });
      if (res.status === 200) {
        const data = JSON.parse(res.body.toString('utf8'));
        const a = data.address || {};
        const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || null;
        const region = a.state || a.province || null;
        place = {
          label: [locality, region, a.country].filter(Boolean).join(', ') || data.display_name || null,
          locality,
          region,
          country: a.country || null,
        };
      }
    } catch {
      place = null;
    }
    geocodeCache.set(key, place);
    persistGeocodeCache();
    return place;
  }).catch(() => null);

  return geocodeChain;
}

// ---------------------------------------------------------------------------
// Image proxy (CORS fallback + user-supplied direct image URLs)
// ---------------------------------------------------------------------------

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Refuse to proxy anything that resolves inside the local network. */
async function assertPublicTarget(u) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw httpError(400, 'Only http(s) URLs can be proxied');
  const literal = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) throw httpError(403, 'Refusing to proxy a private address');
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(u.hostname, { all: true });
  } catch {
    throw httpError(400, `Cannot resolve ${u.hostname}`);
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) throw httpError(403, 'Refusing to proxy a private address');
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  let data;
  try {
    data = await fs.promises.readFile(filePath);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(data);
  return undefined;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

async function handleAlbum(req, res, url) {
  const token = parseAlbumToken(url.searchParams.get('url') || url.searchParams.get('token'));
  if (!token) throw httpError(400, 'Could not find an album token in that link');
  const album = await loadAlbum(token);
  sendJson(res, 200, album);
}

async function handleGeocode(req, res, url) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw httpError(400, 'lat and lon are required');
  const place = await reverseGeocode(lat, lon);
  sendJson(res, 200, { place });
}

async function handleImage(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) throw httpError(400, 'url is required');
  let u;
  try {
    u = new URL(target);
  } catch {
    throw httpError(400, 'Malformed url');
  }
  await assertPublicTarget(u);

  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  const upstream = await fetchRaw(u.toString(), { headers, timeout: 60000 });
  const type = upstream.headers['content-type'] || 'application/octet-stream';
  if (upstream.status >= 400) throw httpError(upstream.status === 404 ? 404 : 502, `Upstream responded ${upstream.status}`);
  res.writeHead(upstream.status, {
    'content-type': type,
    'content-length': upstream.body.length,
    'access-control-allow-origin': '*',
    'cache-control': 'private, max-age=600',
    ...(upstream.headers['content-range'] ? { 'content-range': upstream.headers['content-range'] } : {}),
  });
  res.end(upstream.body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, albums: partitionCache.size, places: geocodeCache.size });
    if (url.pathname === '/api/album') return await handleAlbum(req, res, url);
    if (url.pathname === '/api/geocode') return await handleGeocode(req, res, url);
    if (url.pathname === '/api/image') return await handleImage(req, res, url);
    if (url.pathname.startsWith('/api/')) throw httpError(404, 'Unknown endpoint');
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error(`[photomap] ${req.method} ${req.url} ->`, err);
    return sendJson(res, status, { error: err && err.message ? err.message : 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`photomap running at http://${HOST}:${PORT}`);
  if (AGENT) console.log('[photomap] using HTTPS_PROXY for outbound requests');
  if (CACHE_DIR) console.log(`[photomap] geocode cache: ${geocodeCacheFile}`);
});
