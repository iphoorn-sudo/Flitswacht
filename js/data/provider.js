// Flitswacht — dataprovider (W-DATA), contract + AMENDEMENT A1.3.
// Drie soorten verzoeken: (a) handhaving NL+BE+LU, 1x per 7 dagen, sleutel 'enforcement';
// (c) A3.1 'camera-ways' (wegen rond camera's, met node-id's), 1x per 7 dagen, apart zodat falen (a) niet breekt;
// (b) wegen per z10-tegel, vers 30 dagen. Dagbudget 50 (in de store), 30 s pauze na 429/406/504,
// max. 1 gelijktijdig verzoek, offline terugval op oude cache, camera->wayIds-koppeling hier.
import { tileKey, tileBounds } from '../core/geo.js';
import * as overpassMod from './overpass.js';
import { effectiveMaxspeed, THROTTLE_PAUSE_MS } from './overpass.js';
import { DAILY_BUDGET } from './store.js';
import { buildSegmentIndex, linkCameras } from './link.js';
import { dest, normBbox } from './geoutil.js';

export const DAY_MS = 24 * 3600 * 1000;
export const ENFORCEMENT_KEY = 'enforcement';
export const CAMERA_WAYS_KEY = 'camera-ways';
const WEEKLY = [ENFORCEMENT_KEY, CAMERA_WAYS_KEY];
const NETWORK_RETRY_MS = 60 * 1000; // na 'offline' (geen verbinding) pas na 1 min opnieuw proberen; kost geen budget

/**
 * createProvider({ store, fetch, now, endpoints, zoom=10, waysMaxAgeMs=30d, enforcementMaxAgeMs=7d,
 *   enforcementRetryMs=30min, tileRetryMs=5min, throttlePauseMs=30s, dailyBudget=50, maxTilesInMemory=12,
 *   fetchOptions, overpass, isOnline })
 * isOnline: () => boolean (default navigator.onLine !== false); false -> geen enkele poging (D2).
 */
export function createProvider({
  store = null,
  fetch,
  now = Date.now,
  endpoints,
  zoom = 10,
  waysMaxAgeMs = 30 * DAY_MS,
  enforcementMaxAgeMs = 7 * DAY_MS,
  enforcementRetryMs = 30 * 60 * 1000,
  tileRetryMs = 5 * 60 * 1000,
  throttlePauseMs = THROTTLE_PAUSE_MS,
  dailyBudget = DAILY_BUDGET,
  maxTilesInMemory = 12,
  fetchOptions = {},
  overpass = overpassMod,
  isOnline = () => globalThis.navigator?.onLine !== false,
} = {}) {
  // wekelijkse datasets: key -> {t, data}
  const weekly = new Map();
  const weeklyTriedStore = new Set();
  const weeklyFailedAt = new Map();
  let netRetryAt = 0; // na 'offline'-fout
  const tiles = new Map(); // key -> {t, data}
  const tileFailedAt = new Map();
  // N8: pauzes per verzoektype ('enforcement' | 'camera-ways' | 'tiles'); 429/406 gelden voor alle typen.
  const kindOf = (key) => (WEEKLY.includes(key) ? key : 'tiles');
  const cooldownsByKind = new Map(); // kind -> Map(endpoint -> ms)  (504)
  const sharedCooldowns = new Map(); // endpoint -> ms (429/406)
  const cooldownsFor = (kind) => { let m = cooldownsByKind.get(kind); if (!m) cooldownsByKind.set(kind, (m = new Map())); return m; };
  const pausedUntilByKind = new Map(); // kind -> ms
  const pendingNet = new Map(); // key -> {promise, resolve}
  let queue = [];
  let running = false;
  let inFlight = 0;
  let maxInFlightSeen = 0;
  let pausedUntil = 0; // globaal (429/406)
  let lastError = null;
  let online = true;
  let lastNetOk = null;
  let lastWanted = [];
  let wantedBox = null;
  let merged = null;
  const listeners = new Set();

  // --- dagbudget (store als die er is, anders in geheugen) -----------------------------------
  let budgetLeft = null;
  let memBudget = { day: null, used: 0 };
  const today = () => { const d = new Date(now()); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  let budgetDay = null;
  async function refreshBudget() {
    if (budgetLeft != null && budgetDay === today()) return;
    budgetDay = today();
    if (store?.budgetLeft) {
      try { budgetLeft = await store.budgetLeft(dailyBudget); return; } catch (e) { lastError = e; }
    }
    if (memBudget.day !== budgetDay) memBudget = { day: budgetDay, used: 0 };
    budgetLeft = Math.max(0, dailyBudget - memBudget.used);
  }
  async function takeBudget() {
    if (store?.consumeBudget) {
      try {
        const r = await store.consumeBudget(dailyBudget);
        budgetLeft = r.left; budgetDay = today();
        return r.ok;
      } catch (e) { lastError = e; }
    }
    const d = today();
    if (memBudget.day !== d) memBudget = { day: d, used: 0 };
    if (memBudget.used >= dailyBudget) { budgetLeft = 0; return false; }
    memBudget.used++;
    budgetLeft = dailyBudget - memBudget.used; budgetDay = d;
    return true;
  }
  async function hasBudget() {
    await refreshBudget();
    return !(budgetLeft === 0 && budgetDay === today());
  }
  const deviceOnline = () => { try { return isOnline() !== false; } catch { return true; } };
  const kindPaused = (kind) => now() < pausedUntil || now() < (pausedUntilByKind.get(kind) ?? 0);
  const canNet = (key = null) => (key == null || !kindPaused(kindOf(key))) && now() >= pausedUntil && now() >= netRetryAt &&
    deviceOnline() && !(budgetLeft === 0 && budgetDay === today());

  // --- hulpfuncties ---------------------------------------------------------------------------
  function invalidate() {
    merged = null;
    const data = getData();
    const st = status();
    for (const cb of listeners) { try { cb(data, st); } catch { /* luisteraarfout negeren */ } }
  }

  function setTile(key, rec) {
    tiles.delete(key);
    tiles.set(key, { t: rec.t, data: rec.data });
    if (tiles.size > maxTilesInMemory) {
      const keep = new Set(lastWanted);
      for (const k of tiles.keys()) {
        if (tiles.size <= maxTilesInMemory) break;
        if (!keep.has(k)) tiles.delete(k);
      }
    }
  }

  function wantedKeys(lat, lon, heading, speed) {
    const keys = [];
    const add = (la, lo) => { const k = tileKey(la, lo, zoom); if (!keys.includes(k)) keys.push(k); };
    add(lat, lon);
    if (heading != null && Number.isFinite(heading) && (speed ?? 0) > 2) {
      // ~15 min vooruit, 8–40 km
      const ahead = Math.max(8000, Math.min(40000, (speed || 0) * 900));
      for (let d = 4000; d <= ahead; d += 8000) { const [a, b] = dest(lat, lon, heading, d); add(a, b); }
      for (const off of [-30, 30]) { const [a, b] = dest(lat, lon, heading + off, 6000); add(a, b); }
    }
    for (let br = 0; br < 360; br += 45) { const [a, b] = dest(lat, lon, br, 3000); add(a, b); }
    return keys;
  }

  function boxOf(keys) {
    if (!keys.length) return null;
    let s = 90, w = 180, n = -90, e = -180;
    for (const k of keys) {
      const b = normBbox(tileBounds(k));
      s = Math.min(s, b.s); w = Math.min(w, b.w); n = Math.max(n, b.n); e = Math.max(e, b.e);
    }
    const m = 0.02; // ~2 km marge
    return { s: s - m, w: w - m, n: n + m, e: e + m };
  }
  const inBox = (b, lat, lon) => !b || (lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e);

  async function loadTile(key) {
    if (tiles.has(key)) return tiles.get(key);
    let rec = null;
    try { rec = await store?.getTile(key); } catch (e) { lastError = e; }
    if (rec?.data) { setTile(key, rec); return tiles.get(key); }
    return null;
  }

  function requestNet(key) {
    const p = pendingNet.get(key);
    if (p) return p.promise;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    pendingNet.set(key, { promise, resolve });
    queue.push(key);
    pump();
    return promise;
  }

  function dropQueue() {
    for (const k of queue) { const e = pendingNet.get(k); pendingNet.delete(k); e?.resolve(false); }
    queue = [];
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        if (!canNet()) { dropQueue(); break; }
        const key = queue.shift();
        const entry = pendingNet.get(key);
        if (!canNet(key)) { pendingNet.delete(key); entry?.resolve(false); continue; } // alleen dít type gepauzeerd
        let ok = false;
        inFlight++;
        maxInFlightSeen = Math.max(maxInFlightSeen, inFlight);
        try {
          const opts = {
            ...fetchOptions, fetch, now, cooldowns: cooldownsFor(kindOf(key)), sharedCooldowns, isOnline: deviceOnline,
            beforeRequest: hasBudget, chargeRequest: takeBudget, // D2: pas tellen na een serverantwoord
            ...(endpoints ? { endpoints } : {}),
          };
          let clean;
          if (key === ENFORCEMENT_KEY) {
            const d = await overpass.fetchEnforcement(opts);
            clean = { ways: [], cameras: d.cameras, sections: d.sections };
          } else if (key === CAMERA_WAYS_KEY) {
            const d = await overpass.fetchCameraWays(opts);
            clean = { ways: d.ways, cameras: [], sections: [] };
          } else {
            const d = await overpass.fetchArea(normBbox(tileBounds(key)), opts);
            clean = { ways: d.ways, cameras: [], sections: [] };
          }
          let rec = { key, t: now(), data: clean };
          try { rec = (await store?.putTile(key, clean)) || rec; } catch (e) { lastError = e; }
          if (WEEKLY.includes(key)) { weekly.set(key, { t: rec.t, data: clean }); weeklyFailedAt.delete(key); }
          else { setTile(key, rec); tileFailedAt.delete(key); }
          online = true;
          lastNetOk = now();
          ok = true;
          invalidate();
        } catch (e) {
          lastError = e;
          if (e?.code === 'offline') {
            online = false;
            netRetryAt = now() + NETWORK_RETRY_MS; // geen verbinding: geen datasets 'mislukt' markeren
          } else if (e?.code !== 'budget') {
            // Serverfout op alléén camera-ways: verbinding is er; state niet 'offline' (UI: "Beperkt")
            if (key !== CAMERA_WAYS_KEY) online = false;
            if (WEEKLY.includes(key)) weeklyFailedAt.set(key, now()); else tileFailedAt.set(key, now());
          }
          if (e?.throttled) {
            const until = now() + throttlePauseMs;
            const rateLimited = (e.attempts || []).some((a) => a.status === 429 || a.status === 406) || e.status === 429 || e.status === 406;
            if (rateLimited) pausedUntil = Math.max(pausedUntil, until); // server remt ons af: alles pauzeren
            else { const k = kindOf(key); pausedUntilByKind.set(k, Math.max(pausedUntilByKind.get(k) ?? 0, until)); }
          }
        } finally {
          inFlight--;
          pendingNet.delete(key);
          entry?.resolve(ok);
        }
      }
    } finally {
      running = false;
    }
  }

  let ensureCount = 0;

  async function ensureAround(lat, lon, headingDeg = null, speed = 0) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    await refreshBudget();
    let changed = false;
    const keys = wantedKeys(lat, lon, headingDeg, speed);
    if (keys.join('|') !== lastWanted.join('|')) {
      lastWanted = keys;
      wantedBox = boxOf(keys);
      changed = true;
    }
    const waits = [];

    // (a) handhaving en (c) camera-ways: wekelijks
    for (const key of WEEKLY) {
      if (!weekly.has(key) && !weeklyTriedStore.has(key)) {
        weeklyTriedStore.add(key);
        let rec = null;
        try { rec = await store?.getTile(key); } catch (e) { lastError = e; }
        if (rec?.data) { weekly.set(key, { t: rec.t, data: rec.data }); changed = true; }
      }
      const cur = weekly.get(key);
      const fa = weeklyFailedAt.get(key);
      if ((!cur || now() - cur.t >= enforcementMaxAgeMs) && (fa == null || now() - fa >= enforcementRetryMs) && canNet(key)) {
        waits.push(requestNet(key));
      }
    }

    // (b) wegen-tegels
    for (const key of keys) {
      const had = tiles.has(key);
      const tile = await loadTile(key);
      if (tile && !had) changed = true;
      if (tile && now() - tile.t < waysMaxAgeMs) continue;
      const fa = tileFailedAt.get(key);
      if (fa != null && now() - fa < tileRetryMs) continue;
      if (!canNet(key)) continue;
      waits.push(requestNet(key));
    }

    // N8: handhaving eerst, dan wegen-tegels, de zware camera-ways als laatste
    const order = new Map([[ENFORCEMENT_KEY, -1], ...keys.map((k, i) => [k, i]), [CAMERA_WAYS_KEY, keys.length]]);
    queue = queue.filter((k) => {
      if (order.has(k)) return true;
      const e = pendingNet.get(k); pendingNet.delete(k); e?.resolve(false); return false;
    });
    queue.sort((a, b) => order.get(a) - order.get(b));

    if (changed) invalidate();
    await Promise.all(waits);
    if (store && ++ensureCount % 25 === 0) {
      try { await store.prune(90 * DAY_MS, 200); } catch { /* niet kritiek */ }
    }
  }

  // Objecten met een tijdsafhankelijke limiet krijgen `maxspeedBase` + een getter `maxspeed` die
  // effectiveMaxspeed(obj, nu) teruggeeft; zo is Way/Camera/Section.maxspeed altijd de nu geldende waarde.
  function timed(obj) {
    if (!obj.maxspeedConditional && !obj.maxspeedConditionalForward) return obj;
    const o = { ...obj, maxspeedBase: obj.maxspeed };
    delete o.maxspeed;
    Object.defineProperty(o, 'maxspeed', { enumerable: true, configurable: true, get: () => effectiveMaxspeed(o, new Date(now())) });
    return o;
  }

  function getData() {
    if (merged) return merged;
    const box = wantedBox;
    const ways = new Map();
    // camera-ways eerst: die hebben node-id's (A3.1); gededupliceerd met de tegels
    for (const w of weekly.get(CAMERA_WAYS_KEY)?.data.ways || []) {
      if (!ways.has(w.id) && (!box || w.geometry.some((p) => inBox(box, p[0], p[1])))) ways.set(w.id, timed(w));
    }
    for (const { data } of tiles.values()) for (const w of data.ways || []) if (!ways.has(w.id)) ways.set(w.id, timed(w));
    const wayList = [...ways.values()];
    let cameras = [], sections = [];
    const enforcement = weekly.get(ENFORCEMENT_KEY);
    if (enforcement) {
      const cams = (enforcement.data.cameras || []).filter((c) => inBox(box, c.lat, c.lon));
      const index = buildSegmentIndex(wayList);
      cameras = linkCameras(cams, wayList, { index }).map(timed);
      sections = (enforcement.data.sections || []).filter((s) =>
        inBox(box, s.start.lat, s.start.lon) || inBox(box, s.end.lat, s.end.lon) ||
        (s.geometry || []).some((p) => inBox(box, p[0], p[1]))).map(timed);
    }
    merged = { ways: wayList, cameras, sections };
    return merged;
  }

  function status() {
    const t = now();
    let freshTiles = 0, staleTiles = 0;
    for (const k of lastWanted) {
      const tile = tiles.get(k);
      if (!tile) continue;
      if (t - tile.t < waysMaxAgeMs) freshTiles++; else staleTiles++;
    }
    const missing = lastWanted.filter((k) => !tiles.has(k)).length;
    const enforcement = weekly.get(ENFORCEMENT_KEY);
    const camWays = weekly.get(CAMERA_WAYS_KEY);
    const enforcementAgeMs = enforcement ? t - enforcement.t : null;
    const enfStale = (enforcement ? enforcementAgeMs >= enforcementMaxAgeMs : false) ||
      (camWays ? t - camWays.t >= enforcementMaxAgeMs : false);
    const stale = enfStale || staleTiles > 0;
    const budgetExhausted = budgetLeft === 0 && budgetDay === today();
    const pausedKinds = {};
    for (const k of [ENFORCEMENT_KEY, CAMERA_WAYS_KEY, 'tiles']) {
      const u = Math.max(pausedUntil, pausedUntilByKind.get(k) ?? 0);
      if (t < u) pausedKinds[k] = u;
    }
    const paused = t < pausedUntil || 'tiles' in pausedKinds;
    const loading = inFlight > 0 || queue.length > 0;
    const hasData = !!enforcement || tiles.size > 0;
    const deviceOffline = !deviceOnline();
    let state;
    if (loading) state = 'loading';
    else if (!lastWanted.length) state = 'idle';
    else if (!hasData) state = lastError ? 'error' : 'idle';
    else if (!online || deviceOffline || ((budgetExhausted || paused) && (stale || missing > 0 || !enforcement))) state = 'offline';
    else if (stale) state = 'stale';
    else state = 'ok';
    return {
      state, // 'idle'|'loading'|'ok'|'stale'|'offline'|'error'
      online: online && !deviceOffline, // laatste netwerkpoging gelukt én toestel niet offline
      loading,
      lastError: lastError ? { code: lastError.code ?? null, message: String(lastError.message || lastError) } : null,
      enforcementAgeMs, // null = nog geen handhavingsdata
      enforcementCount: enforcement ? (enforcement.data.cameras || []).length : 0,
      cameraWaysLoaded: !!camWays, // A3.1: false = camera-koppeling alleen via wegen-tegels
      cameraWaysAgeMs: camWays ? t - camWays.t : null,
      tilesLoaded: tiles.size,
      budgetLeft, // null tot de eerste ensureAround
      budgetExhausted,
      pausedUntil: paused ? Math.max(pausedUntil, pausedUntilByKind.get('tiles') ?? 0) : null, // gevolgen voor wegen
      pausedKinds, // N8: { enforcement?, 'camera-ways'?, tiles? } -> ms; alleen actieve pauzes
      stale, // handhaving > 7 d of een gewenste wegen-tegel > 30 d
      wanted: lastWanted.length,
      freshTiles, staleTiles, missing,
      pending: queue.length + inFlight,
      maxConcurrent: maxInFlightSeen,
      lastNetOk,
    };
  }

  return {
    ensureAround,
    getData,
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    status,
  };
}
