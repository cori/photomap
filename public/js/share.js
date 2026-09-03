/**
 * Shareable links.
 *
 * The whole view lives in the URL fragment, so a link is just a string — no
 * server state, no shortener, nothing to expire. The fragment is never sent
 * to the server, which also means the album tokens in it stay between the
 * people you hand the link to.
 *
 *   #album=TOKEN,TOKEN&c=53.3441,-6.2675&z=14&b=light&p=<photo guid>
 *         &t=2024-05-19,2024-05-24&f=TOKEN
 *
 * Every key except `album` is optional; an old `#album=…`-only link still
 * works, and so does a link from a newer build opened in an older one.
 */

const KEYS = ['album', 'c', 'z', 'b', 'p', 't', 'f'];

/**
 * Values safe to drop into a fragment unescaped. iCloud photo GUIDs and album
 * tokens qualify; the synthetic ids we give local files ("IMG 1.jpg:12345")
 * and pasted URLs (the URL itself) do not — those carry spaces, `?` and `&`,
 * which would split the fragment into junk.
 */
const LINK_SAFE = /^[A-Za-z0-9_-]+$/;

/** Can this photo be named in a link at all? */
export function isLinkablePhoto(guid) {
  return typeof guid === 'string' && LINK_SAFE.test(guid);
}

/** Album tokens are base64url, so only `,` needs protecting as a separator. */
function encodeList(values) {
  return values.join(',');
}

function decodeList(value) {
  return String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

function toDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function fromDate(text, endOfDay) {
  const t = Date.parse(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00'}Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object} view
 * @param {string[]} view.albums    tokens to load
 * @param {{lat:number,lng:number}} [view.center]
 * @param {number} [view.zoom]
 * @param {string} [view.basemap]
 * @param {string} [view.photo]     photo guid to open
 * @param {{from:?number,to:?number}} [view.dates]
 * @param {string[]} [view.visible] album tokens left ticked, when not all
 * @returns {string} the fragment, including the leading '#', or ''
 */
export function encodeView(view) {
  const parts = [];
  if (view.albums && view.albums.length) parts.push(`album=${encodeList(view.albums)}`);
  // Both halves, or neither: a half-checked pair threw on the missing one,
  // and this runs on every map move, so a throw here stops the URL updating.
  if (view.center && Number.isFinite(view.center.lat) && Number.isFinite(view.center.lng)) {
    parts.push(`c=${view.center.lat.toFixed(5)},${view.center.lng.toFixed(5)}`);
  }
  if (Number.isFinite(view.zoom)) parts.push(`z=${Math.round(view.zoom)}`);
  if (view.basemap && view.basemap !== 'light') parts.push(`b=${view.basemap}`);
  // Guard here rather than only at the call site: nothing that reaches this
  // function should be able to produce a fragment that won't parse back.
  if (isLinkablePhoto(view.photo)) parts.push(`p=${view.photo}`);
  if (view.dates && (view.dates.from || view.dates.to)) {
    const from = view.dates.from ? toDate(view.dates.from) : '';
    const to = view.dates.to ? toDate(view.dates.to) : '';
    parts.push(`t=${from},${to}`);
  }
  if (view.visible && view.albums && view.visible.length && view.visible.length !== view.albums.length) {
    parts.push(`f=${encodeList(view.visible)}`);
  }
  return parts.length ? `#${parts.join('&')}` : '';
}

/**
 * Parse a fragment. Unknown keys are ignored and malformed values are dropped
 * rather than throwing — a half-mangled link (chat clients love to clip them)
 * should still open the album it names.
 */
export function decodeView(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const view = { albums: [], center: null, zoom: null, basemap: null, photo: null, dates: null, visible: null };
  if (!raw) return view;

  const params = new Map();
  for (const chunk of raw.split('&')) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    const key = chunk.slice(0, eq);
    if (KEYS.includes(key)) params.set(key, chunk.slice(eq + 1));
  }

  view.albums = decodeList(params.get('album')).filter(isLinkablePhoto);

  const center = decodeList(params.get('c')).map(Number);
  if (center.length === 2 && Number.isFinite(center[0]) && Number.isFinite(center[1]) &&
      Math.abs(center[0]) <= 90 && Math.abs(center[1]) <= 180) {
    view.center = { lat: center[0], lng: center[1] };
  }

  const zoom = Number(params.get('z'));
  if (Number.isFinite(zoom) && zoom >= 0 && zoom <= 22) view.zoom = zoom;

  const basemap = params.get('b');
  if (basemap && /^[a-z]+$/.test(basemap)) view.basemap = basemap;

  const photo = params.get('p');
  if (isLinkablePhoto(photo)) view.photo = photo;

  if (params.has('t')) {
    const [from, to] = String(params.get('t')).split(',');
    const dates = { from: from ? fromDate(from, false) : null, to: to ? fromDate(to, true) : null };
    if (dates.from || dates.to) view.dates = dates;
  }

  if (params.has('f')) view.visible = decodeList(params.get('f')).filter(isLinkablePhoto);

  return view;
}

/** Copy text, falling back to a hidden textarea where the API isn't allowed. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Insecure origins (plain http on a LAN box — exactly how this gets
    // self-hosted) have no clipboard API at all.
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
