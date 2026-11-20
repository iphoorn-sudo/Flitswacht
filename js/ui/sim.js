// Simulatiemodus: ingebouwde testroute + eigen nep-data, zonder netwerk.
// Levert (1) een nep-geolocation met dezelfde interface als navigator.geolocation en
// (2) een nep-provider met dezelfde interface als js/data/provider.js, zodat de ECHTE
// core-modules (gpsfilter, matcher, alerts, section) de hele keten doorlopen.
//
// Scenario (rijrichting ongeveer noord, NL-achtige snelweg "A99"):
//   d=1600 m  vaste flitser 100 km/h in JOUW rijrichting            -> moet waarschuwen
//   d=2300 m  vaste flitser op de TEGENBAAN (richting zuid)          -> mag NIET afgaan
//   d=2700 m  vaste flitser op de parallelweg (60 m naast je)        -> mag NIET afgaan
//   d=3200..5400 m  trajectcontrole 100 km/h (eerst te snel, dan herstel)
//   d=6100 m  vaste flitser met alleen een OSM-tag direction (KIJKrichting, naar het tegemoetkomende
//             verkeer = jou) -> directionSource 'tag', as-filter -> moet waarschuwen
// directionSource: 'way' voor de flitsers op de rijbanen, 'tag' op de parallelweg en bij d=6100,
// 'relation' voor de trajectcontrole (contract A1.1).
// Snelheid: optrekken, kort te hard (112) vóór de flitser, 98 bij de flitser.

import { parse } from '../data/overpass.js';
import { linkCameras } from '../data/link.js';

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function dest([lat, lon], brg, dist) {
  const d = dist / R, b = toRad(brg), p1 = toRad(lat), l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [toDeg(p2), toDeg(l2)];
}
function brgOf([la1, lo1], [la2, lo2]) {
  const p1 = toRad(la1), p2 = toRad(la2), dl = toRad(lo2 - lo1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
const round6 = ([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6];

// --- route opbouwen ------------------------------------------------------------------------------
const START = [52.0205, 5.0790];
const STEP = 25;            // m tussen hartlijnpunten
const LENGTH = 7000;        // m
const HALF_SEP = 13;        // m: rijbaan-hartlijn t.o.v. midden (rijbanen 26 m uit elkaar)
const PARALLEL_OFF = 60;    // m rechts van de noordbaan

function headingAt(d) { return 8 + 14 * Math.sin((d / LENGTH) * Math.PI * 1.6); }

function buildCenterline() {
  const pts = [START];
  const hdg = [headingAt(0)];
  for (let d = STEP; d <= LENGTH; d += STEP) {
    const h = headingAt(d - STEP / 2);
    pts.push(dest(pts[pts.length - 1], h, STEP));
    hdg.push(h);
  }
  return { pts, hdg };
}
const CL = buildCenterline();
const offsetLine = (off) => CL.pts.map((p, i) => dest(p, CL.hdg[i] + 90, off));

const NB = offsetLine(HALF_SEP);                 // noordbaan (rechts rijden)
const SB = offsetLine(-HALF_SEP).reverse();      // zuidbaan, tegengesteld
const PAR = offsetLine(HALF_SEP + PARALLEL_OFF); // parallelweg

/** Punt + koers op afstand d langs de noordbaan. */
function along(d) {
  const i = Math.max(0, Math.min(NB.length - 2, Math.floor(d / STEP)));
  const t = Math.max(0, Math.min(1, (d - i * STEP) / STEP));
  const a = NB[i], b = NB[i + 1];
  return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], hdg: brgOf(a, b) };
}
function lateral(d, off) {
  const { pos, hdg } = along(d);
  return { pos: dest(pos, hdg + 90, off), hdg };
}

const D_MID = 900;
const D_EXIT = 5800;
/** Afrit: begint exact op een hoofdbaan-punt (gedeelde knoop) en buigt geleidelijk naar rechts af. */
function exitGeometry() {
  const i = Math.round(D_EXIT / STEP);
  const pts = [NB[i]];
  let h = brgOf(NB[i], NB[i + 1]);
  for (let k = 1; k <= 24; k++) { h += k < 8 ? 3 : 0.5; pts.push(dest(pts[pts.length - 1], h, 25)); }
  return pts;
}
const D_CAM = 1600, D_OPP = 2300, D_PAR = 2700, D_SEC_A = 3200, D_SEC_B = 5400, D_TAG = 6100;

/**
 * Ruwe Overpass-achtige respons (`out geom`) voor de testroute. Gaat door de ECHTE parse() en linkCameras()
 * (U12), zodat ook wayIds, directionSource en de trajectrelatie langs de echte dataketen lopen.
 *  - n2001 vaste flitser op de noordbaan, zonder direction-tag -> linkCameras: rijrichting van de oneway-weg ('way')
 *  - n2002 vaste flitser op de zuidbaan (tegenbaan) -> 'way', richting zuid -> mag NIET afgaan
 *  - n2003 flitser op de parallelweg (unclassified, tweerichting), direction-tag -> 'tag'; mag NIET afgaan
 *  - n2004 flitser op de noordbaan met alleen direction-tag = kijkrichting (naar jou toe) -> 'tag', moet afgaan
 *  - n2007 flitser in de berm tussen hoofdbaan en een parallelle uitvoeger (motorway_link 1004), zonder richting:
 *           twee wegen bijna even dichtbij -> linkCameras: linkAmbiguous -> alerts: uncertain -> "Mogelijk flitser"
 *  - n2008 flitser op een afrit (motorway_link 1005) die bij d=5800 rechts afsplitst; jij rijdt rechtdoor:
 *           alleen een stille 'info' (branch 'exit', zachte toon, geen spraak), daarna stil vervallen (R1)
 *  - r3001 trajectcontrole (enforcement=average_speed, from/to + section-way)
 */
export function buildSimOverpass() {
  const g = (pts) => pts.map(([lat, lon]) => ({ lat: round6([lat, lon])[0], lon: round6([lat, lon])[1] }));
  const cam = along(D_CAM), opp = lateral(D_OPP, -2 * HALF_SEP), par = lateral(D_PAR, PARALLEL_OFF);
  const tag = along(D_TAG), sa = along(D_SEC_A), sb = along(D_SEC_B);
  const node = (id, p, tags) => ({ type: 'node', id, lat: round6(p)[0], lon: round6(p)[1], tags });
  const secGeom = NB.slice(Math.floor(D_SEC_A / STEP), Math.ceil(D_SEC_B / STEP) + 1);
  return {
    elements: [
      { type: 'way', id: 1001, tags: { highway: 'motorway', oneway: 'yes', maxspeed: '100', ref: 'A99', name: 'Simweg (noord)' }, geometry: g(NB) },
      { type: 'way', id: 1002, tags: { highway: 'motorway', oneway: 'yes', maxspeed: '100', ref: 'A99', name: 'Simweg (zuid)' }, geometry: g(SB) },
      { type: 'way', id: 1003, tags: { highway: 'unclassified', maxspeed: '60', name: 'Parallelweg' }, geometry: g(PAR) },
      node(2001, cam.pos, { highway: 'speed_camera', maxspeed: '100' }),
      node(2002, opp.pos, { highway: 'speed_camera', maxspeed: '100' }),
      node(2003, par.pos, { highway: 'speed_camera', maxspeed: '60', direction: String(Math.round(par.hdg)) }),
      node(2004, tag.pos, { highway: 'speed_camera', maxspeed: '100', direction: String(Math.round((tag.hdg + 180) % 360)) }),
      { type: 'way', id: 1004, tags: { highway: 'motorway_link', oneway: 'yes', maxspeed: '80' },
        geometry: g(Array.from({ length: 17 }, (_, i) => lateral(D_MID - 200 + i * 25, 22).pos)) },
      { type: 'way', id: 1005, tags: { highway: 'motorway_link', oneway: 'yes', maxspeed: '70' }, geometry: g(exitGeometry()) },
      node(2008, exitGeometry()[14], { highway: 'speed_camera', maxspeed: '70' }),
      node(2007, lateral(D_MID, 14).pos, { highway: 'speed_camera', maxspeed: '100' }),
      node(2005, sa.pos, { 'enforcement': 'average_speed' }),
      node(2006, sb.pos, { 'enforcement': 'average_speed' }),
      {
        type: 'relation', id: 3001,
        tags: { type: 'enforcement', enforcement: 'average_speed', maxspeed: '100', name: 'A99 sim' },
        members: [
          { type: 'node', ref: 2005, role: 'from', lat: round6(sa.pos)[0], lon: round6(sa.pos)[1] },
          { type: 'node', ref: 2006, role: 'to', lat: round6(sb.pos)[0], lon: round6(sb.pos)[1] },
          { type: 'way', ref: 1001, role: 'section', geometry: g(secGeom) },
        ],
      },
    ],
  };
}

/** Sim-camera-id's (zoals parse() ze maakt), voor tests. */
export const SIM_IDS = { exitCam: 'n2008', median: 'n2007', fixed: 'n2001', opposite: 'n2002', parallel: 'n2003', tag: 'n2004', section: 'r3001' };

/**
 * Parse + link met de echte datamodules. opts.cameraWays=false bootst na dat het 'camera-ways'-verzoek (A3.1)
 * ontbreekt: de parallelweg is dan onbekend voor matcher en linkCameras.
 */
export function buildSimData({ parse, linkCameras, cameraWays = true }) {
  const raw = parse(buildSimOverpass());
  const ways = cameraWays ? raw.ways : raw.ways.filter((w) => w.highway !== 'unclassified');
  const cameras = linkCameras(raw.cameras, ways);
  return { ways, cameras, sections: raw.sections };
}

/** Doelsnelheid (m/s) als functie van afgelegde afstand. */
function targetSpeed(d) {
  const kmh =
    d < 600 ? 100 :
    d < 1250 ? 112 :            // even te hard -> overschrijdingssignaal
    d < 3000 ? 98 :
    d < 4100 ? 112 :            // in traject te snel -> status 'over'
    d < 5600 ? 86 :             // herstellen
    d < 6500 ? 100 : 0;
  return kmh / 3.6;
}

/** Klein deterministisch ruisgetal (geen Math.random, zodat tests reproduceerbaar zijn). */
function makeNoise(seed = 42) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return (scale) => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale; };
}

/**
 * Nep-geolocation met watchPosition/clearWatch, zoals navigator.geolocation.
 * opts.speedFactor: 1 = realtime (1 fix/s), 4 = vier keer sneller (tijdstempels blijven 1 s uit elkaar).
 * opts.onEnd: wordt aangeroepen als de route klaar is.
 */
export function createSimGeolocation({ speedFactor = 1, onEnd = () => {}, onProgress = () => {} } = {}) {
  const watchers = new Map();
  let nextId = 1;
  let timer = null;
  let d = 0, v = 0, tick = 0;
  const t0 = Date.now();
  const noise = makeNoise(7);

  function step() {
    tick++;
    const target = targetSpeed(d);
    const maxDv = target < v ? 3.0 : 2.4;                // m/s per s
    v += Math.max(-maxDv, Math.min(maxDv, target - v));
    d += v;
    const { pos, hdg } = along(d);
    let p = dest(pos, noise(1) * 360, Math.abs(noise(1.8)));
    let accuracy = 5 + Math.abs(noise(1.5));
    if (tick === 40) { p = dest(pos, hdg + 90, 140); accuracy = 65; }   // één slechte fix (filtertest)
    const coords = {
      latitude: p[0], longitude: p[1], accuracy,
      altitude: null, altitudeAccuracy: null,
      speed: v > 0.3 ? Math.max(0, v + noise(0.25)) : 0,
      heading: v > 0.3 ? (hdg + noise(1.5) + 360) % 360 : NaN,
    };
    const position = { coords, timestamp: t0 + tick * 1000 };
    watchers.forEach((w) => { try { w.success(position); } catch (e) { console.error(e); } });
    onProgress({ d, v, total: LENGTH });
    if ((d >= LENGTH - 450 && v < 0.2) || d >= LENGTH) {
      clearInterval(timer); timer = null;
      onEnd();
    }
  }

  return {
    watchPosition(success, error) {
      const id = nextId++;
      watchers.set(id, { success, error });
      if (!timer) timer = setInterval(step, Math.max(50, 1000 / speedFactor));
      return id;
    },
    clearWatch(id) {
      watchers.delete(id);
      if (!watchers.size && timer) { clearInterval(timer); timer = null; }
    },
    getCurrentPosition(success) { const { pos } = along(d); success({ coords: { latitude: pos[0], longitude: pos[1], accuracy: 5, speed: 0, heading: NaN }, timestamp: Date.now() }); },
  };
}

/** Nep-provider met de contract-interface van js/data/provider.js; data via de echte parse()/linkCameras(). */
export function createSimProvider({ cameraWays = true } = {}) {
  const data = buildSimData({ parse, linkCameras, cameraWays });
  const listeners = new Set();
  let announced = false;
  function status() {
    return { mode: 'sim', state: 'ok', online: true, loading: false, lastError: null, enforcementAgeMs: 0,
      enforcementCount: data.cameras.length, tilesLoaded: 1, budgetLeft: Infinity, budgetExhausted: false,
      stale: false, cameraWaysLoaded: cameraWays };
  }
  return {
    async ensureAround() {
      if (!announced) {
        announced = true;
        // asynchroon, zoals de echte provider na het laden van een tegel
        setTimeout(() => listeners.forEach((cb) => cb(data, status())), 0);
      }
    },
    getData: () => data,
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    status,
  };
}

/** Punt + koers op afstand d (m) langs de noordbaan; voor tests/handmatig proberen. */
export function simPointAt(d) { const { pos, hdg } = along(d); return { lat: pos[0], lon: pos[1], heading: hdg }; }

export const SIM_INFO = { length: LENGTH, cameraAt: D_CAM, tagCameraAt: D_TAG, oppositeAt: D_OPP, parallelAt: D_PAR, sectionFrom: D_SEC_A, sectionTo: D_SEC_B };
