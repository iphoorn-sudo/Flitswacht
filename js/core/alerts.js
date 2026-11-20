// Flitswacht — js/core/alerts.js
// Direction- and road-aware camera alerts.
//
// Relevance of a camera (all must hold):
//  1. straight-line distance within the warning distance
//     warnDist = clamp(max(minDistM, speed * leadS), .., maxDistM)
//  2. it lies ahead of us AND on our road:
//     a) matched mode (match.confidence >= minMatchConfidence and match.ahead present):
//        the camera is projected on the road polyline ahead (which follows the road over junctions).
//        - lateral distance to that polyline must be < wayCorridorM (30 m)
//        - camera.wayIds non-empty  -> one of them must be a way of the road ahead
//          (rejects opposite carriageway, parallelweg and crossing roads even when < 30 m away)
//        - camera.wayIds empty and our way is oneway (dual carriageway) -> reject cameras more than
//          oppositeSideM to the LEFT (that is where the opposite carriageway is in NL/BE)
//        - distance = distance along the road (correct in curves; no 60° cone needed)
//        If the road polyline ends before the camera (dead end / ambiguous junction / data edge)
//        we fall back to (b).
//     b) geometric mode: |bearing(pos->cam) - heading| < coneDeg (60) and cross-track distance to the
//        heading line < 35 m (motorway/trunk or > 80 km/h) / 25 m elsewhere.
//  3. direction filter (amendment A1.1), against the road bearing at the camera in matched mode,
//     our heading in geometric mode:
//     directionSource 'relation' | 'way'  -> strict: angleDiff(direction, bearing) < directionTolDeg (50)
//     directionSource 'tag'               -> axis only (OSM direction = viewing direction of the camera):
//                                            min(angleDiff(d, b), angleDiff(d + 180, b)) < 50
//     directionSource null / direction null -> no direction filtering
//     directionSource undefined with a direction (pre-A1 data) -> strict, as in the original contract
//  update(state, match, {enabled}) -> enabled === false returns [] (e.g. outside NL/BE/LU, A1.4).
// Levels: info on entry, warn when etaS < 8, now when distM < 80. Levels only go up during an approach;
// each level is reported once (Alert.isNew = true on the update where it is reached).
// After passing (camera behind, distance growing and > 100 m) the camera is ignored for 5 minutes
// (lifted when turning around > 120°).
// Forks (N1/N2): beyond an undecided split (Match.fork) a camera is reported when relevant on EITHER branch,
// as 'info' with Alert.branch; it escalates once the fork is decided (or our position has leaned 7 m to its
// branch for 2 updates) and drops silently when the other branch is taken.

import { haversine, bearing, angleDiff, normalizeDeg } from './geo.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const KY = D2R * 6371008.8;
const LEVEL_RANK = { info: 1, warn: 2, now: 3 };
const RANK_LEVEL = [null, 'info', 'warn', 'now'];

/**
 * @typedef {{id:(string|number), type:string, lat:number, lon:number, maxspeed:(number|null),
 *            direction:(number|null), directionSource?:('relation'|'way'|'tag'|null), linkAmbiguous?:boolean, wayIds:Array<string|number>, sectionId:(string|null)}} Camera
 * @typedef {{id:(string|number), camera:Camera, distM:number, etaS:number, level:('info'|'warn'|'now'),
 *            limit:(number|null), overLimit:boolean, isNew:boolean, uncertain:boolean,
 *            branch:('main'|'exit'|'unknown'|null)}} Alert
 *   etaS is Infinity when standing still. isNew is an extension: true exactly once per level.
 *   uncertain (A3.2): camera linkAmbiguous or no usable road data and > 12 m from our course line;
 *   such alerts stay at level 'info' (UI shows "mogelijk"). Without road data only cameras > 12 m LEFT.
 *   branch: camera lies beyond an undecided fork (e.g. an exit): 'exit' = on the *_link branch, 'main' = on
 *   the through road while the other branch is a link, 'unknown' = no link involved or on both branches;
 *   null = no fork involved. Such alerts stay 'info' until the fork is decided.
 *   R2: a camera that lies nearer (edge to edge) to another parallel loaded way it is linked to stays at most
 *   'warn' with uncertain:true on our road.
 */

/**
 * Direction filter for one camera against a travel bearing (amendment A1.1).
 * @param {Camera} cam
 * @param {number} travelBrg degrees
 * @param {number} [tolDeg=50]
 * @returns {boolean} true when the camera may be relevant for this travel direction
 */
export function directionMatches(cam, travelBrg, tolDeg = 50) {
  const d = cam && typeof cam.direction === 'number' && Number.isFinite(cam.direction) ? cam.direction : null;
  if (d == null || travelBrg == null) return true;
  const src = cam.directionSource;
  if (src === null) return true;
  if (src === 'tag') return Math.min(angleDiff(d, travelBrg), angleDiff(d + 180, travelBrg)) < tolDeg;
  return angleDiff(d, travelBrg) < tolDeg; // 'relation', 'way', or legacy (undefined)
}

/**
 * Project a point on a path-ahead polyline.
 * @param {{coords:number[][], cumM:number[], segWayIds:Array}} path
 * @param {number} lat
 * @param {number} lon
 * @returns {{along:number, lateral:number, seg:number, t:number, bearing:number, wayId:any,
 *            clampedStart:boolean, clampedEnd:boolean}|null} lateral > 0 = right of travel direction
 */
export function projectOnPath(path, lat, lon) {
  const c = path.coords;
  if (!c || c.length < 2) return null;
  const kx = Math.cos(lat * D2R) * KY;
  let best = null;
  for (let i = 0; i < c.length - 1; i++) {
    const ax = (c[i][1] - lon) * kx, ay = (c[i][0] - lat) * KY;
    const bx = (c[i + 1][1] - lon) * kx, by = (c[i + 1][0] - lat) * KY;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    let t = -(ax * dx + ay * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = ax + t * dx, py = ay + t * dy;
    const dist = Math.sqrt(px * px + py * py);
    if (!best || dist < best.dist - 1e-9) {
      const len = Math.sqrt(len2);
      // point relative to segment: -p ; cross(seg, point) < 0  => point is right of travel
      const cross = (dx * -py - dy * -px) / len;
      best = { dist, i, t, lateralSigned: -cross * (dist > 0 ? 1 : 0), len, dx, dy };
    }
  }
  if (!best) return null;
  const { i, t } = best;
  const lateral = Math.sign(best.lateralSigned) * best.dist;
  return {
    along: path.cumM[i] + t * best.len,
    lateral,
    seg: i,
    t,
    bearing: normalizeDeg(Math.atan2(best.dx, best.dy) * R2D),
    wayId: path.segWayIds ? path.segWayIds[i] : undefined,
    clampedStart: i === 0 && t === 0,
    clampedEnd: i === c.length - 2 && t === 1,
  };
}

/**
 * Create the alert engine.
 * @param {object} [opts]
 * @param {number} [opts.minDistM=300]
 * @param {number} [opts.leadS=15] seconds of lead time for the warning distance
 * @param {number} [opts.maxDistM=1500]
 * @param {number} [opts.warnEtaS=8]
 * @param {number} [opts.nowDistM=80]
 * @param {number} [opts.passBehindM=100]
 * @param {number} [opts.cooldownMs=300000]
 * @param {number} [opts.tolerance=3] km/h above limit before overLimit
 * @param {number} [opts.coneDeg=60]
 * @param {number} [opts.crossTrackMotorwayM=35]
 * @param {number} [opts.crossTrackOtherM=25]
 * @param {number} [opts.wayCorridorM=30]
 * @param {number} [opts.directionTolDeg=50]
 * @param {number} [opts.minMatchConfidence=0.25]
 * @param {number} [opts.oppositeSideM=15]
 * @param {number} [opts.keepExtraM=150] hysteresis: an active alert stays until this far beyond entry distance
 * @param {number} [opts.lostResetMs=60000] alert state forgotten after this long out of view (not passed)
 * @param {boolean} [opts.enabled=true] default for update()'s `enabled`
 * @param {number} [opts.degradedConfirmTicks=2] updates needed to raise a new alert while the road match is low-confidence
 * @param {number} [opts.forkLeanM=7] past a split: being this much closer to one branch ...
 * @param {number} [opts.forkLeanTicks=2] ... for this many consecutive updates lets that branch escalate
 * @param {number} [opts.coLinkMaxM=15] R2: camera linked to a parallel way but within this of our motorway still counts
 * @param {number} [opts.linkOwnM=6] R2: a *_link owns a co-linked camera only if it is closer than this ...
 * @param {number} [opts.mainAxisM=10] ... and the camera is further than this from the main road axis
 * @param {number} [opts.parallelDeg=30] R2: max bearing difference for a 'parallel' other way
 * @param {number} [opts.fastRightM=18] motorway/trunk: max camera offset to the right of the carriageway
 * @param {number} [opts.fastLeftM=12] motorway/trunk: max camera offset to the left (median)
 * @param {number} [opts.offRoadM=15] further than this (+ min(accuracy,15)/2) from a matched motorway/trunk = not on it
 * @param {number} [opts.geoLeftMaxM=12] no road data and > 22 m/s: reject cameras further left (other carriageway)
 * @param {number} [opts.certainLateralM=12] uncertain cameras become certain within this lateral distance
 * @param {number} [opts.turnAroundDeg=120] heading change that lifts a cooldown
 * @returns {{setCameras:(cams:Camera[])=>void, setSections:(secs:object[])=>void,
 *            update:(state:object, match:object, options?:{enabled?:boolean})=>Alert[], dismiss:(id:any)=>void,
 *            dismissed:()=>Array, reset:()=>void}}
 */
export function createAlertEngine(opts = {}) {
  const o = {
    minDistM: 300, leadS: 15, maxDistM: 1500, warnEtaS: 8, nowDistM: 80, passBehindM: 100,
    cooldownMs: 300000, tolerance: 3, coneDeg: 60, crossTrackMotorwayM: 35, crossTrackOtherM: 25,
    wayCorridorM: 30, directionTolDeg: 50, minMatchConfidence: 0.25, oppositeSideM: 15,
    keepExtraM: 150, lostResetMs: 60000, enabled: true, degradedConfirmTicks: 2,
    forkLeanM: 7, forkLeanTicks: 2, coLinkMaxM: 15, parallelDeg: 30, linkOwnM: 6, mainAxisM: 10, fastRightM: 18, fastLeftM: 12, offRoadM: 15, geoLeftMaxM: 12, certainLateralM: 12, turnAroundDeg: 120,
    ...opts,
  };
  let cameras = [];
  let sectionsById = new Map();
  /** @type {Map<any, {rank:number, lastD:number, entryDist:number, lastSeen:number, dismissed:boolean, cooldownUntil:number}>} */
  let rts = new Map();
  let lastAlerts = [];
  const pend = new Map(); // camera id -> consecutive relevant updates in degraded mode
  let track = [];          // recent positions [{lat, lon}] for the straight-track course
  let trackBrg = null;
  let leanAlt = 0, leanMain = 0; // consecutive updates leaning to the alternative / matched branch of a fork

  /**
   * Straight-line fit (principal axis) through the recent track (>= 150 m, RMS residual < 5 m, agreeing with
   * the heading within 10°). Returns {brg, offset(p)} where offset is the signed lateral distance of a point
   * from the fitted line (> 0 = right), or null when the track is not straight / too short.
   */
  function updateTrack(st, heading) {
    const lastP = track[track.length - 1];
    if (!lastP || haversine(lastP, st) >= 10) track.push({ lat: st.lat, lon: st.lon });
    while (track.length > 2 && haversine(track[1], st) > 400) track.shift();
    if (track.length < 6 || heading == null) return null;
    if (haversine(track[0], st) < 150) return null;
    const lat0 = track[0].lat, lon0 = track[0].lon;
    const kx = Math.cos(lat0 * D2R) * KY;
    const pts = track.map((p) => [(p.lon - lon0) * kx, (p.lat - lat0) * KY]);
    pts.push([(st.lon - lon0) * kx, (st.lat - lat0) * KY]);
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ux = Math.cos(th), uy = Math.sin(th);
    let brg = normalizeDeg(Math.atan2(ux, uy) * R2D);
    if (angleDiff(brg, heading) > 90) { ux = -ux; uy = -uy; brg = normalizeDeg(brg + 180); }
    if (angleDiff(brg, heading) > 10) return null;
    let ss = 0;
    for (const [x, y] of pts) { const r = (x - mx) * uy - (y - my) * ux; ss += r * r; }
    if (Math.sqrt(ss / pts.length) > 5) return null;
    return {
      brg,
      offset: (p) => { const x = (p.lon - lon0) * kx - mx, y = (p.lat - lat0) * KY - my; return x * uy - y * ux; },
    };
  }

  const isFastWay = (w) => !!w && /^(motorway|trunk)/.test(String(w.highway || ''));

  /** Approximate half width of the carriageway by road class (centre line -> edge), metres. */
  const halfWidth = (hw) => /^(motorway|trunk)$/.test(hw || '') ? 6.5 : /^primary$/.test(hw || '') ? 4
    : /_link$/.test(hw || '') ? 2.5 : 3;

  /**
   * R2: a camera linked to (or lying next to) another, roughly parallel loaded way that is closer to it than our
   * road (edge to edge) belongs to that way first: on our road report it at most as 'warn', uncertain.
   * @returns {{nearerOther:boolean, parallelOther:boolean}}
   */
  function otherWays(cam, pr, wayIdSet, match) {
    const res = { nearerOther: false, parallelOther: false };
    let ids = Array.isArray(cam.wayIds) ? cam.wayIds.filter((id) => !wayIdSet.has(id)) : [];
    if (!match || typeof match.wayInfo !== 'function') return res;
    // On a *_link also consider a main road within coLinkMaxM of the camera even if it is not linked.
    const ownHw = String((match.way && match.way.highway) || '');
    if (/_link$/.test(ownHw) && typeof match.nearbyWays === 'function') {
      for (const id of match.nearbyWays(cam.lat, cam.lon, o.coLinkMaxM)) {
        const wi = match.wayInfo(id, cam.lat, cam.lon);
        if (!wayIdSet.has(id) && !ids.includes(id) && wi && !/_link$/.test(String(wi.highway || ''))) ids.push(id);
      }
    }
    if (!ids.length) return res;
    const own = match.wayInfo(pr.wayId, cam.lat, cam.lon);
    const ownEdge = Math.abs(pr.lateral) - halfWidth(own ? own.highway : match.way && match.way.highway);
    for (const id of ids) {
      const wi = match.wayInfo(id, cam.lat, cam.lon);
      if (!wi) continue;
      const parallel = angleDiff(wi.bearing, pr.bearing) < o.parallelDeg || (!wi.oneway && angleDiff(wi.bearing + 180, pr.bearing) < o.parallelDeg);
      if (!parallel) continue;
      res.parallelOther = true;
      const ownLink = /_link$/.test(String((own ? own.highway : match.way && match.way.highway) || ''));
      const otherLink = /_link$/.test(String(wi.highway || ''));
      // Main road vs *_link: the main road owns the camera unless it is clearly at the link
      // (< linkOwnM from the link and > mainAxisM from the main road axis).
      if (!ownLink && otherLink) { if (wi.distM + 0.5 < o.linkOwnM && Math.abs(pr.lateral) > o.mainAxisM) res.nearerOther = true; }
      else if (ownLink && !otherLink) { if (!(Math.abs(pr.lateral) + 0.5 < o.linkOwnM && wi.distM > o.mainAxisM)) res.nearerOther = true; }
      else if (wi.distM - halfWidth(wi.highway) < ownEdge) res.nearerOther = true;
    }
    return res;
  }

  /** Evaluate a camera against one road polyline (main path or the alternative branch of a fork). */
  function evalOnPath(cam, path, wayIdSet, way, match) {
    if (!path || !path.coords || path.coords.length < 2) return { covers: false };
    const pr = projectOnPath(path, cam.lat, cam.lon);
    if (!pr || (pr.clampedEnd && !path.complete)) return { covers: false };
    if (pr.clampedStart) return { covers: true, relevant: false, ahead: false, distM: -1 };
    const ids = Array.isArray(cam.wayIds) && cam.wayIds.length ? cam.wayIds : null;
    const onWay = ids ? ids.some((id) => wayIdSet.has(id)) : null;
    let roadOk = onWay !== false;
    let capWarn = false;
    if (isFastWay(way)) {
      // R2: linked only to a parallel way (e.g. an on-ramp) but within 15 m of our carriageway: do not miss it.
      const ow = match ? otherWays(cam, pr, wayIdSet, match) : null;
      if (onWay === false && ow && ow.parallelOther && Math.abs(pr.lateral) <= o.coLinkMaxM) { roadOk = true; capWarn = ow.nearerOther; }
      else if (onWay === true && ow && ow.nearerOther) capWarn = true;
      // Motorway/trunk (A3.2 C2): a camera for this carriageway stands on the verge (right) or in the
      // median (left). Further out it belongs to a parallel road / the other carriageway, wayIds or not.
      roadOk = roadOk && pr.lateral <= o.fastRightM && pr.lateral >= -o.fastLeftM;
    } else {
      const ow = match && onWay === true ? otherWays(cam, pr, wayIdSet, match) : null;
      if (ow && ow.nearerOther) capWarn = true;
      const corridor = onWay ? o.wayCorridorM * 1.5 : o.wayCorridorM;
      roadOk = roadOk && Math.abs(pr.lateral) <= corridor;
      if (roadOk && onWay === null && way && way.oneway && pr.lateral < -o.oppositeSideM) roadOk = false;
    }
    const dirOk = directionMatches(cam, pr.bearing, o.directionTolDeg);
    const uncertain = !!cam.linkAmbiguous && Math.abs(pr.lateral) >= o.certainLateralM;
    const onLink = Array.isArray(path.linkIds) && path.linkIds.includes(pr.wayId);
    return { covers: true, relevant: roadOk && dirOk, ahead: true, roadRejected: !roadOk, dirOk, distM: pr.along, uncertain, onLink, capWarn };
  }

  function evaluate(cam, st, heading, match, pathWayIds) {
    const d = haversine(st, cam);
    const way = match && match.way ? match.way : null;
    // Far from a matched motorway/trunk: we are not on it (e.g. on an unloaded parallel road).
    // R3: the threshold grows with GPS uncertainty (wide motorway + noisy fix must not count as "off the road").
    const acc = Number.isFinite(st.accuracy) ? Math.max(0, st.accuracy) : 0;
    const offFastRoad = isFastWay(way) && match.distM > o.offRoadM + Math.min(acc, 15) / 2;
    const path = way && !offFastRoad && match.confidence >= o.minMatchConfidence ? match.ahead : null;
    if (path) {
      const r = evalOnPath(cam, path, pathWayIds, way, match);
      if (r.covers) {
        r.straight = d; r.mode = 'path'; r.branch = null; r.forkOpen = false;
        // N1/N2: beyond an unresolved fork a camera counts if it is relevant on EITHER branch (distance along
        // that branch). It is reported as 'info' with branch 'main'|'exit'|'unknown' and only escalates once
        // the fork is decided; on the branch not taken it then drops silently.
        const f = match.fork;
        if (!f || (r.relevant && r.distM <= f.alongM - 5)) return r; // before the fork: unaffected
        const ra = evalOnPath(cam, f.ahead, new Set(f.ahead.wayIds), way, match);
        const altRel = ra.covers && ra.relevant;
        if (r.relevant && altRel) { r.branch = 'unknown'; return r; } // on both: no ambiguity
        // Past the split, the lateral position has leaned to one branch for 2+ updates: that branch escalates.
        if (r.relevant) {
          r.branch = r.onLink ? 'exit' : ra.onLink ? 'main' : 'unknown';
          r.forkOpen = leanMain < o.forkLeanTicks;
          return r;
        }
        if (altRel) {
          return { ...ra, straight: d, mode: 'path', forkOpen: leanAlt < o.forkLeanTicks,
            branch: ra.onLink ? 'exit' : r.onLink ? 'main' : 'unknown' };
        }
        return r;
      }
      // Path ended before the camera: fall through to geometric mode.
    }
    if (heading == null) return { relevant: false, ahead: false, straight: d, distM: d };
    // Without a road, the course line comes from the recent straight track when available (a 2° heading
    // error is 14 m lateral at 400 m; the bearing over 150-400 m of straight track is ~4x better).
    const course = trackBrg ? trackBrg.brg : heading;
    const rel = normalizeDeg(bearing(st, cam) - course);
    const diff = rel > 180 ? 360 - rel : rel;
    const ahead = diff < 90;
    // Lateral offset: from the fitted track line when available (immune to our own position noise).
    const sOff = trackBrg ? trackBrg.offset(cam) : (rel > 180 ? -1 : 1) * d * Math.sin(diff * D2R);
    const left = sOff < 0;
    const cross = Math.abs(sOff);
    const fast = isFastWay(way) || st.speed > 22;
    const crossLimit = fast ? o.crossTrackMotorwayM : o.crossTrackOtherM;
    const dirOk = directionMatches(cam, course, o.directionTolDeg);
    let relevant = diff < o.coneDeg && cross < crossLimit && dirOk;
    // C3: at motorway speed without road data, far-left cameras are on the other carriageway.
    if (st.speed > 22 && left && cross > o.geoLeftMaxM) relevant = false;
    // C2: the camera belongs to the road we are evidently not on.
    if (offFastRoad && Array.isArray(cam.wayIds) && cam.wayIds.includes(way.id)) relevant = false;
    // 'degraded' = a road is matched but not usable: new alerts need a second confirming update.
    // 'geo' = no road at all. N5: only cameras clearly LEFT of the course line (other-carriageway side)
    // are uncertain; a camera on the right verge escalates normally.
    const mode = way ? 'degraded' : 'geo';
    const uncertain = left && cross >= o.certainLateralM;
    // An open fork while the road match is unusable: do not escalate on geometry alone.
    const forkOpen = !!(match && match.fork);
    return { relevant, ahead, roadRejected: false, dirOk, straight: d, distM: Math.max(0, d * Math.cos(diff * D2R)), mode, uncertain, branch: null, forkOpen };
  }

  function limitFor(cam, match) {
    if (typeof cam.maxspeed === 'number') return cam.maxspeed;
    if (cam.sectionId != null) {
      const s = sectionsById.get(cam.sectionId);
      if (s && typeof s.maxspeed === 'number') return s.maxspeed;
    }
    if (match && match.way && typeof match.way.maxspeed === 'number') return match.way.maxspeed;
    return null;
  }

  /**
   * Compute the current alerts. Call once per filtered GPS state.
   * @param {{lat:number,lon:number,speed:number,heading:(number|null),t:number,valid:boolean}} state
   * @param {object|null} match result of matcher.match(state)
   * @param {{enabled?:boolean}} [options] enabled:false -> no alerts (outside NL/BE/LU, amendment A1.4)
   * @returns {Alert[]} sorted by distM ascending
   */
  function update(state, match, options) {
    const enabled = options && options.enabled === false ? false : o.enabled !== false;
    if (!enabled) { lastAlerts = []; return []; }
    if (!state || !state.valid || !Number.isFinite(state.lat)) {
      return lastAlerts.map((a) => ({ ...a, isNew: false }));
    }
    const now = state.t;
    const heading = typeof state.heading === 'number' && Number.isFinite(state.heading) ? state.heading : null;
    const speed = Math.max(0, state.speed || 0);
    const warnDist = Math.min(o.maxDistM, Math.max(o.minDistM, speed * o.leadS));
    const range = o.maxDistM + o.keepExtraM;
    const kx = Math.cos(state.lat * D2R) * KY;
    const pathWayIds = new Set(match && match.ahead ? match.ahead.wayIds : []);
    const speedKmh = speed * 3.6;
    trackBrg = updateTrack(state, heading);
    const f = match && match.fork && match.fork.alongM <= 0 && typeof match.fork.lean === 'number' ? match.fork : null;
    leanAlt = f && f.lean >= o.forkLeanM ? leanAlt + 1 : 0;
    leanMain = f && f.lean <= -o.forkLeanM ? leanMain + 1 : 0;
    const out = [];
    const pendSeen = new Set();

    for (const cam of cameras) {
      if (Math.abs(cam.lat - state.lat) * KY > range || Math.abs(cam.lon - state.lon) * kx > range) continue;
      let rt = rts.get(cam.id);
      if (rt && rt.cooldownUntil) {
        // C7: the cooldown is per direction: after turning around (> 120°) the camera counts again.
        const turned = heading != null && rt.passHeading != null && angleDiff(heading, rt.passHeading) > o.turnAroundDeg;
        if (rt.cooldownUntil > now && !turned) continue;
        rts.delete(cam.id); rt = undefined;
      }
      const ev = evaluate(cam, state, heading, match, pathWayIds);

      if (rt) {
        // Passed? camera behind us, more than passBehindM away and not getting closer.
        if (!ev.ahead && ev.straight > o.passBehindM && ev.straight >= rt.lastD - 2) {
          rts.set(cam.id, { cooldownUntil: now + o.cooldownMs, passHeading: heading });
          continue;
        }
        rt.lastD = ev.straight;
        // Hysteresis: once alerted, a camera stays while it is ahead, on our road, in our direction and
        // not much further away than when it entered (it may fall outside warnDist when we slow down).
        // Without a usable road the camera must still pass the corridor test to stay (a lagging or lost
        // road match must not carry an alert for the other branch / road along).
        const keep = ev.ahead && ev.dirOk !== false && !ev.roadRejected && (ev.mode === 'path' || ev.relevant) &&
          ev.distM <= Math.max(warnDist, rt.entryDist) + o.keepExtraM;
        if (!keep) {
          if (now - rt.lastSeen > o.lostResetMs) rts.delete(cam.id);
          continue;
        }
        rt.lastSeen = now;
        if (rt.dismissed) continue;
      } else {
        if (!ev.relevant || ev.distM > warnDist) continue;
        if (ev.mode === 'degraded') {
          const n = (pend.get(cam.id) || 0) + 1;
          pendSeen.add(cam.id);
          pend.set(cam.id, n);
          if (n < o.degradedConfirmTicks) continue;
        }
        pend.delete(cam.id);
        rt = { rank: 0, lastD: ev.straight, entryDist: ev.distM, lastSeen: now, dismissed: false, cooldownUntil: 0 };
        rts.set(cam.id, rt);
      }

      const distM = Math.max(0, ev.distM);
      const etaS = speed > 0.5 ? distM / speed : Infinity;
      let rank = distM < o.nowDistM ? 3 : etaS < o.warnEtaS ? 2 : 1;
      // A3.2 C2/C3: uncertain cameras (linkAmbiguous or no road data, > 12 m off our line) stay 'info'.
      let uncertain = !!ev.uncertain && rt.rank <= 1;
      if (uncertain || (ev.forkOpen && rt.rank <= 1)) rank = 1;
      // R2: camera belongs first to a nearer parallel way: at most 'warn' here, marked uncertain.
      if (ev.capWarn) { rank = Math.min(rank, 2); uncertain = true; }
      rank = Math.max(rank, ev.capWarn ? Math.min(rt.rank, 2) : rt.rank);
      const isNew = rank > rt.rank;
      rt.rank = rank;
      const limit = limitFor(cam, match);
      out.push({
        id: cam.id, camera: cam, distM, etaS, level: RANK_LEVEL[rank], limit,
        overLimit: limit != null && speedKmh > limit + o.tolerance, isNew, uncertain, branch: ev.branch ?? null,
      });
    }
    for (const id of [...pend.keys()]) if (!pendSeen.has(id)) pend.delete(id);
    out.sort((a, b) => a.distM - b.distM);
    lastAlerts = out;
    return out;
  }

  return {
    /** @param {Camera[]} cams */
    setCameras(cams) {
      cameras = (cams || []).filter((c) => c && Number.isFinite(c.lat) && Number.isFinite(c.lon));
      const ids = new Set(cameras.map((c) => c.id));
      for (const id of [...rts.keys()]) if (!ids.has(id)) rts.delete(id);
    },
    /** @param {Array<{id:any, maxspeed:(number|null)}>} secs */
    setSections(secs) { sectionsById = new Map((secs || []).map((s) => [s.id, s])); },
    update,
    /** Hide a camera until it has been passed (or lost from view). @param {any} id */
    dismiss(id) { const rt = rts.get(id); if (rt && !rt.cooldownUntil) rt.dismissed = true; },
    /** @returns {Array} ids of dismissed cameras */
    dismissed() { return [...rts.entries()].filter(([, r]) => r.dismissed).map(([id]) => id); },
    /** Forget all per-camera state (levels, cooldowns, dismissals). */
    reset() { rts = new Map(); lastAlerts = []; pend.clear(); track = []; trackBrg = null; },
    /** @internal level names, exported for UI convenience */
    LEVEL_RANK,
  };
}
