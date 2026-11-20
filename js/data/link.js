// Flitswacht — koppeling camera -> wayIds + richting uit de weg (W-DATA, A1.1/A1.3/A3.1).
// Gebruikt door de provider (tegen camera-ways ∪ wegen-tegels) en door W-CORE in tests.
import { brng, pointSegDist } from './geoutil.js';

export const LINK_MAX_M = 15; // A3.1: dichtstbijzijnde way max. 15 m
export const AMBIGUITY_M = 8; // A3.1: een ándere weg moet minstens 8 m verder liggen
export const WAY_DIR_MAX_M = 15; // richting overnemen van een oneway-weg
const CELL_LAT = 0.004; // ~445 m
const CELL_LON = 0.0065; // ~445 m op 52°N
const cellKey = (i, j) => i * 100000 + j;

/** Ruimtelijke index over de segmenten van ways + node-id -> ways (voor ways met `nodes`). */
export function buildSegmentIndex(ways) {
  const grid = new Map();
  const byNode = new Map();
  for (const w of ways) {
    const g = w.geometry;
    if (!Array.isArray(g)) continue;
    if (Array.isArray(w.nodes) && w.nodes.length === g.length) {
      w.nodes.forEach((nid, i) => {
        let a = byNode.get(nid);
        if (!a) byNode.set(nid, (a = []));
        if (!a.some((x) => x.way.id === w.id)) a.push({ way: w, idx: i });
      });
    }
    for (let s = 1; s < g.length; s++) {
      const a = g[s - 1], b = g[s];
      const i0 = Math.floor(Math.min(a[0], b[0]) / CELL_LAT), i1 = Math.floor(Math.max(a[0], b[0]) / CELL_LAT);
      const j0 = Math.floor(Math.min(a[1], b[1]) / CELL_LON), j1 = Math.floor(Math.max(a[1], b[1]) / CELL_LON);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = cellKey(i, j);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push([w, s - 1]);
      }
    }
  }
  return {
    /** -> [{way, seg, distM}] gesorteerd, binnen maxM (beste segment per way) */
    near(lat, lon, maxM) {
      const i = Math.floor(lat / CELL_LAT), j = Math.floor(lon / CELL_LON);
      const best = new Map();
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const arr = grid.get(cellKey(i + di, j + dj));
        if (!arr) continue;
        for (const [w, s] of arr) {
          const { distM } = pointSegDist(lat, lon, w.geometry[s], w.geometry[s + 1]);
          if (distM > maxM) continue;
          const prev = best.get(w.id);
          if (!prev || distM < prev.distM) best.set(w.id, { way: w, seg: s, distM });
        }
      }
      return [...best.values()].sort((a, b) => a.distM - b.distM);
    },
    /** -> [{way, idx}] ways waarvan node `nodeId` deel is */
    waysOfNode(nodeId) { return nodeId == null ? [] : byNode.get(nodeId) || []; },
  };
}

const segBearing = (w, s) => brng(w.geometry[s][0], w.geometry[s][1], w.geometry[s + 1][0], w.geometry[s + 1][1]);
const angle = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const roadKey = (w) => (w.ref || w.name || null);

// Zelfde weg = zelfde ref/naam (niet leeg) én, als beide oneway, ongeveer dezelfde rijrichting.
function sameRoad(a, b) {
  const ka = roadKey(a.way), kb = roadKey(b.way);
  if (!ka || ka !== kb) return false;
  if (a.way.oneway && b.way.oneway && angle(segBearing(a.way, a.seg), segBearing(b.way, b.seg)) > 90) return false;
  return true;
}

export const SAME_DIR_DEG = 25; // N6: ways in dezelfde rijrichting mogen samen in wayIds
const isLink = (w) => /_link$/.test(w.highway || '');
// Rijrichting-hoek: bij oneway richtingsgevoelig, anders alleen de as.
function dirAngle(a, b) {
  const d = angle(segBearing(a.way, a.seg), segBearing(b.way, b.seg));
  return a.way.oneway && b.way.oneway ? d : Math.min(d, 180 - d);
}
/**
 * N6: twee verschillende ways die in dezelfde rijrichting lopen (< 25°) gelden niet als rivalen maar worden samen
 * gekoppeld: (a) beide oneway, of (b) één is een *_link en de ander een hoofdbaan (camera tussen oprit en snelweg).
 * Een tweerichtings-parallelweg naast een oneway-rijbaan blijft een rivaal (anders vals alarm op de snelweg).
 */
function sameDirection(a, b) {
  if (dirAngle(a, b) >= SAME_DIR_DEG) return false;
  if (a.way.oneway && b.way.oneway) return true;
  return isLink(a.way) !== isLink(b.way);
}

// Segment-index bij een node: het segment dat bij de node begint (of het laatste).
const segAtNode = (w, idx) => Math.min(Math.max(0, idx), w.geometry.length - 2);

function nodeIdOf(c) {
  if (c.nodeId != null) return c.nodeId;
  const m = typeof c.id === 'string' ? /^n(\d+)$/.exec(c.id) : null;
  return m ? Number(m[1]) : null;
}

/**
 * linkCameras(cameras, ways, { index, maxM = 15, ambiguityM = 8 }) -> NIEUWE camera-objecten met
 *   wayIds: number[], linkDistM: number|null, linkAmbiguous: boolean, en waar mogelijk direction/directionSource 'way'.
 * Regels (A3.1):
 *  (1) camera-node (camera.nodeId of id 'n<id>') is zelf node van een way (ways met `nodes`) -> precies die way(s),
 *      linkDistM 0.
 *  (2) anders: dichtstbijzijnde way binnen maxM, alleen als de dichtstbijzijnde way van een ándere weg (ander ref/naam
 *      of andere rijrichting) minstens ambiguityM verder ligt; anders wayIds [] en linkAmbiguous true.
 *      N6: ways binnen maxM (of binnen het venster best+ambiguityM) in dezelfde rijrichting (< 25°; beide oneway, of *_link naast hoofdbaan) zijn geen
 *      rivalen maar komen óók in wayIds (dichtstbijzijnde eerst).
 * Richting (A1.1): 'relation' blijft; directionWay forward/backward -> langs de gekoppelde way ('way');
 *  geen richting of alleen kijkrichting langs de as, op een oneway-weg -> rijrichting van die weg ('way').
 * Invoer wordt niet gemuteerd.
 */
export function linkCameras(cameras, ways, { index = null, maxM = LINK_MAX_M, ambiguityM = AMBIGUITY_M } = {}) {
  const idx = index || buildSegmentIndex(ways);
  return cameras.map((c) => {
    const out = { ...c, wayIds: [], linkDistM: null, linkAmbiguous: false };
    let ref = null; // {way, seg}
    let refs = [];

    const members = idx.waysOfNode ? idx.waysOfNode(nodeIdOf(c)) : [];
    if (members.length) {
      refs = members.map(({ way, idx: i }) => ({ way, seg: segAtNode(way, i), distM: 0 }));
      out.wayIds = refs.map((r) => r.way.id);
      out.linkDistM = 0;
      // richting alleen eenduidig als alle ways bij de node (ongeveer) dezelfde kant op lopen
      const b0 = segBearing(refs[0].way, refs[0].seg);
      if (refs.every((r) => angle(segBearing(r.way, r.seg), b0) < 30)) ref = refs[0];
    } else {
      const cand = idx.near(c.lat, c.lon, maxM + ambiguityM);
      const best = cand[0];
      if (!best || best.distM > maxM) return out;
      // N6: een way in dezelfde rijrichting binnen maxM, of binnen het dubbelzinnigheidsvenster, is co-koppeling
      const coLink = (x) => !sameRoad(best, x) && sameDirection(best, x) && (x.distM <= maxM || x.distM - best.distM < ambiguityM);
      const rival = cand.slice(1).find((x) => !sameRoad(best, x) && !coLink(x) && x.distM - best.distM < ambiguityM);
      if (rival) { out.linkAmbiguous = true; return out; }
      refs = cand.filter((x) => x === best || coLink(x) || (x.distM <= maxM && sameRoad(best, x) && x.distM - best.distM < 2));
      out.wayIds = refs.map((x) => x.way.id);
      out.linkDistM = Math.round(best.distM * 10) / 10;
      ref = best;
    }

    if (out.directionSource === 'relation' || out.directionSource === 'way' || !ref) return out;
    const b = segBearing(ref.way, ref.seg);
    const onOneway = ref.way.oneway && (ref.distM ?? 0) <= WAY_DIR_MAX_M;
    if (c.directionWay === 'forward' || c.directionWay === 'backward') {
      const osmForward = ref.way.reversed ? (b + 180) % 360 : b; // reversed = geometry t.o.v. OSM omgedraaid
      out.direction = c.directionWay === 'forward' ? osmForward : (osmForward + 180) % 360;
      out.directionSource = 'way';
      return out;
    }
    if (out.directionSource === 'tag') {
      if (onOneway && Math.min(angle(out.direction, b), angle(out.direction + 180, b)) < 50) {
        out.direction = b; out.directionSource = 'way';
      }
      return out;
    }
    if (out.direction == null && onOneway) { out.direction = b; out.directionSource = 'way'; }
    return out;
  });
}
