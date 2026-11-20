// Interne, kleine geo-hulpfuncties voor js/data (geen afhankelijkheid van de exacte
// signatuur van core/geo.js haversine/bearing; punten hier zijn altijd losse lat/lon-getallen).
const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function dist(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function brng(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function dest(lat, lon, bearingDeg, distM) {
  const d = distM / R;
  const b = toRad(bearingDeg);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [toDeg(p2), ((toDeg(l2) + 540) % 360) - 180];
}

export function polylineLen(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += dist(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  return s;
}

// Afstand punt -> segment in lokale equirectangulaire projectie (prima voor < enkele km).
export function pointSegDist(lat, lon, a, b) {
  const kx = Math.cos(toRad(lat)) * 111320;
  const ky = 110574;
  const ax = (a[1] - lon) * kx, ay = (a[0] - lat) * ky;
  const bx = (b[1] - lon) * kx, by = (b[0] - lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx, py = ay + t * dy;
  return { distM: Math.hypot(px, py), t };
}

export function normBbox(b) {
  if (!b) throw new TypeError('bbox ontbreekt');
  if (Array.isArray(b)) return { s: +b[0], w: +b[1], n: +b[2], e: +b[3] };
  const s = b.s ?? b.south ?? b.minLat, w = b.w ?? b.west ?? b.minLon;
  const n = b.n ?? b.north ?? b.maxLat, e = b.e ?? b.east ?? b.maxLon;
  const out = { s: +s, w: +w, n: +n, e: +e };
  if (![out.s, out.w, out.n, out.e].every(Number.isFinite)) throw new TypeError('ongeldige bbox: ' + JSON.stringify(b));
  return out;
}
