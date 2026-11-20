// Flitswacht — js/core/matcher.js
// Map-matching of a filtered State onto OSM ways.
// - uniform grid index (segments are rasterised along their length, so long diagonal
//   segments do not blow up the index)
// - score = lateral distance + heading penalty (oneway respected: wrong-way candidates dropped)
// - hysteresis: the previously matched way gets a bonus and a switch to another way must win
//   for several consecutive fixes (more fixes if the new way is not connected to the old one,
//   i.e. a parallel road). This prevents flapping to a parallelweg or an afrit.
// - every Match carries `ahead`: the road polyline in driving direction (following the most
//   plausible continuation over junctions), used by alerts.js for road-aware filtering.

import { normalizeDeg, angleDiff } from './geo.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const KY = D2R * 6371008.8;

/**
 * @typedef {{id:(string|number), name?:string, ref?:string, highway?:string, maxspeed:(number|null),
 *            oneway:boolean, geometry:number[][]}} Way
 * @typedef {{coords:number[][], cumM:number[], segWayIds:Array<string|number>, wayIds:Array<string|number>,
 *            lengthM:number, complete:boolean}} PathAhead
 *   coords[i] = [lat,lon]; cumM[i] = distance along path to coords[i]; segWayIds[i] = way id of segment i->i+1;
 *   complete = path reached the requested length (false = ended at a dead end / ambiguous junction / data edge)
 *   fork = first junction on the path with a second plausible continuation (or null)
 *   linkIds = ids of *_link ways on the path
 * @typedef {{alongM:number, ahead:PathAhead, lean?:number}} Fork  alternative branch starting alongM metres ahead
 *   (0 = we are past the split); lean = distance to matched way minus distance to the alternative (m)
 * @typedef {{way:(Way|null), distM:number, segIndex:number, bearing:(number|null), confidence:number,
 *            point?:{lat:number,lon:number}, dir?:number, ahead?:(PathAhead|null), fork?:(Fork|null),
 *            wayInfo?:Function}} Match   wayInfo(id, lat, lon) = the matcher's wayInfo (distance to a loaded way)
 */

const NULL_MATCH = Object.freeze({ way: null, distM: Infinity, segIndex: -1, bearing: null, confidence: 0, ahead: null, fork: null });

const nodeKey = (lat, lon) => `${lat.toFixed(7)},${lon.toFixed(7)}`;

/**
 * Create a map matcher.
 * @param {object} [opts]
 * @param {number} [opts.radiusM=40] candidate search radius (grows with poor accuracy up to 60 m)
 * @param {number} [opts.cellM=100] grid cell size in metres
 * @param {number} [opts.headingWeight=0.5] metres of cost per degree heading difference
 * @param {number} [opts.hysteresisM=12] cost bonus for the previously matched way
 * @param {number} [opts.switchConfirm=2] consecutive wins needed to switch to a connected way
 * @param {number} [opts.switchConfirmUnconnected=4] same, for a way not connected to the previous one
 * @param {number} [opts.minHeadingSpeed=2] heading considered reliable above this speed (m/s)
 * @param {number} [opts.wrongWayDeg=110] drop oneway candidates with heading difference above this
 * @param {number} [opts.aheadM=1600] length of the `ahead` path
 * @param {number} [opts.continueMaxTurnDeg=50] max turn angle to follow a way over a junction
 * @param {number} [opts.linkPenaltyM=6] cost added to *_link candidates while the main road still fits (< 12 m)
 * @param {number} [opts.linkSwitchFixes=3] fixes a *_link must keep winning before switching to it (A3.2 C1)
 * @param {number} [opts.linkSwitchLateralM=12] ...or: distance to the main road at least this
 * @param {number} [opts.linkSwitchHeadingDeg=8] ...and heading difference with the main road above this
 * @param {number} [opts.forkAltM=20] a diverging connected way closer than this marks an unresolved fork
 * @param {number} [opts.forkHysteresisM=4] hysteresis against a connected through-road branch (Y-split)
 * @param {number} [opts.forkDecideM=8] ...unless it is this much further away than the matched way (decided)
 * @returns {{setWays:(ways:Way[])=>void, setWaysAsync:(ways:Way[], options?:object)=>Promise<boolean>,
 *            match:(state:object)=>Match, reset:()=>void,
 *            pathAhead:(m:Match, maxM?:number)=>(PathAhead|null), stats:()=>object}}
 */
export function createMatcher(opts = {}) {
  const o = {
    radiusM: 40, cellM: 100, headingWeight: 0.5, hysteresisM: 12, switchConfirm: 2,
    switchConfirmUnconnected: 4, minHeadingSpeed: 2, wrongWayDeg: 110, aheadM: 1600,
    continueMaxTurnDeg: 50, linkPenaltyM: 6, linkSwitchFixes: 3, linkSwitchLateralM: 12, linkSwitchHeadingDeg: 8,
    forkAltM: 20, forkDecideM: 8, forkHysteresisM: 4,
    ...opts,
  };

  let ways = [];
  let segA = new Float64Array(0), segB = new Float64Array(0); // [lat,lon] pairs
  let segWay = new Int32Array(0), segIdx = new Int32Array(0);
  let stamp = new Int32Array(0), query = 0;
  let grid = new Map();
  let cLat = 1, cLon = 1;
  let nodes = new Map();       // nodeKey -> [[wayIdx, ptIdx], ...]
  let neighbours = [];         // wayIdx -> Set(wayIdx) sharing at least one node
  let wayIndexById = new Map();

  let prev = null;             // {wi, dir, seg}
  let pending = null;          // {wi, count}

  const cellKey = (iy, ix) => iy * 4194304 + ix; // unique for |ix| < 2^21

  /**
   * Replace the road network. Builds the grid and node index.
   * @param {Way[]} newWays
   */
  let buildGen = 0; // generation counter: a newer setWays/setWaysAsync cancels an older async build

  /**
   * Build a complete index for newWays without touching the live one. Generator: yields regularly so an
   * async caller can split the work; the return value is the finished index.
   */
  function* buildIndex(newWays) {
    const W = (newWays || []).filter((w) => w && Array.isArray(w.geometry) && w.geometry.length >= 2);
    let n = 0, latSum = 0;
    for (const w of W) { n += w.geometry.length - 1; latSum += w.geometry[0][0]; }
    const lat0 = W.length ? latSum / W.length : 52;
    const x = {
      ways: W, cLat: o.cellM / KY, cLon: o.cellM / (KY * Math.max(0.05, Math.cos(lat0 * D2R))),
      segA: new Float64Array(n * 2), segB: new Float64Array(n * 2), segWay: new Int32Array(n), segIdx: new Int32Array(n),
      stamp: new Int32Array(n), grid: new Map(), nodes: new Map(), wayIndexById: new Map(), neighbours: W.map(() => new Set()),
    };
    const { segA: A, segB: B, segWay: SW, segIdx: SI, grid: G, nodes: ND, neighbours: NB, cLat: cla, cLon: clo } = x;
    yield; // allocation done: give the caller a chance to yield before the main loop
    let k = 0, sinceYield = 0;
    for (let wi = 0; wi < W.length; wi++) {
      const g = W[wi].geometry;
      x.wayIndexById.set(W[wi].id, wi);
      for (let i = 0; i < g.length; i++) {
        const key = nodeKey(g[i][0], g[i][1]);
        let list = ND.get(key);
        if (!list) ND.set(key, (list = []));
        for (const [owi] of list) if (owi !== wi) { NB[wi].add(owi); NB[owi].add(wi); }
        list.push([wi, i]);
        if (i === 0) continue;
        const a = g[i - 1], b = g[i];
        A[2 * k] = a[0]; A[2 * k + 1] = a[1]; B[2 * k] = b[0]; B[2 * k + 1] = b[1];
        SW[k] = wi; SI[k] = i - 1;
        // Rasterise: sample every half cell along the segment.
        const lenCells = Math.max(Math.abs(b[0] - a[0]) / cla, Math.abs(b[1] - a[1]) / clo);
        const steps = Math.max(1, Math.ceil(lenCells * 2));
        let lastKey = NaN;
        for (let s = 0; s <= steps; s++) {
          const f = s / steps;
          const ck = cellKey(Math.floor((a[0] + (b[0] - a[0]) * f) / cla), Math.floor((a[1] + (b[1] - a[1]) * f) / clo));
          if (ck === lastKey) continue;
          lastKey = ck;
          let cell = G.get(ck);
          if (!cell) G.set(ck, (cell = []));
          if (cell[cell.length - 1] !== k) cell.push(k);
        }
        k++;
        if (++sinceYield >= 16) { sinceYield = 0; yield; }
      }
    }
    return x;
  }

  /** Atomically switch to a finished index; keeps hysteresis if the previous way still exists. */
  function commit(x) {
    const prevWayId = prev ? ways[prev.wi]?.id : undefined;
    ({ ways, segA, segB, segWay, segIdx, stamp, grid, nodes, neighbours, wayIndexById, cLat, cLon } = x);
    query = 0;
    if (prev && prevWayId !== undefined && wayIndexById.has(prevWayId)) prev = { ...prev, wi: wayIndexById.get(prevWayId) };
    else prev = null;
    pending = null;
  }

  /**
   * Replace the road network synchronously (builds grid and node index, then switches).
   * Cancels any running setWaysAsync.
   * @param {Way[]} newWays
   */
  function setWays(newWays) {
    buildGen++;
    const it = buildIndex(newWays);
    let r = it.next();
    while (!r.done) r = it.next();
    commit(r.value);
  }

  /**
   * Replace the road network in time slices (for iOS Safari without requestIdleCallback). match() keeps
   * using the OLD index until the new one is complete, then switches atomically.
   * @param {Way[]} newWays
   * @param {{yieldFn?:()=>Promise<void>, budgetMs?:number, isCancelled?:()=>boolean, now?:()=>number}} [options]
   *   yieldFn: awaited between slices of at most ~budgetMs (a slice ends at budgetMs/2 plus the last step, to absorb
 *   GC spikes) (default: setTimeout 0); now: clock (default performance.now)
   * @returns {Promise<boolean>} true when switched; false when cancelled (isCancelled() or a newer setWays/setWaysAsync)
   */
  async function setWaysAsync(newWays, { yieldFn, budgetMs = 12, isCancelled, now } = {}) {
    const gen = ++buildGen;
    const clock = now || (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
    const yf = yieldFn || (() => new Promise((res) => setTimeout(res, 0)));
    const dead = () => gen !== buildGen || (isCancelled && isCancelled());
    const it = buildIndex(newWays);
    let t0 = clock();
    let r = it.next();
    while (!r.done) {
      // Yield at half the budget: single steps occasionally take several ms (GC, Map growth), so the
      // longest uninterrupted block stays within ~budgetMs + spike rather than 2x budget.
      if (clock() - t0 >= budgetMs / 2) {
        await yf();
        if (dead()) return false;
        t0 = clock();
      }
      r = it.next();
    }
    if (dead()) return false;
    commit(r.value);
    return true;
  }

  const isLink = (w) => /_link$/.test(String(w && w.highway || ''));

  /** Two connected ways that belong to the same road (continuation, not a branch). */
  function sameRoad(a, b) {
    if (a === b) return true;
    if (!neighbours[a] || !neighbours[a].has(b)) return false;
    const wa = ways[a], wb = ways[b];
    if (isLink(wa) !== isLink(wb)) return false;
    if (wa.ref && wb.ref) return wa.ref === wb.ref;
    if (wa.name && wb.name) return wa.name === wb.name;
    return !!wa.highway && wa.highway === wb.highway;
  }

  /** Continuation options at point pi of way curWi (other ways only, plus own way when atEnd is false). */
  function junctionOptions(curWi, pi, lastBrg, visited, curWay) {
    const g = ways[curWi].geometry;
    const list = nodes.get(nodeKey(g[pi][0], g[pi][1])) || [];
    const opts = [];
    for (const [owi, opi] of list) {
      if (owi === curWi) continue;
      const ow = ways[owi];
      const og = ow.geometry;
      for (const odir of [1, -1]) {
        if (odir < 0 && ow.oneway) continue;
        const np = opi + odir;
        if (np < 0 || np >= og.length) continue;
        if (visited && visited.has(owi * 2 + (odir > 0 ? 1 : 0))) continue;
        const kx = Math.cos(og[opi][0] * D2R) * KY;
        const ob = normalizeDeg(Math.atan2((og[np][1] - og[opi][1]) * kx, (og[np][0] - og[opi][0]) * KY) * R2D);
        const turn = lastBrg == null ? 0 : angleDiff(lastBrg, ob);
        if (turn > o.continueMaxTurnDeg) continue;
        let score = -turn;
        if (curWay.ref && ow.ref === curWay.ref) score += 40;
        if (curWay.name && ow.name === curWay.name) score += 25;
        if (curWay.highway && ow.highway === curWay.highway) score += 15;
        else if (isLink(ow) && !isLink(curWay)) score -= 30;
        opts.push({ owi, pi: opi, odir, score, turn });
      }
    }
    return opts.sort((a, b) => b.score - a.score);
  }

  /**
   * Build the road polyline ahead, starting at (startLat,startLon) on way wi heading for geometry point nextPt
   * in direction dir. Records the first fork (a junction with more than one plausible continuation within
   * continueMaxTurnDeg) as `fork = {alongM, ahead}` where ahead is the alternative branch.
   * @returns {PathAhead}
   */
  function buildAhead(wi, nextPt0, dir, startLat, startLon, maxM, noFork = false) {
    const coords = [[startLat, startLon]];
    const cumM = [0];
    const segWayIds = [];
    const wayIdSet = new Set();
    let total = 0;
    let complete = false;
    let curWi = wi, curDir = dir;
    let nextPt = nextPt0;
    const visited = new Set();
    let lastBrg = null;
    let forkAt = null; // {alongM, owi, pi, odir, lat, lon}
    for (let guard = 0; guard < 40; guard++) {
      const w = ways[curWi];
      const g = w.geometry;
      wayIdSet.add(w.id);
      visited.add(curWi * 2 + (curDir > 0 ? 1 : 0));
      while (nextPt >= 0 && nextPt < g.length) {
        const [pl, po] = coords[coords.length - 1];
        const [ql, qo] = g[nextPt];
        const kx = Math.cos(pl * D2R) * KY;
        const dx = (qo - po) * kx, dy = (ql - pl) * KY;
        const d = Math.hypot(dx, dy);
        if (d > 0.01) {
          lastBrg = normalizeDeg(Math.atan2(dx, dy) * R2D);
          if (total + d >= maxM) {
            const f = (maxM - total) / d;
            coords.push([pl + (ql - pl) * f, po + (qo - po) * f]);
            total = maxM; cumM.push(total); segWayIds.push(w.id);
            complete = true;
            break;
          }
          total += d;
          coords.push([ql, qo]); cumM.push(total); segWayIds.push(w.id);
        }
        // Interior node where another way branches off at a shallow angle: a fork (e.g. an exit).
        const isEnd = curDir > 0 ? nextPt === g.length - 1 : nextPt === 0;
        if (!noFork && !forkAt && !isEnd) {
          const alt = junctionOptions(curWi, nextPt, lastBrg, visited, w)[0];
          if (alt) forkAt = { alongM: total, ...alt };
        }
        nextPt += curDir;
      }
      if (complete) break;
      const endPt = curDir > 0 ? g.length - 1 : 0;
      const options = junctionOptions(curWi, endPt, lastBrg, visited, w);
      if (!options.length) break;
      if (!noFork && !forkAt && options.length > 1) forkAt = { alongM: total, ...options[1] };
      const best = options[0];
      curWi = best.owi; curDir = best.odir; nextPt = best.pi + best.odir;
    }
    const linkIds = [...wayIdSet].filter((id) => isLink(ways[wayIndexById.get(id)]));
    const path = { coords, cumM, segWayIds, wayIds: [...wayIdSet], linkIds, lengthM: total, complete, fork: null };
    if (forkAt && maxM - forkAt.alongM > 1) {
      const og = ways[forkAt.owi].geometry;
      const alt = buildAhead(forkAt.owi, forkAt.pi + forkAt.odir, forkAt.odir, og[forkAt.pi][0], og[forkAt.pi][1], maxM - forkAt.alongM, true);
      alt.cumM = alt.cumM.map((c) => c + forkAt.alongM);
      path.fork = { alongM: forkAt.alongM, ahead: alt };
    }
    return path;
  }

  /**
   * Match a filtered state onto the road network.
   * @param {{lat:number,lon:number,speed:number,heading:(number|null),accuracy:number,valid:boolean}} state
   * @returns {Match}
   */
  function match(state) {
    if (!state || !state.valid || !Number.isFinite(state.lat) || !Number.isFinite(state.lon) || !ways.length) {
      if (prev && prev.last && state && !state.valid) {
        return { ...prev.last, confidence: prev.last.confidence * 0.7 };
      }
      return { ...NULL_MATCH };
    }
    const lat = state.lat, lon = state.lon;
    const heading = typeof state.heading === 'number' && Number.isFinite(state.heading) ? state.heading : null;
    const reliable = heading != null && state.speed >= o.minHeadingSpeed;
    const hw = heading == null ? 0 : reliable ? o.headingWeight : 0.1;
    const acc = Number.isFinite(state.accuracy) ? state.accuracy : 0;
    const r = Math.max(o.radiusM, Math.min(acc * 1.5, 60));

    const kx = Math.cos(lat * D2R) * KY;
    const qr = r + o.cellM * 0.5;
    const iy0 = Math.floor((lat - qr / KY) / cLat), iy1 = Math.floor((lat + qr / KY) / cLat);
    const ix0 = Math.floor((lon - qr / kx) / cLon), ix1 = Math.floor((lon + qr / kx) / cLon);
    query++;
    if (query > 2e9) { stamp.fill(0); query = 1; }

    const perWay = new Map(); // wi -> best candidate for that way
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const cell = grid.get(cellKey(iy, ix));
        if (!cell) continue;
        for (let c = 0; c < cell.length; c++) {
          const k = cell[c];
          if (stamp[k] === query) continue;
          stamp[k] = query;
          const ax = (segA[2 * k + 1] - lon) * kx, ay = (segA[2 * k] - lat) * KY;
          const bx = (segB[2 * k + 1] - lon) * kx, by = (segB[2 * k] - lat) * KY;
          const dx = bx - ax, dy = by - ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const px = ax + t * dx, py = ay + t * dy;
          const dist = Math.sqrt(px * px + py * py);
          if (dist > r) continue;
          const wi = segWay[k];
          const w = ways[wi];
          const segBrg = normalizeDeg(Math.atan2(dx, dy) * R2D);
          let dir = 1, hd = 0;
          if (heading != null) {
            const fwd = angleDiff(heading, segBrg);
            if (w.oneway) {
              hd = fwd;
              if (reliable && hd > o.wrongWayDeg) continue; // wrong way on a oneway: not our road
            } else if (fwd <= 90) { hd = fwd; } else { hd = 180 - fwd; dir = -1; }
          } else if (prev && prev.wi === wi) {
            dir = prev.dir;
          } else if (w.oneway) {
            dir = 1;
          }
          let cost = dist + hw * hd;
          if (prev && sameRoad(prev.wi, wi)) cost -= o.hysteresisM; // previous road (incl. its continuation)
          const cur = perWay.get(wi);
          if (!cur || cost < cur.cost) {
            const lastSeg = w.geometry.length - 2;
            // projection clamped at the end of the way (in driving direction): we ran off this way
            const atEnd = dir > 0 ? (t === 1 && segIdx[k] === lastSeg) : (t === 0 && segIdx[k] === 0);
            perWay.set(wi, { wi, k, t, dist, hd, dir, cost, segBrg, px, py, atEnd });
          }
        }
      }
    }

    if (!perWay.size) { prev = null; pending = null; return { ...NULL_MATCH }; }

    // C1: the main road we were on (previous way or its same-road continuation). While it still fits,
    // *_link candidates (exits) get a small penalty and may only win after persisting.
    let main = null;
    if (prev && !isLink(ways[prev.wi])) {
      for (const c of perWay.values()) {
        if (!isLink(ways[c.wi]) && sameRoad(prev.wi, c.wi) && (!main || c.cost < main.cost)) main = c;
      }
    }
    if (main && main.dist < 12) for (const c of perWay.values()) if (isLink(ways[c.wi])) c.cost += o.linkPenaltyM;
    // N1: at a Y-split of two through roads (connected, not a link, other ref/name) the full hysteresis
    // would keep us on the preferred branch far too long; such a branch only has to beat it by forkHysteresisM.
    if (main) {
      for (const c of perWay.values()) {
        if (c !== main && !isLink(ways[c.wi]) && !sameRoad(prev.wi, c.wi) &&
            (neighbours[prev.wi].has(c.wi) || neighbours[main.wi].has(c.wi))) c.cost -= o.hysteresisM - o.forkHysteresisM;
      }
    }
    const cands = [...perWay.values()].sort((a, b) => a.cost - b.cost);
    let best = cands[0];
    const prevCand = prev ? perWay.get(prev.wi) : undefined;
    if (main && best !== main && isLink(ways[best.wi])) {
      if (pending && pending.wi === best.wi) pending.count++;
      else pending = { wi: best.wi, count: 1 };
      const diverged = main.dist >= o.linkSwitchLateralM && reliable && main.hd > o.linkSwitchHeadingDeg;
      if (pending.count >= o.linkSwitchFixes || diverged) pending = null;
      else best = main;
    } else if (prevCand && best.wi !== prevCand.wi && !sameRoad(prevCand.wi, best.wi)) {
      const connected = neighbours[prevCand.wi].has(best.wi);
      // Ran off the end of the previous way onto a connected one: plain continuation, switch at once.
      const need = connected ? (prevCand.atEnd ? 1 : o.switchConfirm) : o.switchConfirmUnconnected;
      if (pending && pending.wi === best.wi) pending.count++;
      else pending = { wi: best.wi, count: 1 };
      if (pending.count < need) best = prevCand;
      else pending = null;
    } else {
      pending = null;
    }

    // Confidence: closeness, heading agreement, margin over the runner-up.
    const second = cands.find((c) => c !== best);
    const distF = Math.exp(-best.dist / 20);
    const headF = heading == null ? 0.5 : reliable ? Math.max(0, 1 - best.hd / 90) : 0.7;
    const marginF = second ? Math.min(1, Math.max(0, (second.cost - best.cost) / 15)) : 1;
    const confidence = Math.max(0, Math.min(1, distF * (0.4 + 0.6 * headF) * (0.6 + 0.4 * marginF)));

    const w = ways[best.wi];
    const travel = best.dir > 0 ? best.segBrg : normalizeDeg(best.segBrg + 180);
    const pLat = lat + best.py / KY, pLon = lon + best.px / kx;
    const knownDir = heading != null || (prev && prev.wi === best.wi) || w.oneway;
    const ahead = knownDir ? buildAhead(best.wi, best.dir > 0 ? segIdx[best.k] + 1 : segIdx[best.k], best.dir, pLat, pLon, o.aheadM) : null;
    // C4: an ambiguous fork, either ahead on the path or just behind us (the branch we did not
    // (yet) take is still a close, connected, heading-compatible candidate).
    let fork = ahead ? ahead.fork : null;
    if (knownDir) {
      // The fork counts as decided once the other branch is clearly further away than ours.
      const alt = cands.find((c) => c.wi !== best.wi && c.dist < o.forkAltM && c.dist - best.dist < o.forkDecideM && !sameRoad(best.wi, c.wi) &&
        (neighbours[best.wi].has(c.wi) || (prev && neighbours[prev.wi] && neighbours[prev.wi].has(c.wi))) &&
        (!reliable || c.hd < 40) && (!ways[c.wi].oneway || c.dir > 0));
      if (alt) {
        const aLat = lat + alt.py / KY, aLon = lon + alt.px / kx;
        // lean > 0: we are closer to the alternative branch than to the matched one (metres)
        fork = { alongM: 0, lean: best.dist - alt.dist,
          ahead: buildAhead(alt.wi, alt.dir > 0 ? segIdx[alt.k] + 1 : segIdx[alt.k], alt.dir, aLat, aLon, o.aheadM, true) };
      }
    }
    const m = {
      way: w, distM: best.dist, segIndex: segIdx[best.k], bearing: knownDir ? travel : null,
      confidence, point: { lat: pLat, lon: pLon }, dir: best.dir, ahead, fork, wayInfo, nearbyWays,
    };
    prev = { wi: best.wi, dir: best.dir, last: m };
    return m;
  }

  /**
   * Distance from a point to the geometry of a loaded way, with that way's bearing there and its class.
   * @param {string|number} id way id
   * @param {number} lat
   * @param {number} lon
   * @returns {{distM:number, bearing:number, highway:(string|null), oneway:boolean}|null} null if not loaded
   */
  function wayInfo(id, lat, lon) {
    const wi = wayIndexById.get(id);
    if (wi === undefined) return null;
    const w = ways[wi], g = w.geometry;
    const kx = Math.cos(lat * D2R) * KY;
    let best = null;
    for (let i = 0; i < g.length - 1; i++) {
      const ax = (g[i][1] - lon) * kx, ay = (g[i][0] - lat) * KY;
      const bx = (g[i + 1][1] - lon) * kx, by = (g[i + 1][0] - lat) * KY;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || d < best.distM) best = { distM: d, bearing: normalizeDeg(Math.atan2(dx, dy) * R2D) };
    }
    return best && { ...best, highway: w.highway || null, oneway: !!w.oneway };
  }

  /**
   * Loaded ways with a segment within radiusM of a point (grid lookup).
   * @returns {Array<string|number>} way ids
   */
  function nearbyWays(lat, lon, radiusM) {
    const kx = Math.cos(lat * D2R) * KY;
    const qr = radiusM + o.cellM * 0.5;
    const out = new Set();
    for (let iy = Math.floor((lat - qr / KY) / cLat); iy <= Math.floor((lat + qr / KY) / cLat); iy++) {
      for (let ix = Math.floor((lon - qr / kx) / cLon); ix <= Math.floor((lon + qr / kx) / cLon); ix++) {
        const cell = grid.get(cellKey(iy, ix));
        if (cell) for (const k of cell) out.add(ways[segWay[k]].id);
      }
    }
    return [...out].filter((id) => { const wi = wayInfo(id, lat, lon); return wi && wi.distM <= radiusM; });
  }

  return {
    setWays,
    setWaysAsync,
    wayInfo,
    nearbyWays,
    match,
    /** Forget hysteresis state (e.g. after a long GPS gap). */
    reset() { prev = null; pending = null; },
    /**
     * Road polyline ahead of a match (recomputed with a custom length).
     * @param {Match} m
     * @param {number} [maxM]
     * @returns {PathAhead|null}
     */
    pathAhead(m, maxM = o.aheadM) {
      if (!m || !m.way || !m.point) return null;
      const wi = wayIndexById.get(m.way.id);
      if (wi === undefined) return null;
      const d = m.dir || 1;
      return buildAhead(wi, d > 0 ? m.segIndex + 1 : m.segIndex, d, m.point.lat, m.point.lon, maxM);
    },
    /** @returns {{ways:number, segments:number, cells:number}} */
    stats() { return { ways: ways.length, segments: segWay.length, cells: grid.size }; },
  };
}
