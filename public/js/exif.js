/**
 * Minimal EXIF reader.
 *
 * Only needs to handle what a photo map cares about: where, when, and with
 * what. Works on a partial file — the EXIF block lives in the first APP1
 * segment, so ~128 KB off the front of a JPEG is plenty.
 */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const GPS = {
  LAT_REF: 0x0001, LAT: 0x0002, LON_REF: 0x0003, LON: 0x0004,
  ALT_REF: 0x0005, ALT: 0x0006, TIMESTAMP: 0x0007, SPEED_REF: 0x000c,
  SPEED: 0x000d, IMG_DIR_REF: 0x0010, IMG_DIR: 0x0011, DATESTAMP: 0x001d,
  H_ERROR: 0x001f,
};

const IFD0 = {
  MAKE: 0x010f, MODEL: 0x0110, ORIENTATION: 0x0112, SOFTWARE: 0x0131,
  EXIF_IFD: 0x8769, GPS_IFD: 0x8825,
};

const EXIF_IFD = {
  EXPOSURE_TIME: 0x829a, F_NUMBER: 0x829d, ISO: 0x8827, DATE_ORIGINAL: 0x9003,
  OFFSET_ORIGINAL: 0x9011, SHUTTER: 0x9201, FOCAL_LENGTH: 0x920a,
  PIXEL_X: 0xa002, PIXEL_Y: 0xa003, FOCAL_35MM: 0xa405, LENS_MODEL: 0xa434,
};

/** Locate the TIFF header inside a JPEG (or, failing that, anywhere). */
function findTiffOffset(view, bytes) {
  // Walk JPEG segment markers looking for APP1/Exif.
  if (bytes.length > 4 && view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
      if (marker === 0xda) break; // start of scan: no metadata past here
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      if (marker === 0xe1) {
        const start = offset + 4;
        if (start + 6 <= bytes.length &&
            bytes[start] === 0x45 && bytes[start + 1] === 0x78 &&
            bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66) {
          return start + 6;
        }
      }
      offset += 2 + length;
    }
  }
  // HEIC/TIFF and other containers: find the "Exif\0\0" + byte-order marker.
  const limit = Math.min(bytes.length - 8, 4 * 1024 * 1024);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 &&
        bytes[i + 3] === 0x66 && bytes[i + 4] === 0x00 && bytes[i + 5] === 0x00) {
      const tiff = i + 6;
      const bo = (bytes[tiff] << 8) | bytes[tiff + 1];
      if (bo === 0x4d4d || bo === 0x4949) return tiff;
    }
  }
  return -1;
}

function makeReader(view, tiff, bigEndian) {
  const inRange = (offset, size) => offset >= 0 && tiff + offset + size <= view.byteLength;
  return {
    u16: (o) => (inRange(o, 2) ? view.getUint16(tiff + o, !bigEndian) : null),
    u32: (o) => (inRange(o, 4) ? view.getUint32(tiff + o, !bigEndian) : null),
    i32: (o) => (inRange(o, 4) ? view.getInt32(tiff + o, !bigEndian) : null),
    bytes: (o, n) => (inRange(o, n) ? new Uint8Array(view.buffer, view.byteOffset + tiff + o, n) : null),
    inRange,
  };
}

function readIfd(r, offset) {
  const count = r.u16(offset);
  if (count === null || count > 512) return null;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    const tag = r.u16(entry);
    const type = r.u16(entry + 2);
    const length = r.u32(entry + 4);
    if (tag === null || type === null || length === null) break;
    const bytes = (TYPE_SIZE[type] || 1) * length;
    const valueOffset = bytes > 4 ? r.u32(entry + 8) : entry + 8;
    if (valueOffset === null) continue;
    entries.set(tag, { type, count: length, offset: valueOffset });
  }
  return entries;
}

function readValue(r, entry) {
  if (!entry) return null;
  const { type, count, offset } = entry;
  switch (type) {
    case 1: case 7: {
      const b = r.bytes(offset, count);
      return b ? Array.from(b) : null;
    }
    case 2: {
      const b = r.bytes(offset, count);
      if (!b) return null;
      let s = '';
      for (const c of b) { if (c === 0) break; s += String.fromCharCode(c); }
      return s.trim();
    }
    case 3: {
      const out = [];
      for (let i = 0; i < count; i++) out.push(r.u16(offset + i * 2));
      return out;
    }
    case 4: {
      const out = [];
      for (let i = 0; i < count; i++) out.push(r.u32(offset + i * 4));
      return out;
    }
    case 5: case 10: {
      const out = [];
      for (let i = 0; i < count; i++) {
        const num = type === 5 ? r.u32(offset + i * 8) : r.i32(offset + i * 8);
        const den = type === 5 ? r.u32(offset + i * 8 + 4) : r.i32(offset + i * 8 + 4);
        out.push(num === null || den === null || den === 0 ? null : num / den);
      }
      return out;
    }
    default:
      return null;
  }
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

function dmsToDegrees(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 2) return null;
  const [d = 0, m = 0, s = 0] = dms.map((n) => (typeof n === 'number' && isFinite(n) ? n : 0));
  const deg = d + m / 60 + s / 3600;
  if (!isFinite(deg)) return null;
  return ref === 'S' || ref === 'W' ? -deg : deg;
}

/** "2024:05:22 13:21:21" + "-08:00" -> ISO 8601 string. */
function exifDateToIso(value, offset) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const tz = offset && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : '';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${tz}`;
}

/**
 * @param {ArrayBuffer} buffer  whole file, or just the head of one
 * @returns {{gps: object|null, camera: object, takenAt: string|null, ...}}
 */
export function parseExif(buffer) {
  const empty = { gps: null, camera: {}, takenAt: null, takenAtOffset: null, orientation: null };
  if (!buffer || buffer.byteLength < 16) return empty;

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const tiff = findTiffOffset(view, bytes);
  if (tiff < 0) return empty;

  const bigEndian = ((bytes[tiff] << 8) | bytes[tiff + 1]) === 0x4d4d;
  const r = makeReader(view, tiff, bigEndian);
  if (r.u16(2) !== 42) return empty;

  const ifd0 = readIfd(r, r.u32(4));
  if (!ifd0) return empty;

  const result = { ...empty, camera: {} };
  result.camera.make = readValue(r, ifd0.get(IFD0.MAKE));
  result.camera.model = readValue(r, ifd0.get(IFD0.MODEL));
  result.camera.software = readValue(r, ifd0.get(IFD0.SOFTWARE));
  result.orientation = first(readValue(r, ifd0.get(IFD0.ORIENTATION)));

  // --- Exif sub-IFD: when and how ---
  const exifPointer = first(readValue(r, ifd0.get(IFD0.EXIF_IFD)));
  if (exifPointer) {
    const exif = readIfd(r, exifPointer);
    if (exif) {
      const offset = readValue(r, exif.get(EXIF_IFD.OFFSET_ORIGINAL));
      result.takenAtOffset = offset || null;
      result.takenAt = exifDateToIso(readValue(r, exif.get(EXIF_IFD.DATE_ORIGINAL)), offset);
      result.camera.lens = readValue(r, exif.get(EXIF_IFD.LENS_MODEL));
      result.camera.fNumber = first(readValue(r, exif.get(EXIF_IFD.F_NUMBER)));
      result.camera.exposureTime = first(readValue(r, exif.get(EXIF_IFD.EXPOSURE_TIME)));
      result.camera.iso = first(readValue(r, exif.get(EXIF_IFD.ISO)));
      result.camera.focalLength = first(readValue(r, exif.get(EXIF_IFD.FOCAL_LENGTH)));
      result.camera.focalLength35 = first(readValue(r, exif.get(EXIF_IFD.FOCAL_35MM)));
      result.width = first(readValue(r, exif.get(EXIF_IFD.PIXEL_X))) || null;
      result.height = first(readValue(r, exif.get(EXIF_IFD.PIXEL_Y))) || null;
    }
  }

  // --- GPS sub-IFD: where ---
  const gpsPointer = first(readValue(r, ifd0.get(IFD0.GPS_IFD)));
  if (gpsPointer) {
    const gps = readIfd(r, gpsPointer);
    if (gps && gps.size) {
      const lat = dmsToDegrees(readValue(r, gps.get(GPS.LAT)), readValue(r, gps.get(GPS.LAT_REF)));
      const lon = dmsToDegrees(readValue(r, gps.get(GPS.LON)), readValue(r, gps.get(GPS.LON_REF)));
      if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) {
        const altRef = first(readValue(r, gps.get(GPS.ALT_REF)));
        const alt = first(readValue(r, gps.get(GPS.ALT)));
        const speed = first(readValue(r, gps.get(GPS.SPEED)));
        const speedRef = readValue(r, gps.get(GPS.SPEED_REF));
        result.gps = {
          lat,
          lon,
          altitude: typeof alt === 'number' ? (altRef === 1 ? -alt : alt) : null,
          heading: first(readValue(r, gps.get(GPS.IMG_DIR))) ?? null,
          headingRef: readValue(r, gps.get(GPS.IMG_DIR_REF)) === 'M' ? 'magnetic' : 'true',
          speedKmh: typeof speed === 'number' ? toKmh(speed, speedRef) : null,
          accuracy: first(readValue(r, gps.get(GPS.H_ERROR))) ?? null,
        };
      }
    }
  }

  return result;
}

function toKmh(speed, ref) {
  if (ref === 'M') return speed * 1.609344; // miles/h
  if (ref === 'N') return speed * 1.852;    // knots
  return speed;                             // km/h
}

/** 47.123456 -> 47°7'24.4"N */
export function formatDms(value, axis) {
  if (typeof value !== 'number' || !isFinite(value)) return '';
  const hemisphere = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minutesFloat = (abs - deg) * 60;
  const min = Math.floor(minutesFloat);
  const sec = (minutesFloat - min) * 60;
  return `${deg}°${String(min).padStart(2, '0')}'${sec.toFixed(1).padStart(4, '0')}"${hemisphere}`;
}
