// Flitswacht — js/core/geo.js
// Pure geodesy helpers. No DOM, no dependencies.
// Points may be given as {lat, lon} objects or as [lat, lon] arrays (Way.geometry uses arrays).

/** Mean earth radius in metres (IUGG). */
export const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** @param {{lat:number,lon:number}|number[]} p */
function latOf(p) { return Array.isArray(p) ? p[0] : p.lat; }
/** @param {{lat:number,lon:number}|number[]} p */
function lonOf(p) { return Array.isArray(p) ? p[1] : p.lon; }

/**
 * Normalise an angle to [0, 360).
 * @param {number} deg
 * @returns {number}
 */
export function normalizeDeg(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/**
 * Great-circle distance in metres.
 * @param {{lat:number,lon:number}|number[]} a
 * @param {{lat:number,lon:number}|number[]} b
 * @returns {number} metres
 */
export function haversine(a, b) {
  const la1 = latOf(a) * D2R, la2 = latOf(b) * D2R;
  const dLa = la2 - la1;
  const dLo = (lonOf(b) - lonOf(a)) * D2R;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Initial great-circle bearing from a to b.
 * @param {{lat:number,lon:number}|number[]} a
 * @param {{lat:number,lon:number}|number[]} b
 * @returns {number} degrees 0..360, 0 = north, clockwise
 */
export function bearing(a, b) {
  const la1 = latOf(a) * D2R, la2 = latOf(b) * D2R;
  const dLo = (lonOf(b) - lonOf(a)) * D2R;
  const y = Math.sin(dLo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
  return normalizeDeg(Math.atan2(y, x) * R2D);
}

/**
 * Smallest absolute difference between two bearings.
 * @param {number} a degrees
 * @param {number} b degrees
 * @returns {number} 0..180
 */
export function angleDiff(a, b) {
  const d = Math.abs(normalizeDeg(a - b));
  return d > 180 ? 360 - d : d;
}

/**
 * Point reached from p travelling distM along bearingDeg (great circle).
 * @param {{lat:number,lon:number}|number[]} p
 * @param {number} bearingDeg
 * @param {number} distM
 * @returns {{lat:number, lon:number}}
 */
export function destination(p, bearingDeg, distM) {
  const la1 = latOf(p) * D2R, lo1 = lonOf(p) * D2R;
  const br = bearingDeg * D2R, ad = distM / EARTH_R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(ad) + Math.cos(la1) * Math.sin(ad) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(ad) * Math.cos(la1),
    Math.cos(ad) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 * R2D, lon: ((lo2 * R2D + 540) % 360) - 180 };
}

/**
 * Orthogonal projection of p on segment a-b, using a local equirectangular plane centred on p
 * (error well below 0.1 % for segments up to several km).
 * @param {{lat:number,lon:number}|number[]} p
 * @param {{lat:number,lon:number}|number[]} a
 * @param {{lat:number,lon:number}|number[]} b
 * @returns {{point:{lat:number,lon:number}, t:number, distM:number}} t in [0,1] along a->b
 */
export function projectOnSegment(p, a, b) {
  const pla = latOf(p), plo = lonOf(p);
  const ky = D2R * EARTH_R, kx = Math.cos(pla * D2R) * ky;
  const ax = (lonOf(a) - plo) * kx, ay = (latOf(a) - pla) * ky;
  const bx = (lonOf(b) - plo) * kx, by = (latOf(b) - pla) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const px = ax + t * dx, py = ay + t * dy;
  return {
    point: { lat: pla + py / ky, lon: plo + px / kx },
    t,
    distM: Math.sqrt(px * px + py * py),
  };
}

/**
 * Length of a polyline in metres.
 * @param {Array<{lat:number,lon:number}|number[]>} coords
 * @returns {number}
 */
export function polylineLength(coords) {
  let s = 0;
  if (!coords) return 0;
  for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
  return s;
}

/**
 * Bounding box that contains the circle of radiusM around p.
 * @param {{lat:number,lon:number}|number[]} p
 * @param {number} radiusM
 * @returns {{s:number,w:number,n:number,e:number}}
 */
export function bboxAround(p, radiusM) {
  const la = latOf(p), lo = lonOf(p);
  const dLat = (radiusM / EARTH_R) * R2D;
  const c = Math.max(1e-6, Math.cos(la * D2R));
  const dLon = Math.min(180, dLat / c);
  return { s: Math.max(-90, la - dLat), w: lo - dLon, n: Math.min(90, la + dLat), e: lo + dLon };
}

const MAX_MERC_LAT = 85.05112878;

/**
 * Slippy-map tile key "z/x/y" containing (lat, lon).
 * @param {number} lat
 * @param {number} lon
 * @param {number} [zoom=11]
 * @returns {string}
 */
export function tileKey(lat, lon, zoom = 11) {
  const n = 2 ** zoom;
  const la = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat)) * D2R;
  let x = Math.floor(((lon + 180) / 360) * n);
  let y = Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n);
  x = ((x % n) + n) % n;
  y = Math.max(0, Math.min(n - 1, y));
  return `${zoom}/${x}/${y}`;
}

/**
 * Bounds of a slippy-map tile key "z/x/y".
 * @param {string} key
 * @returns {{s:number,w:number,n:number,e:number}}
 */
export function tileBounds(key) {
  const [z, x, y] = String(key).split('/').map(Number);
  const n = 2 ** z;
  const lonAt = (xx) => (xx / n) * 360 - 180;
  const latAt = (yy) => Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * R2D;
  return { s: latAt(y + 1), w: lonAt(x), n: latAt(y), e: lonAt(x + 1) };
}

/**
 * Local equirectangular projection around (lat0, lon0): metres east (x) / north (y).
 * Accurate to < 0.1 % within ~20 km of the origin. (Extra helper, not in the contract.)
 * @param {number} lat0
 * @param {number} lon0
 * @returns {{toXY:(lat:number,lon:number)=>number[], toLL:(x:number,y:number)=>number[], kx:number, ky:number}}
 */
export function createLocalProjection(lat0, lon0) {
  const ky = D2R * EARTH_R;
  const kx = Math.cos(lat0 * D2R) * ky;
  return {
    kx, ky,
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLL: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}
