# photomap

Plot the photos from an iCloud shared album on a map, clustered by location,
and click through to any photo with its full geodata.

No build step, no framework, no dependencies — vanilla ES modules, Leaflet
(vendored), and a ~350 line Node server whose only job is to talk to Apple.

## Run it

With Docker:

```sh
docker compose up -d
open http://127.0.0.1:8787
```

Or straight from source (Node 18+, nothing to install):

```sh
node server.js          # or: npm start
```

Then paste a shared album link and press **Add**:

```
https://www.icloud.com/sharedalbum/#B0n5Uzl7V3IW57
```

Published images are at `ghcr.io/cori/photomap` for `linux/amd64` and
`linux/arm64`, tagged with the `package.json` version, the commit
(`sha-<short>`), and `latest`. Pin the version tag — bump `package.json` to
cut a new one.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listen port. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address. |
| `CACHE_DIR` | unset (`/data` in the image) | Where to persist the reverse-geocode cache. Unset keeps it in memory only. |
| `TZ` | `UTC` | Container timezone. |
| `HTTPS_PROXY` | unset | Outbound proxy, tunnelled with `CONNECT`. |

`GET /healthz` is what the image's `HEALTHCHECK` polls. It reports liveness
plus how much the server has cached since it started — `albums` is resolved
album partitions, `places` is reverse-geocoded coordinates:

```json
{ "ok": true, "albums": 0, "places": 0 }
```

The only writable state is that geocode cache, which exists so a restart
doesn't re-ask Nominatim about places it already knows. Delete it freely —
everything the app actually shows lives in your browser.

### runtipi

Packaged in [cori/rtappstore](https://github.com/cori/rtappstore) as
`photomap`. Add that app store to runtipi and install it from there.

## What you can feed it

| Input | How |
| --- | --- |
| iCloud shared album | Paste the `icloud.com/sharedalbum/#TOKEN` link (or just the token). Several at once, space or comma separated. |
| Local photos | Drag them onto the window, or press **Files…**. Never leaves your machine. |
| Direct image URLs | Paste any `https://…jpg` URLs. |

Loaded albums are remembered, and the URL carries the whole view, so a mapped
trip is a link you can bookmark or send on — see below.

## Sharing a view

The address bar always describes what you're looking at, so copying it is a
share. **Share** in the map controls copies the same link; **Copy link** in the
photo viewer copies one that opens straight to that photo.

```
#album=TOKEN,TOKEN&c=53.34410,-6.26750&z=14&b=satellite&p=<photo guid>
      &t=2024-05-19,2024-05-24&f=TOKEN
```

| Key | Meaning |
| --- | --- |
| `album` | Shared album tokens to load |
| `c` | Map centre, `lat,lng` |
| `z` | Zoom |
| `b` | Basemap (omitted for the default) |
| `p` | Photo to open, by its iCloud GUID |
| `t` | Date filter, `from,to` — either side may be empty |
| `f` | Which albums stay ticked, when not all of them |

Everything but `album` is optional, so an older `#album=…`-only link still
works and picks up a centre and zoom the moment you move the map. Opening a
link to a photo shows the photo immediately and fills in its location a moment
later, once its EXIF has been read.

Two things worth knowing before you send one on:

- **The link contains the album token**, which is the same secret as the
  iCloud link itself — anyone with it can see the album. It lives in the URL
  fragment, so it is never sent to the photomap server, but treat the link
  exactly as you'd treat the iCloud one.
- **Local files and pasted image URLs can't travel in a link** — there is
  nothing for the other end to fetch. Only shared albums are shareable.

## What it does

- **Clusters by what would overlap on screen**, not by fixed geography — so
  zooming in genuinely pulls a cluster apart into smaller piles and finally
  into individual photos. Clicking a cluster flies to its bounds.
- **Fans out photos taken in the same spot** (within ~4 m, or once you're at
  maximum zoom) instead of zooming forever.
- **Draws the trip route** chronologically through the located photos.
- **Shows every photo full-screen** with coordinates (DMS and decimal),
  altitude, heading with a compass cone on an inset map, speed, GPS accuracy,
  reverse-geocoded place name, camera, lens and exposure. Arrow keys move
  through the album.
- **Filters** by album and by date range, and lists the photos it could not
  place separately rather than silently dropping them.

## How it works

The interesting part is where the coordinates come from.

Apple's shared-album API returns captions, timestamps and image URLs — but no
location. The location is still in the photos themselves: shared albums keep
the original EXIF, GPS block included.

So:

1. **`/api/album`** (server) resolves the album. Apple shards albums across
   numbered partitions; any partition answers with `330 Moved` and an
   `X-Apple-MMe-Host` header naming the right one, so the server asks one and
   follows. It then calls `webstream` for the photo list and `webasseturls`
   for signed CDN URLs, and normalises both into one JSON payload.
2. **The browser reads the EXIF itself.** Apple's CDN sends CORS headers and
   honours `Range`, so the page fetches only the first ~192 KB of each photo —
   enough for the APP1/EXIF segment — and parses the GPS block in
   [`public/js/exif.js`](public/js/exif.js). Six at a time, pins appearing as
   they resolve. A full-size download per photo is never needed.
3. Coordinates are cached in `localStorage` by photo GUID, so a second visit
   to the same album maps instantly.

The server exists **only** because `*.sharedstreams.icloud.com` sends no CORS
headers. Thumbnails, full-size images and EXIF all go browser → Apple
directly. `/api/image` is a fallback proxy (and how direct image URLs are
fetched); it refuses to proxy anything resolving to a private address.
`/api/geocode` is a serialised, cached pass-through to Nominatim, at most one
request per second per their usage policy.

## Layout

```
server.js              album API, image proxy, geocoder, static files
public/js/exif.js      minimal EXIF/GPS reader (works on a partial file)
public/js/sources.js   albums, local files, URLs -> photos + the EXIF pipeline
public/js/cluster.js   greedy pixel-space clustering, spiderfy positions
public/js/mapview.js   Leaflet map, photo pins, route, interaction
public/js/lightbox.js  full-screen viewer, geodata panel, inset map
public/js/store.js     state, filters, EXIF cache
public/js/share.js     the shareable-link format, encode and decode
public/js/app.js       side panel, filters, wiring
```

## Worth knowing

- **Not every photo has GPS.** Screenshots, scans, AirDropped images and
  photos taken with location services off carry none. In the sample album, 31
  of 34 do; the rest are listed under *No location*.
- **Videos are skipped** for location — their coordinates live in a container
  atom, not EXIF.
- **Signed CDN URLs expire after a few hours.** Reload the album if images
  start failing on a long-lived tab.
- **Individual `share.icloud.com/photos/…` links are not supported** — those
  use a different, undocumented single-asset flow. Shared albums are the
  supported path; for one-off photos, drop the files in.
- **Basemaps** are OpenStreetMap (Dark is the same tiles under a CSS filter),
  OpenTopoMap and Esri World Imagery — all keyless. Be considerate of the tile
  servers' usage policies.
- Everything stays local: no accounts, no analytics, no server-side storage.
