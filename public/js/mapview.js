/**
 * The map: basemaps, photo pins, clustering, spiderfy and the trip route.
 *
 * Clustering is recomputed from scratch on every view change (cheap for album
 * sized data) but markers are reused by cluster id so the DOM stays calm.
 */

import { clusterPhotos, spiderPositions } from './cluster.js';
import { locatedPhotos, state, on, emitNow } from './store.js';

const L = window.L;
const CLUSTER_RADIUS = 58;
const MAX_ZOOM = 19;

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Every source here is usable without an API key. "Dark" is plain OSM under a
// CSS filter (see .leaflet-tile-pane in app.css) — the keyless dark basemaps
// have all grown watermarks.
const BASEMAPS = {
  dark: {
    label: 'Dark',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: OSM_ATTRIBUTION },
  },
  light: {
    label: 'Light',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: OSM_ATTRIBUTION },
  },
  terrain: {
    label: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 17, subdomains: 'abc', attribution: `${OSM_ATTRIBUTION}, <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)` },
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
  },
};

export const mapView = {
  map: null,
  markers: new Map(),
  layer: null,
  routeLayer: null,
  spiderLayer: null,
  spiderOpen: null,
  basemapLayer: null,
  basemap: 'light',
  showRoute: true,
  renderHandle: null,
  // Once the viewer has chosen a view of their own, stop auto-fitting to
  // photos that are still streaming in.
  userInteracted: false,
};

export function initMap(container) {
  const map = L.map(container, {
    zoomControl: false,
    worldCopyJump: true,
    maxZoom: MAX_ZOOM,
    preferCanvas: true,
  }).setView([30, -20], 2);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: true, metric: true }).addTo(map);

  mapView.map = map;
  mapView.layer = L.layerGroup().addTo(map);
  mapView.routeLayer = L.layerGroup().addTo(map);
  mapView.spiderLayer = L.layerGroup().addTo(map);
  setBasemap(mapView.basemap);

  map.on('zoomstart', closeSpider);
  map.on('moveend zoomend', scheduleRender);
  map.on('dragstart wheel dblclick', () => { mapView.userInteracted = true; });
  map.on('click', () => { closeSpider(); emitNow('mapclick'); });

  on('photos', scheduleRender);
  on('filters', scheduleRender);

  return map;
}

export function setBasemap(name) {
  const spec = BASEMAPS[name] || BASEMAPS.dark;
  if (mapView.basemapLayer) mapView.map.removeLayer(mapView.basemapLayer);
  mapView.basemap = name;
  mapView.basemapLayer = L.tileLayer(spec.url, { ...spec.options, detectRetina: false }).addTo(mapView.map);
  mapView.basemapLayer.setZIndex(0);
  document.body.dataset.basemap = name;
}

export function basemapNames() {
  return Object.entries(BASEMAPS).map(([key, spec]) => ({ key, label: spec.label }));
}

export function setRouteVisible(visible) {
  mapView.showRoute = visible;
  renderRoute();
}

function scheduleRender() {
  if (mapView.renderHandle) return;
  mapView.renderHandle = requestAnimationFrame(() => {
    mapView.renderHandle = null;
    render();
  });
}

export function render() {
  const map = mapView.map;
  if (!map) return;
  const photos = locatedPhotos();
  const zoom = map.getZoom();

  const project = (photo) => map.project([photo.lat, photo.lon], zoom);
  const clusters = clusterPhotos(photos, project, CLUSTER_RADIUS);

  // Only build markers for what's on screen (plus a margin for smooth panning).
  const bounds = map.getBounds().pad(0.35);
  const visible = clusters.filter((c) => bounds.contains(unproject(c, zoom)));

  const seen = new Set();
  for (const cluster of visible) {
    seen.add(cluster.id);
    let marker = mapView.markers.get(cluster.id);
    const latlng = unproject(cluster, zoom);
    if (!marker) {
      marker = L.marker(latlng, {
        icon: buildIcon(cluster),
        riseOnHover: true,
        keyboard: false,
        zIndexOffset: cluster.count > 1 ? 200 : 0,
      });
      // Markers outlive a single render, so read the cluster off the marker
      // rather than closing over the one it was created with.
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onClusterClick(marker.cluster);
      });
      marker.addTo(mapView.layer);
      mapView.markers.set(cluster.id, marker);
    } else {
      marker.setLatLng(latlng);
    }
    marker.cluster = cluster;
  }

  for (const [id, marker] of mapView.markers) {
    if (!seen.has(id)) {
      mapView.layer.removeLayer(marker);
      mapView.markers.delete(id);
    }
  }

  renderRoute();
  paintSelection();
  emitNow('viewport', photosInView());
}

function unproject(cluster, zoom) {
  return mapView.map.unproject([cluster.x, cluster.y], zoom);
}

function photosInView() {
  const bounds = mapView.map.getBounds();
  return locatedPhotos().filter((p) => bounds.contains([p.lat, p.lon]));
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

function buildIcon(cluster) {
  const size = cluster.count === 1 ? 54 : Math.min(84, 54 + Math.log2(cluster.count) * 9);
  const html = cluster.count === 1 ? singleHtml(cluster) : clusterHtml(cluster, size);
  return L.divIcon({
    html,
    className: 'pin-wrap',
    iconSize: [size, size + 10],
    iconAnchor: [size / 2, size + 10],
  });
}

function thumb(photo) {
  // Eager: markers live in a transformed layer where lazy loading is unreliable.
  return `<img class="pin__img" src="${escapeAttr(photo.thumbUrl)}" alt="" decoding="async">`;
}

function singleHtml(cluster) {
  const photo = cluster.cover;
  return `<div class="pin pin--single" data-photo="${escapeAttr(photo.id)}" title="${escapeAttr(photoTitle(photo))}">
      <div class="pin__frame">${thumb(photo)}</div>
      <span class="pin__stem"></span>
    </div>`;
}

function clusterHtml(cluster, size) {
  return `<div class="pin pin--cluster" style="--pin-size:${Math.round(size)}px" title="${escapeAttr(clusterTitle(cluster))}">
      <span class="pin__card pin__card--back"></span>
      <span class="pin__card pin__card--mid"></span>
      <div class="pin__frame">${thumb(cluster.cover)}</div>
      <span class="pin__count">${cluster.count}</span>
      <span class="pin__stem"></span>
    </div>`;
}

function photoTitle(photo) {
  const when = photo.takenAt ? new Date(photo.takenAt).toLocaleString() : '';
  return [photo.caption, when].filter(Boolean).join(' · ') || 'Photo';
}

function clusterTitle(cluster) {
  const times = cluster.photos.map((p) => Date.parse(p.takenAt || '')).filter(Boolean).sort();
  if (!times.length) return `${cluster.count} photos`;
  const from = new Date(times[0]).toLocaleDateString();
  const to = new Date(times[times.length - 1]).toLocaleDateString();
  return `${cluster.count} photos · ${from === to ? from : `${from} – ${to}`}`;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function onClusterClick(cluster) {
  closeSpider();
  mapView.userInteracted = true;
  if (cluster.count === 1) {
    emitNow('open', cluster.cover.id);
    return;
  }
  // Fan the photos out in place only when zooming genuinely can't separate
  // them: same spot on the ground, or we're already as deep as the map goes.
  const [[minLat, minLon], [maxLat, maxLon]] = cluster.bounds;
  const metres = mapView.map.distance([minLat, minLon], [maxLat, maxLon]);
  if (metres < 4 || mapView.map.getZoom() >= MAX_ZOOM - 1) {
    spiderfy(cluster);
    return;
  }
  mapView.map.flyToBounds(cluster.bounds, { padding: [90, 90], maxZoom: MAX_ZOOM - 1, duration: 0.55 });
}

function spiderfy(cluster) {
  const map = mapView.map;
  const center = map.latLngToLayerPoint(unproject(cluster, map.getZoom()));
  const offsets = spiderPositions(cluster.photos.length);
  mapView.spiderOpen = cluster.id;

  const legs = [];
  cluster.photos.forEach((photo, i) => {
    const target = map.layerPointToLatLng(center.add(offsets[i]));
    legs.push([map.layerPointToLatLng(center), target]);
    const marker = L.marker(target, {
      icon: L.divIcon({
        html: `<div class="pin pin--single pin--spider" title="${escapeAttr(photoTitle(photo))}">
                 <div class="pin__frame">${thumb(photo)}</div>
               </div>`,
        className: 'pin-wrap',
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      }),
      zIndexOffset: 600,
    });
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      emitNow('open', photo.id);
    });
    marker.addTo(mapView.spiderLayer);
  });

  for (const leg of legs) {
    L.polyline(leg, { color: '#8fb9ff', weight: 1.2, opacity: 0.6, interactive: false }).addTo(mapView.spiderLayer);
  }

  const marker = mapView.markers.get(cluster.id);
  if (marker) marker.getElement()?.classList.add('is-open');
}

export function closeSpider() {
  if (!mapView.spiderOpen) return;
  mapView.spiderLayer.clearLayers();
  mapView.markers.get(mapView.spiderOpen)?.getElement()?.classList.remove('is-open');
  mapView.spiderOpen = null;
}

// ---------------------------------------------------------------------------
// Route + selection
// ---------------------------------------------------------------------------

function renderRoute() {
  mapView.routeLayer.clearLayers();
  if (!mapView.showRoute) return;
  const points = locatedPhotos().map((p) => [p.lat, p.lon]);
  if (points.length < 2) return;
  L.polyline(points, { color: '#7aa2ff', weight: 1.6, opacity: 0.45, dashArray: '5 7', interactive: false })
    .addTo(mapView.routeLayer);
}

function paintSelection() {
  for (const [, marker] of mapView.markers) {
    const el = marker.getElement();
    if (!el) continue;
    const holds = state.selectedId && marker.cluster.photos.some((p) => p.id === state.selectedId);
    el.classList.toggle('is-selected', Boolean(holds));
  }
}

on('select', paintSelection);

/** Bring a specific photo into view, zooming in far enough to isolate it. */
export function focusPhoto(photo, { zoom } = {}) {
  if (!photo || photo.lat == null) return;
  const target = zoom ?? Math.max(mapView.map.getZoom(), 14);
  mapView.map.flyTo([photo.lat, photo.lon], target, { duration: 0.7 });
}

export function fitAll() {
  const photos = locatedPhotos();
  if (!photos.length) return;
  const bounds = L.latLngBounds(photos.map((p) => [p.lat, p.lon]));
  mapView.map.fitBounds(bounds, { padding: [70, 70], maxZoom: 15 });
}

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
