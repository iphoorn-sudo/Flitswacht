// Flitswacht — js/core/gpsfilter.js
// Turns raw geolocation fixes into a stable State (position, speed, heading).
// - accuracy gate (default 35 m): rejected fix -> last state returned with valid:false
// - position: constant-velocity Kalman filter (scalar covariance) in a local metric plane
// - speed: 1D Kalman on fix.speed (or on derived speed when fix.speed is missing)
// - heading: fix.heading above 2 m/s, else derived from displacement; frozen below 1.5 m/s
// - jump suppression: fixes that are physically impossible given the last state are ignored
//   (dead-reckoned state is returned); after N consecutive "impossible" fixes that agree with
//   each other the filter re-initialises on them (avoids getting stuck after a bad start).

import { normalizeDeg, angleDiff } from './geo.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const KY = D2R * 6371008.8;

/**
 * @typedef {{lat:number, lon:number, accuracy:number, speed:(number|null), heading:(number|null), t:number}} Fix
 * @typedef {{lat:number, lon:number, speed:number, heading:(number|null), accuracy:number, t:number, valid:boolean,
 *            suppressed?:boolean}} State
 */

/** Circular blend from a towards b by factor k (0..1). */
function blendAngle(a, b, k) {
  if (a == null) return normalizeDeg(b);
  let d = normalizeDeg(b - a);
  if (d > 180) d -= 360;
  return normalizeDeg(a + d * k);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Create a GPS filter.
 * @param {object} [opts]
 * @param {number} [opts.maxAccuracy=35] reject fixes with worse accuracy (m)
 * @param {number} [opts.defaultAccuracy=20] assumed accuracy when fix.accuracy is missing (m)
 * @param {number} [opts.maxSpeed=75] m/s, anything implying more is a jump
 * @param {number} [opts.maxAccel=10] m/s², generous bound used for the jump gate
 * @param {number} [opts.posProcessNoise=40] m²/s position process noise (higher = less lag)
 * @param {number} [opts.speedProcessNoise=2] m/s² std of speed change
 * @param {number} [opts.speedMeasStd=0.7] m/s std of fix.speed
 * @param {number} [opts.headingMinSpeed=2] use fix.heading above this speed (m/s)
 * @param {number} [opts.freezeSpeed=1.5] freeze heading below this speed (m/s)
 * @param {number} [opts.jumpResetCount=3] consecutive consistent jumps before re-initialising
 * @returns {{update:(fix:Fix)=>State, reset:()=>void, getState:()=>(State|null)}}
 */
export function createGpsFilter(opts = {}) {
  const o = {
    maxAccuracy: 35, defaultAccuracy: 20, maxSpeed: 75, maxAccel: 10,
    posProcessNoise: 40, speedProcessNoise: 2, speedMeasStd: 0.7,
    headingMinSpeed: 2, freezeSpeed: 1.5, jumpResetCount: 3, minHeadingMoveM: 6, deriveWindowMs: 4000,
    ...opts,
  };

  /** internal state */
  let s = null;          // {lat, lon, P, v, vVar, h, t, acc, rawLat, rawLon, rawAcc}
  let anchor = null;     // [lat, lon] for displacement-derived heading
  let rejects = [];      // consecutive rejected fixes
  let hist = [];         // recent accepted raw fixes (for derived speed)

  function out(valid, extra) {
    return { lat: s.lat, lon: s.lon, speed: s.v, heading: s.h, accuracy: s.acc, t: s.t, valid, ...extra };
  }

  function init(fix, acc) {
    const fs = isNum(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    const fh = isNum(fix.heading) && fix.heading >= 0 ? normalizeDeg(fix.heading) : null;
    s = {
      lat: fix.lat, lon: fix.lon, P: acc * acc,
      v: fs ?? 0, vVar: fs != null ? o.speedMeasStd ** 2 : 25,
      h: fs != null && fs > o.headingMinSpeed ? fh : null,
      t: fix.t, acc,
      rawLat: fix.lat, rawLon: fix.lon, rawAcc: acc,
    };
    anchor = [fix.lat, fix.lon];
    rejects = [];
    hist = [{ lat: fix.lat, lon: fix.lon, acc, t: fix.t }];
  }

  /**
   * Feed one raw fix.
   * @param {Fix} fix
   * @returns {State}
   */
  function update(fix) {
    if (!fix || !isNum(fix.lat) || !isNum(fix.lon) || !isNum(fix.t) ||
        Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) {
      return s ? out(false) : { lat: NaN, lon: NaN, speed: 0, heading: null, accuracy: Infinity, t: fix?.t ?? 0, valid: false };
    }
    const acc = isNum(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : o.defaultAccuracy;
    if (acc > o.maxAccuracy) {
      if (s) return out(false);
      return { lat: fix.lat, lon: fix.lon, speed: 0, heading: null, accuracy: acc, t: fix.t, valid: false };
    }
    if (!s) { init(fix, acc); return out(true); }

    const dt = (fix.t - s.t) / 1000;
    if (dt <= 0.05) return out(true); // duplicate / out-of-order fix: ignore

    // Local metric frame centred on the current estimate.
    const kx = Math.cos(s.lat * D2R) * KY;
    const mx = (fix.lon - s.lon) * kx, my = (fix.lat - s.lat) * KY;

    // Prediction (constant velocity along the current heading).
    let px = 0, py = 0;
    if (s.h != null && s.v > o.freezeSpeed) {
      px = s.v * Math.sin(s.h * D2R) * dt;
      py = s.v * Math.cos(s.h * D2R) * dt;
    }

    // ---- jump gate ----
    const innov = Math.hypot(mx - px, my - py);
    const sigma = Math.sqrt(s.P + acc * acc);
    const allowed = 0.5 * o.maxAccel * dt * dt + 3 * sigma + 5;
    const rawDist = Math.hypot((fix.lon - s.rawLon) * kx, (fix.lat - s.rawLat) * KY);
    const impliedSpeed = Math.max(0, rawDist - acc - s.rawAcc) / dt;
    if (innov > allowed || impliedSpeed > o.maxSpeed) {
      // Consecutive rejects that agree with each other mean the *filter* is wrong: re-init.
      const prev = rejects[rejects.length - 1];
      if (prev) {
        const ddt = Math.max(0.1, (fix.t - prev.t) / 1000);
        const d = Math.hypot((fix.lon - prev.lon) * kx, (fix.lat - prev.lat) * KY);
        if (d / ddt > o.maxSpeed + (acc + prev.accuracy) / ddt) rejects = [];
      }
      rejects.push({ lat: fix.lat, lon: fix.lon, t: fix.t, accuracy: acc });
      if (rejects.length >= o.jumpResetCount) {
        init(fix, acc);
        return out(true, { reinit: true });
      }
      // Return dead-reckoned estimate without committing it.
      return {
        lat: s.lat + py / KY, lon: s.lon + px / kx, speed: s.v, heading: s.h,
        accuracy: s.acc, t: fix.t, valid: true, suppressed: true,
      };
    }
    rejects = [];
    hist.push({ lat: fix.lat, lon: fix.lon, acc, t: fix.t });
    while (hist.length > 1 && fix.t - hist[0].t > o.deriveWindowMs + 1500) hist.shift();
    if (hist.length > 8) hist.shift();

    // ---- position Kalman update ----
    const Ppred = s.P + o.posProcessNoise * dt;
    const K = Ppred / (Ppred + acc * acc);
    const nx = px + K * (mx - px), ny = py + K * (my - py);
    const newLat = s.lat + ny / KY, newLon = s.lon + nx / kx;
    const P = (1 - K) * Ppred;

    // ---- speed ----
    let zv, rv;
    if (isNum(fix.speed) && fix.speed >= 0) {
      zv = fix.speed; rv = o.speedMeasStd ** 2;
    } else {
      // Displacement-derived speed over a window of up to ~4 s of raw fixes, with the expected
      // noise distance removed (otherwise GPS jitter at standstill reads as a few m/s).
      let ref = hist[0];
      for (const h of hist) if (fix.t - h.t <= o.deriveWindowMs) { ref = h; break; }
      const wdt = Math.max(dt, (fix.t - ref.t) / 1000);
      const d = Math.hypot((fix.lon - ref.lon) * kx, (fix.lat - ref.lat) * KY);
      const noise2 = acc * acc + ref.acc * ref.acc;
      zv = Math.sqrt(Math.max(0, d * d - noise2)) / wdt;
      rv = (noise2 * 0.5) / (wdt * wdt) + 1;
    }
    const vVarPred = s.vVar + (o.speedProcessNoise * dt) ** 2;
    const Kv = vVarPred / (vVarPred + rv);
    let v = s.v + Kv * (zv - s.v);
    if (v < 0.05) v = 0;
    const vVar = (1 - Kv) * vVarPred;

    // ---- heading ----
    let h = s.h;
    const fixHeading = isNum(fix.heading) && fix.heading >= 0 ? normalizeDeg(fix.heading) : null;
    if (v >= o.freezeSpeed) {
      if (fixHeading != null && v > o.headingMinSpeed) {
        // Device course is already smoothed; follow it quickly. Big jumps at low speed get less weight.
        // At motorway speed the true course changes slowly, so smooth more.
        const k = h == null ? 1 : (angleDiff(h, fixHeading) > 90 && v < 6 ? 0.3 : v > 15 ? 0.55 : 0.8);
        h = blendAngle(h, fixHeading, k);
        anchor = [newLat, newLon];
      } else if (zv >= o.freezeSpeed) {
        // Derived heading only while the (noise-corrected) measured motion is real, not while the
        // filtered speed is still decaying after a sudden stop.
        const ax = (newLon - anchor[1]) * kx, ay = (newLat - anchor[0]) * KY;
        const moved = Math.hypot(ax, ay);
        if (moved >= Math.max(o.minHeadingMoveM, 2 * acc)) {
          const mh = normalizeDeg(Math.atan2(ax, ay) * R2D);
          // A derived course that reverses (> 100°) in one step is filter overshoot / jitter, not driving.
          if (h == null || angleDiff(h, mh) <= 100) h = blendAngle(h, mh, h == null ? 1 : 0.6);
          anchor = [newLat, newLon];
        }
      }
    } else {
      // Frozen: keep h. Keep the anchor at the current spot so jitter while standing
      // still does not pollute the first derived heading after pulling away.
      anchor = [newLat, newLon];
    }

    s = { lat: newLat, lon: newLon, P, v, vVar, h, t: fix.t, acc,
      rawLat: fix.lat, rawLon: fix.lon, rawAcc: acc };
    return out(true);
  }

  return {
    update,
    /** Forget all state. */
    reset() { s = null; anchor = null; rejects = []; hist = []; },
    /** @returns {State|null} last committed state */
    getState() { return s ? out(true) : null; },
  };
}
