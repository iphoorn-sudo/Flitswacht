// Flitswacht — eigen meldingen van mobiele flitsers (W-DATA, AMENDEMENT A2.1).
// Lokaal opgeslagen (localStorage-achtig, geïnjecteerd) met in-memory fallback, en een aansluitpunt voor een
// latere externe bron (datacontract RESEARCH_MOBIEL.md §6). Geen DOM.
import { dist } from './geoutil.js';

export const STORAGE_KEY = 'flitswacht.reports.v1';
export const HOUR_MS = 3600 * 1000;
export const MOBILE_TTL_MS = 3 * HOUR_MS; // nieuwe mobiele melding
export const CONFIRM_EXTEND_MS = 2 * HOUR_MS; // per bevestiging
export const MOBILE_MAX_MS = 8 * HOUR_MS; // na eerste melding
export const DEDUP_RADIUS_M = 150;
export const DEDUP_HEADING_DEG = 40;
export const OWN_RELIABILITY = 0.9;

const KINDS = new Set(['mobiel', 'vast_eigen']);
const iso = (ms) => new Date(ms).toISOString();
const ms = (s) => (s == null ? null : Date.parse(s));
const angle = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const normDeg = (d) => (Number.isFinite(d) ? ((d % 360) + 360) % 360 : null);

function defaultUuid() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* val terug */ }
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function wayLabel(way) {
  if (way == null) return null;
  if (typeof way === 'string') return way.trim() || null;
  if (typeof way === 'object') return [way.ref, way.name].filter(Boolean).join(' ') || null;
  return null;
}

function validRemote(it, t) {
  if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id) return false;
  if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon) || Math.abs(it.lat) > 90 || Math.abs(it.lon) > 180) return false;
  const exp = ms(it.vervaltOm);
  if (!Number.isFinite(exp) || exp <= t) return false; // externe items moeten een (toekomstige) vervaltijd hebben
  return true;
}

/**
 * createReports({ storage, now, uuid, countryAt, storageKey })
 *   storage   : { getItem(k), setItem(k, v) } (localStorage-achtig) of null -> alleen geheugen
 *   now       : () => ms epoch
 *   uuid      : () => string (default crypto.randomUUID)
 *   countryAt : (lat, lon) => 'NL'|'BE'|'LU'|null  (bv. core/region.js); zonder: land = null
 */
export function createReports({ storage = null, now = Date.now, uuid = defaultUuid, countryAt = null, storageKey = STORAGE_KEY } = {}) {
  let own = new Map(); // id -> item (bewaard)
  let remote = new Map(); // id -> item (alleen geheugen, snapshot van laatste refresh)
  let source = null;
  let persistent = !!storage;
  let lastError = null;
  const listeners = new Set();

  // --- opslag -------------------------------------------------------------------------------
  try {
    const raw = storage?.getItem(storageKey);
    if (raw) {
      const doc = JSON.parse(raw);
      for (const it of Array.isArray(doc?.items) ? doc.items : []) {
        if (it && typeof it.id === 'string' && Number.isFinite(it.lat) && Number.isFinite(it.lon) && KINDS.has(it.type)) own.set(it.id, it);
      }
    }
  } catch (e) { lastError = e; } // kapotte JSON of onbruikbare storage: leeg beginnen

  function save() {
    if (!persistent) return;
    try {
      storage.setItem(storageKey, JSON.stringify({ versie: 1, items: [...own.values()] }));
    } catch (e) {
      lastError = e;
      persistent = false; // bv. quota/privémodus: verder in geheugen
    }
  }

  function emit() {
    const items = list();
    for (const cb of listeners) { try { cb(items); } catch { /* luisteraar */ } }
  }

  // Verwijder verlopen items; -> true als er iets veranderde.
  function prune() {
    const t = now();
    let changedOwn = false, changed = false;
    for (const [id, it] of own) {
      const exp = ms(it.vervaltOm);
      if (exp != null && exp <= t) { own.delete(id); changedOwn = true; }
    }
    for (const [id, it] of remote) if (ms(it.vervaltOm) <= t) { remote.delete(id); changed = true; }
    if (changedOwn) save();
    return changedOwn || changed;
  }

  function findDuplicate(kind, lat, lon, heading) {
    let best = null;
    for (const it of own.values()) {
      if (it.type !== kind) continue;
      const d = dist(lat, lon, it.lat, it.lon);
      if (d > DEDUP_RADIUS_M) continue;
      if (heading != null && it.richting != null && angle(heading, it.richting) >= DEDUP_HEADING_DEG) continue;
      if (!best || d < best.d) best = { it, d };
    }
    return best?.it ?? null;
  }

  // --- publieke API ----------------------------------------------------------------------------
  /**
   * Nieuwe melding. -> { id, item, confirmed } ; confirmed=true als het een bevestiging van een bestaande melding
   * werd (binnen 150 m en < 40° koersverschil). Ongeldige positie -> null.
   */
  function add({ lat, lon, heading = null, speed = null, way = null, kind = 'mobiel' } = {}) {
    prune();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const type = KINDS.has(kind) ? kind : 'mobiel';
    const richting = normDeg(heading);
    const dup = findDuplicate(type, lat, lon, richting);
    if (dup) {
      const item = confirm(dup.id);
      return { id: dup.id, item, confirmed: true };
    }
    const t = now();
    let land = null;
    try { land = countryAt ? countryAt(lat, lon) ?? null : null; } catch { land = null; }
    const item = {
      id: `eigen:${uuid()}`,
      type,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      richting,
      weg: wayLabel(way),
      land,
      gemeldOm: iso(t),
      vervaltOm: type === 'mobiel' ? iso(t + MOBILE_TTL_MS) : null, // vast_eigen vervalt niet
      bron: 'eigen',
      betrouwbaarheid: OWN_RELIABILITY,
      precisie: 'punt',
      bevestigingen: 0,
      limiet: null,
      snelheidBijMelden: Number.isFinite(speed) ? speed : null, // m/s, informatief
    };
    own.set(item.id, item);
    save();
    if (source) {
      Promise.resolve().then(() => source.sendReport({ ...item })).catch((e) => { lastError = e; });
    }
    emit();
    return { id: item.id, item: { ...item }, confirmed: false };
  }

  /** Verwijder een eigen melding (of verberg een externe tot de volgende refresh). -> boolean */
  function remove(id) {
    const had = own.delete(id) || remote.delete(id);
    if (had) { save(); emit(); }
    return had;
  }

  /** "Staat er nog": +1 bevestiging; mobiel +2 uur, max. 8 uur na eerste melding. -> item | null */
  function confirm(id) {
    prune();
    const it = own.get(id);
    if (!it) return null;
    it.bevestigingen = (it.bevestigingen || 0) + 1;
    if (it.type === 'mobiel') {
      const cap = ms(it.gemeldOm) + MOBILE_MAX_MS;
      it.vervaltOm = iso(Math.min(ms(it.vervaltOm) + CONFIRM_EXTEND_MS, cap));
    }
    save();
    emit();
    return { ...it };
  }

  /** Alle geldige items (eigen + extern), nieuwste eerst. Verlopen items worden opgeruimd. */
  function list() {
    if (prune()) queueMicrotask(emit);
    const all = new Map(remote);
    for (const [id, it] of own) all.set(id, it); // eigen wint bij gelijke id
    return [...all.values()].map((it) => ({ ...it })).sort((a, b) => (ms(b.gemeldOm) || 0) - (ms(a.gemeldOm) || 0));
  }

  /** -> Camera[] (type 'mobile', of 'fixed' voor vast_eigen). */
  function toCameras() {
    return list().map((it) => {
      const dir = normDeg(it.richting);
      return {
        id: it.id,
        type: it.type === 'vast_eigen' ? 'fixed' : 'mobile',
        lat: it.lat,
        lon: it.lon,
        maxspeed: Number.isFinite(it.limiet) ? it.limiet : null,
        direction: dir,
        directionSource: dir != null ? 'way' : null,
        wayIds: [],
        sectionId: null,
        bron: it.bron ?? null,
        betrouwbaarheid: Number.isFinite(it.betrouwbaarheid) ? it.betrouwbaarheid : null,
        vervaltOm: it.vervaltOm ?? null,
      };
    });
  }

  /** Externe bron koppelen: { fetchReports(bbox)->Promise<item[]>, sendReport(item)->Promise<void> } of null. */
  function setRemoteSource(src) {
    if (src == null) {
      source = null;
      if (remote.size) { remote = new Map(); emit(); }
      return;
    }
    if (typeof src.fetchReports !== 'function' || typeof src.sendReport !== 'function') {
      throw new TypeError('remote source moet fetchReports(bbox) en sendReport(item) hebben');
    }
    source = src;
  }

  /**
   * Haal externe meldingen op (snapshot vervangt de vorige) en voeg samen op id. Gooit nooit.
   * -> { ok, count, error? }
   */
  async function refresh(bbox = null) {
    if (!source) return { ok: false, count: 0, error: 'geen externe bron' };
    const src = source;
    let items;
    try {
      items = await src.fetchReports(bbox);
    } catch (e) {
      lastError = e;
      return { ok: false, count: 0, error: String(e?.message || e) };
    }
    if (src !== source) return { ok: false, count: 0, error: 'bron gewijzigd tijdens ophalen' };
    if (items && !Array.isArray(items) && Array.isArray(items.items)) items = items.items; // heel §6-document
    if (!Array.isArray(items)) { lastError = new Error('ongeldig antwoord van externe bron'); return { ok: false, count: 0, error: lastError.message }; }
    const t = now();
    const next = new Map();
    for (const it of items) if (validRemote(it, t) && !own.has(it.id)) next.set(it.id, { ...it, richting: normDeg(it.richting) });
    remote = next;
    emit();
    return { ok: true, count: next.size };
  }

  return {
    add, remove, confirm, list, toCameras,
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    setRemoteSource, refresh,
    get persistent() { return persistent; },
    get lastError() { return lastError; },
  };
}
