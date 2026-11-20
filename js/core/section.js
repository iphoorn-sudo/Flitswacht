// Flitswacht — js/core/section.js
// Trajectcontrole (average speed check) tracker.
// - start: the segment between the previous and the current valid position CROSSES the start line
//   (perpendicular to the section in its start point, |lateral| <= 18 m), heading within 30° of the
//   section, and - when a road is matched - that road lies on the section (N3). Position = matched
//   point on the road when available. A start that is > 25 m off the geometry in the first 300 m is
//   cancelled silently.
//   Works with missed fixes and at high speed (A3.2 C5). enteredAt is interpolated on the crossing.
// - distance done: progress along Section.geometry (projection, monotone maximum), so GPS jitter in a
//   traffic jam does not count (A3.2 C6). Without geometry: displacement from an anchor, only while
//   moving (speed >= 1 m/s) and in steps >= max(3 m, accuracy/2).
// - end: with geometry when progress reaches the section length (time interpolated); always when the end
//   line is crossed; without geometry after 2 km beyond the length; with geometry when > 200 m off the
//   route for 60 s.
// - limit: re-read from the section on every update (sections may expose a time-dependent getter,
//   e.g. A58 100/130 km/h) (A3.2 C8). allowedRemainingKmh assumes the current limit for the whole section.

import { haversine, bearing, angleDiff, polylineLength } from './geo.js';

const D2R = Math.PI / 180;
const KY = D2R * 6371008.8;

/**
 * @typedef {{id:string, name?:string, maxspeed:(number|null), lengthM:number, start:{lat:number,lon:number},
 *            end:{lat:number,lon:number}, geometry:number[][]}} Section
 * @typedef {{section:Section, enteredAt:number, distDoneM:number, distLeftM:number, avgKmh:number,
 *            limit:(number|null), allowedRemainingKmh:(number|null), status:('ok'|'over'), elapsedS:number}} SectionStatus
 *   allowedRemainingKmh: null when the limit is unknown; 0 when the allowed time is already used up.
 *   elapsedS is an extension.
 */

/** Position of p relative to q in a frame along bearing brg: {along (m, >0 = beyond q), lateral (m, >0 = right)}. */
function frame(p, q, brg) {
  const kx = Math.cos(q.lat * D2R) * KY;
  const x = (p.lon - q.lon) * kx, y = (p.lat - q.lat) * KY;
  const s = Math.sin(brg * D2R), c = Math.cos(brg * D2R);
  return { along: x * s + y * c, lateral: x * c - y * s };
}

/** Bearing of a polyline from its first point over roughly the first `dist` metres. */
function bearingFromStart(geom, dist) {
  let acc = 0;
  for (let i = 1; i < geom.length; i++) {
    acc += haversine(geom[i - 1], geom[i]);
    if (acc >= dist || i === geom.length - 1) return bearing(geom[0], geom[i]);
  }
  return null;
}

/**
 * Create a trajectcontrole tracker.
 * @param {object} [opts]
 * @param {number} [opts.startRadiusM=40] first-fix fallback: within this distance past the start line
 * @param {number} [opts.lineHalfWidthM=60] end line half width
 * @param {number} [opts.startLateralM=18] start line half width (N3)
 * @param {number} [opts.roadOnSectionM=15] a matched road must be within this of the section geometry (N3)
 * @param {number} [opts.earlyCheckM=300] within the first ... m of the section,
 * @param {number} [opts.earlyOffM=25] ... more than this off the geometry cancels the start silently
 * @param {number} [opts.maxGapMs=15000] max time between two states to detect a crossing
 * @param {number} [opts.overrunM=2000] no geometry: give up this far beyond the section length
 * @param {number} [opts.offRouteM=200] geometry: off-route distance ...
 * @param {number} [opts.offRouteMs=60000] ... for this long ends tracking
 * @param {number} [opts.dirTolDeg=30] direction tolerance against the section direction at the start (N3)
 * @param {number} [opts.restartBlockMs=60000] do not restart the same section within this time
 * @param {number} [opts.tolerance=0] km/h above the limit before status 'over'
 * @returns {{update:(state:object, alerts:Array, sections:Section[], match?:object)=>(SectionStatus|null),
 *            reset:()=>void, getLast:()=>(SectionStatus|null)}}
 */
export function createSectionTracker(opts = {}) {
  const o = {
    startRadiusM: 40, lineHalfWidthM: 60, startLateralM: 18, roadOnSectionM: 15, earlyCheckM: 300, earlyOffM: 25,
    maxGapMs: 15000, overrunM: 2000, offRouteM: 200, offRouteMs: 60000,
    dirTolDeg: 30, restartBlockMs: 60000, tolerance: 0, minMatchConfidence: 0.25, ...opts,
  };
  let active = null;
  let last = null;
  let prevSt = null;
  let hist = []; // recent positions (for a noise-robust start-line lateral)
  const blocked = new Map();
  const geomCache = new WeakMap();

  function info(sec) {
    let g = geomCache.get(sec);
    if (g) return g;
    let geom = Array.isArray(sec.geometry) && sec.geometry.length >= 2 ? sec.geometry : null;
    if (geom && haversine(geom[0], sec.start) > haversine(geom[geom.length - 1], sec.start)) geom = [...geom].reverse();
    let cum = null;
    if (geom) {
      cum = [0];
      for (let i = 1; i < geom.length; i++) cum.push(cum[i - 1] + haversine(geom[i - 1], geom[i]));
    }
    const lengthM = sec.lengthM > 0 ? sec.lengthM : geom ? cum[cum.length - 1] : haversine(sec.start, sec.end);
    const startBrg = geom ? bearingFromStart(geom, 50) : null;
    const endBrg = geom ? bearing(geom[Math.max(0, geom.length - 2)], geom[geom.length - 1]) : null;
    g = { geom, cum, geomLen: cum ? cum[cum.length - 1] : 0, lengthM, startBrg, endBrg, chordBrg: bearing(sec.start, sec.end) };
    geomCache.set(sec, g);
    return g;
  }

  /** Project st on the section geometry near segment hint: {along (scaled to lengthM), dist, seg}. */
  function project(inf, st, hint, windowM) {
    const g = inf.geom, cum = inf.cum;
    const kx = Math.cos(st.lat * D2R) * KY;
    let best = null;
    const from = Math.max(0, hint - 1);
    for (let i = from; i < g.length - 1; i++) {
      if (cum[i] - cum[from] > windowM) break;
      const ax = (g[i][1] - st.lon) * kx, ay = (g[i][0] - st.lat) * KY;
      const bx = (g[i + 1][1] - st.lon) * kx, by = (g[i + 1][0] - st.lat) * KY;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || d < best.dist) best = { dist: d, seg: i, raw: cum[i] + t * (cum[i + 1] - cum[i]) };
    }
    // geometry length and the published lengthM may differ slightly: scale
    best.along = inf.geomLen > 0 ? best.raw * (inf.lengthM / inf.geomLen) : best.raw;
    return best;
  }

  function currentLimit(a, sections) {
    const fresh = (sections || []).find((s) => s && s.id === a.section.id);
    if (fresh && fresh !== a.section) a.section = fresh; // data refresh: keep geometry info, take new object
    const v = a.section.maxspeed;
    return typeof v === 'number' ? v : a.limitFallback;
  }

  function result(a, t, speed) {
    const elapsedS = Math.max(0, (t - a.enteredAt) / 1000);
    const avgKmh = elapsedS >= 1 ? (a.distDone / elapsedS) * 3.6 : (speed || 0) * 3.6;
    const lengthM = a.info.lengthM;
    const distLeftM = Math.max(0, lengthM - a.distDone);
    const limit = a.limit;
    let allowed = null;
    if (limit != null && limit > 0) {
      const remT = lengthM / (limit / 3.6) - elapsedS;
      allowed = remT <= 0 ? 0 : (distLeftM / remT) * 3.6;
    }
    return {
      section: a.section, enteredAt: a.enteredAt, distDoneM: a.distDone, distLeftM, avgKmh, limit,
      allowedRemainingKmh: allowed,
      status: limit != null && avgKmh > limit + o.tolerance ? 'over' : 'ok',
      elapsedS,
    };
  }

  function tryStart(st, pos, alerts, sections, onRoad) {
    const alertSecIds = new Set();
    const alertLimits = new Map();
    for (const al of alerts || []) {
      const c = al && al.camera;
      if (c && c.type === 'section_start' && c.sectionId != null) {
        alertSecIds.add(c.sectionId);
        if (typeof c.maxspeed === 'number') alertLimits.set(c.sectionId, c.maxspeed);
      }
    }
    const usePrev = prevSt && st.t - prevSt.t <= o.maxGapMs && st.t > prevSt.t;
    const reach = usePrev ? haversine(prevSt.pos, pos) + o.lineHalfWidthM : o.startRadiusM;
    for (const sec of sections || []) {
      if (!sec || !sec.start || !sec.end) continue;
      if ((blocked.get(sec.id) || 0) > st.t) continue;
      if (haversine(pos, sec.start) > reach) continue;
      const inf = info(sec);
      // N3: the matched road (if any) must be the section's road.
      if (onRoad && inf.geom && project(inf, onRoad, 0, 2000).dist > o.roadOnSectionM) continue;
      // Direction of travel: the filtered heading (one noisy step between two fixes can be 30° off);
      // the bearing over the recent positions only when there is no usable heading.
      const base = hist.length ? hist[0] : prevSt && prevSt.pos;
      const travel = st.heading != null && (st.speed || 0) > 2 ? st.heading
        : base && haversine(base, pos) > 10 ? bearing(base, pos) : st.heading;
      if (travel == null) continue;
      let dir;
      if (inf.startBrg != null) {
        if (angleDiff(travel, inf.startBrg) > o.dirTolDeg) continue;
        dir = inf.startBrg;
      } else {
        // No geometry: trust the (direction-filtered) section_start alert, else the chord loosely.
        if (!alertSecIds.has(sec.id) && angleDiff(travel, inf.chordBrg) >= 90) continue;
        dir = travel;
      }
      const cur = frame(pos, sec.start, dir);
      if (cur.along < 0) continue;
      let enteredAt, past;
      if (usePrev) {
        const pv = frame(prevSt.pos, sec.start, dir);
        if (pv.along >= 0) continue; // already past before: no crossing now
        const f = -pv.along / (cur.along - pv.along);
        let lat = pv.lateral + f * (cur.lateral - pv.lateral);
        // Average with the lateral offset of the recent approach (<= 250 m before the line): one noisy
        // fix must not decide (GPS noise ~5 m vs an 18 m line).
        const approach = hist.map((h) => frame(h, sec.start, dir)).filter((q) => q.along > -250 && q.along < 0);
        if (approach.length >= 2) lat = (lat + approach.reduce((acc, q) => acc + q.lateral, 0)) / (approach.length + 1);
        if (Math.abs(lat) > o.startLateralM) continue;
        enteredAt = prevSt.t + f * (st.t - prevSt.t);
        past = cur.along;
      } else {
        if (cur.along > o.startRadiusM || Math.abs(cur.lateral) > o.startLateralM) continue;
        past = cur.along;
        enteredAt = st.t - (past / Math.max(1, st.speed || 0)) * 1000;
      }
      const a = {
        section: sec, info: inf, enteredAt, distDone: past, seg: 0, offSince: null,
        anchor: { lat: st.lat, lon: st.lon }, limitFallback: alertLimits.get(sec.id) ?? null, limit: null,
      };
      if (inf.geom) {
        const pr = project(inf, pos, 0, Math.max(500, past + 500));
        a.seg = pr.seg; a.distDone = Math.max(0, pr.along);
      }
      a.limit = currentLimit(a, sections);
      return a;
    }
    return null;
  }

  /** Advance an active section with a new valid state; returns {finishedAt} or null. */
  function advance(a, st) {
    const inf = a.info;
    const prevDone = a.distDone;
    if (inf.geom) {
      const window = Math.max(1000, haversine(prevSt ? prevSt.pos : st, st) * 3 + 500);
      const pr = project(inf, st, a.seg, window);
      if (pr.dist > o.offRouteM) {
        a.offSince ??= st.t;
        if (st.t - a.offSince > o.offRouteMs) return { finishedAt: st.t };
        return null;
      }
      a.offSince = null;
      // N3: a start on a parallel road is cancelled silently within the first few hundred metres.
      if (a.distDone < o.earlyCheckM && pr.dist > o.earlyOffM) return { cancel: true };
      a.seg = pr.seg;
      if (pr.along > a.distDone) a.distDone = pr.along;
    } else {
      const minStep = Math.max(3, (st.accuracy || 0) / 2);
      if ((st.speed || 0) >= 1) {
        const step = haversine(a.anchor, st);
        if (step >= minStep) { a.distDone += step; a.anchor = { lat: st.lat, lon: st.lon }; }
      }
    }
    const L = inf.lengthM;
    // Reached the end: interpolate the moment the section length was reached.
    // (with geometry only: summed displacements are not precise enough to define the end)
    if (inf.geom && a.distDone >= L && prevDone < L) {
      const tPrev = prevSt ? prevSt.t : st.t;
      const f = a.distDone > prevDone ? (L - prevDone) / (a.distDone - prevDone) : 1;
      a.distDone = L;
      return { finishedAt: tPrev + f * (st.t - tPrev) };
    }
    // End line crossed (useful without geometry or when lengthM is off).
    if (prevSt) {
      const dir = inf.endBrg ?? (haversine(prevSt, st) > 2 ? bearing(prevSt, st) : st.heading ?? inf.chordBrg);
      const pv = frame(prevSt, a.section.end, dir), cu = frame(st, a.section.end, dir);
      if (pv.along < 0 && cu.along >= 0) {
        const f = -pv.along / (cu.along - pv.along);
        if (Math.abs(pv.lateral + f * (cu.lateral - pv.lateral)) <= o.lineHalfWidthM && a.distDone >= L * 0.5) {
          return { finishedAt: prevSt.t + f * (st.t - prevSt.t) };
        }
      }
    }
    if (!inf.geom && a.distDone > L + o.overrunM) return { finishedAt: st.t };
    return null;
  }

  /**
   * Advance the tracker. Call once per filtered state, after the alert engine.
   * @param {{lat:number,lon:number,speed:number,heading:(number|null),accuracy?:number,t:number,valid:boolean}} state
   * @param {Array} alerts current alerts (used to confirm direction of section_start cameras without geometry)
   * @param {Section[]} sections sections in the loaded area
   * @returns {SectionStatus|null}
   */
  function update(state, alerts, sections, match) {
    if (!state || !state.valid || !Number.isFinite(state.lat)) {
      return active ? result(active, prevSt ? prevSt.t : active.enteredAt, 0) : null;
    }
    if (prevSt && state.t <= prevSt.t) return active ? result(active, prevSt.t, state.speed) : null;
    // Position on the road when a road is matched with confidence (removes GPS lateral noise and the lane
    // offset when crossing the start line); raw filtered position otherwise.
    const onRoad = match && match.way && match.point && match.confidence >= o.minMatchConfidence ? match.point : null;
    const pos = onRoad || { lat: state.lat, lon: state.lon };
    let out = null;
    if (active) {
      active.limit = currentLimit(active, sections);
      const fin = advance(active, state);
      if (!fin) {
        out = last = result(active, state.t, state.speed);
      } else if (fin.cancel) {
        blocked.set(active.section.id, state.t + o.restartBlockMs);
        active = null; last = null;
      } else {
        last = result(active, fin.finishedAt, state.speed);
        blocked.set(active.section.id, state.t + o.restartBlockMs);
        active = null;
      }
    }
    if (!active) {
      const started = tryStart(state, pos, alerts, sections, onRoad);
      if (started) { active = started; out = last = result(active, state.t, state.speed); }
    }
    prevSt = { lat: state.lat, lon: state.lon, t: state.t, speed: state.speed, heading: state.heading, pos };
    hist.push(pos);
    if (hist.length > 8) hist.shift();
    return out;
  }

  return {
    update,
    /** Stop tracking and forget everything. */
    reset() { active = null; last = null; prevSt = null; hist = []; blocked.clear(); },
    /** @returns {SectionStatus|null} last computed status (after the section ended: the final result) */
    getLast() { return last; },
  };
}
