/**
 * Full-screen photo viewer: the image, everything the EXIF knows about where
 * and how it was taken, and a small map inset showing the spot (with a cone
 * for which way the camera was pointing).
 */

import { formatDms } from './exif.js';
import { state, allFilteredPhotos, select, on } from './store.js';
import { placeFor } from './sources.js';
import { focusPhoto } from './mapview.js';

const L = window.L;

const dom = {};
let navList = [];
let index = -1;
let insetMap = null;
let insetMarker = null;

export function initLightbox(root, { onShowOnMap, onShare } = {}) {
  root.innerHTML = `
    <div class="lb__backdrop" data-close></div>
    <div class="lb__panel" role="dialog" aria-modal="true" aria-label="Photo">
      <button class="lb__close" data-close title="Close (Esc)" aria-label="Close">&times;</button>
      <button class="lb__nav lb__nav--prev" data-prev title="Previous (←)" aria-label="Previous photo">&#8249;</button>
      <button class="lb__nav lb__nav--next" data-next title="Next (→)" aria-label="Next photo">&#8250;</button>
      <figure class="lb__stage">
        <img class="lb__img" alt="">
        <div class="lb__spinner" hidden></div>
      </figure>
      <aside class="lb__meta">
        <header class="lb__head">
          <h2 class="lb__title"></h2>
          <p class="lb__subtitle"></p>
        </header>
        <div class="lb__inset"></div>
        <dl class="lb__facts"></dl>
        <div class="lb__actions">
          <button class="btn btn--ghost" data-share>Copy link</button>
          <button class="btn btn--ghost" data-show-on-map>Show on map</button>
          <a class="btn btn--ghost" data-osm target="_blank" rel="noreferrer noopener">OpenStreetMap</a>
          <a class="btn btn--ghost" data-download target="_blank" rel="noreferrer noopener">Open original</a>
        </div>
        <p class="lb__position"></p>
      </aside>
    </div>`;

  dom.root = root;
  dom.img = root.querySelector('.lb__img');
  dom.spinner = root.querySelector('.lb__spinner');
  dom.title = root.querySelector('.lb__title');
  dom.subtitle = root.querySelector('.lb__subtitle');
  dom.facts = root.querySelector('.lb__facts');
  dom.inset = root.querySelector('.lb__inset');
  dom.position = root.querySelector('.lb__position');
  dom.osm = root.querySelector('[data-osm]');
  dom.download = root.querySelector('[data-download]');
  dom.showOnMap = root.querySelector('[data-show-on-map]');
  dom.share = root.querySelector('[data-share]');

  dom.share.addEventListener('click', () => {
    const photo = current();
    if (photo && onShare) onShare(photo);
  });

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
    else if (e.target.closest('[data-prev]')) step(-1);
    else if (e.target.closest('[data-next]')) step(1);
  });

  dom.showOnMap.addEventListener('click', () => {
    const photo = current();
    close();
    if (photo) {
      focusPhoto(photo, { zoom: 16 });
      (onShowOnMap || (() => {}))(photo);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
  });
}

export function isOpen() {
  return dom.root && !dom.root.hidden;
}

export function open(photoId) {
  navList = allFilteredPhotos();
  index = navList.findIndex((p) => p.id === photoId);
  if (index < 0) {
    const photo = state.photos.get(photoId);
    if (!photo) return;
    navList = [photo];
    index = 0;
  }
  dom.root.hidden = false;
  document.body.classList.add('is-modal');
  show();
}

export function close() {
  if (!dom.root || dom.root.hidden) return;
  dom.root.hidden = true;
  document.body.classList.remove('is-modal');
}

function current() {
  return navList[index] || null;
}

function step(delta) {
  if (!navList.length) return;
  index = (index + delta + navList.length) % navList.length;
  show();
}

function show() {
  const photo = current();
  if (!photo) return;
  select(photo.id);

  dom.spinner.hidden = false;
  dom.img.classList.remove('is-ready');
  dom.img.src = photo.fullUrl;
  dom.img.alt = photo.caption || 'Photo';
  dom.img.onload = () => { dom.spinner.hidden = true; dom.img.classList.add('is-ready'); };
  dom.img.onerror = () => { dom.spinner.hidden = true; };

  dom.title.textContent = photo.caption || describeWhen(photo) || 'Photo';
  dom.subtitle.textContent = [
    photo.caption ? describeWhen(photo) : null,
    photo.albumName,
    photo.contributor,
  ].filter(Boolean).join(' · ');

  dom.position.textContent = `${index + 1} of ${navList.length}`;
  dom.download.href = photo.fullUrl;

  renderedStatus = photo.status;
  renderFacts(photo);
  renderInset(photo);
  preload(index + 1);
  preload(index - 1);
}

function preload(i) {
  const photo = navList[(i + navList.length) % navList.length];
  if (photo) { const img = new Image(); img.src = photo.fullUrl; }
}

function describeWhen(photo) {
  const iso = photo.takenAt || photo.dateCreated;
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = photo.exif?.takenAtOffset;
  const text = date.toLocaleString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  return offset ? `${text} (UTC${offset})` : text;
}

function renderFacts(photo) {
  const gps = photo.exif?.gps;
  const camera = photo.exif?.camera || {};
  const rows = [];

  if (gps) {
    rows.push(['Coordinates', `${formatDms(gps.lat, 'lat')} ${formatDms(gps.lon, 'lon')}`, 'copy', `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}`]);
    rows.push(['Decimal', `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}`]);
    if (typeof gps.altitude === 'number') rows.push(['Altitude', `${gps.altitude.toFixed(0)} m`]);
    if (typeof gps.heading === 'number') rows.push(['Facing', `${gps.heading.toFixed(0)}° ${compass(gps.heading)} (${gps.headingRef})`]);
    if (typeof gps.speedKmh === 'number' && gps.speedKmh > 0.5) rows.push(['Moving at', `${gps.speedKmh.toFixed(1)} km/h`]);
    if (typeof gps.accuracy === 'number') rows.push(['GPS accuracy', `±${gps.accuracy.toFixed(0)} m`]);
    rows.push(['Place', '<span class="lb__place">Looking up…</span>', 'html']);
  } else if (photo.status === 'nolocation') {
    rows.push(['Location', 'No GPS data in this photo']);
  } else if (photo.status === 'error') {
    rows.push(['Location', `Could not read: ${photo.error || 'unknown error'}`]);
  } else {
    rows.push(['Location', 'Reading…']);
  }

  const cameraName = [camera.make, camera.model].filter(Boolean).join(' ');
  if (cameraName) rows.push(['Camera', cameraName]);
  if (camera.lens) rows.push(['Lens', camera.lens]);
  const exposure = [
    camera.focalLength ? `${camera.focalLength.toFixed(0)}mm` : null,
    camera.fNumber ? `ƒ/${camera.fNumber.toFixed(1)}` : null,
    camera.exposureTime ? formatShutter(camera.exposureTime) : null,
    camera.iso ? `ISO ${camera.iso}` : null,
  ].filter(Boolean).join(' · ');
  if (exposure) rows.push(['Exposure', exposure]);
  if (photo.fullWidth && photo.fullHeight) rows.push(['Size', `${photo.fullWidth} × ${photo.fullHeight}`]);

  dom.facts.innerHTML = rows.map(([label, value, kind, copyValue]) => {
    const body = kind === 'html' ? value : escapeHtml(value);
    const copy = kind === 'copy'
      ? `<button class="lb__copy" data-copy="${escapeHtml(copyValue)}" title="Copy coordinates">copy</button>`
      : '';
    return `<div class="lb__fact"><dt>${escapeHtml(label)}</dt><dd>${body}${copy}</dd></div>`;
  }).join('');

  dom.facts.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1400);
      } catch { btn.textContent = 'press ⌘C'; }
    });
  });

  if (gps) {
    dom.osm.href = `https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lon}#map=15/${gps.lat}/${gps.lon}`;
    dom.osm.hidden = false;
    dom.showOnMap.hidden = false;
    const token = photo.id;
    placeFor(gps.lat, gps.lon).then((place) => {
      if (current()?.id !== token) return;
      const el = dom.facts.querySelector('.lb__place');
      if (el) el.textContent = place?.label || 'Unknown';
    });
  } else {
    dom.osm.hidden = true;
    dom.showOnMap.hidden = true;
  }
}

// A deep link opens a photo the instant the album JSON lands, which is well
// before its EXIF has been read. Refresh the panel when it catches up.
let renderedStatus = null;
on('photos', () => {
  if (!isOpen()) return;
  const photo = current();
  if (!photo || photo.status === renderedStatus) return;
  renderedStatus = photo.status;
  renderFacts(photo);
  renderInset(photo);
});

function renderInset(photo) {
  const gps = photo.exif?.gps;
  if (!gps) {
    dom.inset.hidden = true;
    return;
  }
  dom.inset.hidden = false;

  if (!insetMap) {
    insetMap = L.map(dom.inset, {
      zoomControl: false, attributionControl: false, dragging: false,
      scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
      keyboard: false, touchZoom: false, tap: false,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(insetMap);
  }

  insetMap.setView([gps.lat, gps.lon], 13, { animate: false });
  if (insetMarker) insetMarker.remove();
  const heading = typeof gps.heading === 'number' ? gps.heading : null;
  insetMarker = L.marker([gps.lat, gps.lon], {
    interactive: false,
    icon: L.divIcon({
      className: 'inset-pin-wrap',
      html: `<div class="inset-pin">
               ${heading === null ? '' : `<span class="inset-pin__cone" style="transform:rotate(${heading}deg)"></span>`}
               <span class="inset-pin__dot"></span>
             </div>`,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    }),
  }).addTo(insetMap);

  requestAnimationFrame(() => insetMap.invalidateSize({ animate: false }));
}

function compass(deg) {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function formatShutter(seconds) {
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
