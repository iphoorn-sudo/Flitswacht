// Flitswacht — Overpass-queries, parsing en ophalen (W-DATA). Contract + AMENDEMENT A1.
// Geen DOM; fetch wordt geïnjecteerd.
import { dist, brng, polylineLen, pointSegDist, normBbox } from './geoutil.js';

// A1.3: private.coffee en mail.ru eerst; overpass-api.de alleen als laatste redmiddel.
export const DEFAULT_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
/** NL + BE + LU (A1.3a) */
export const ENFORCEMENT_BBOX = Object.freeze({ s: 49.4, w: 2.5, n: 53.7, e: 7.3 });
/** Na 429/406/504 minstens zo lang wachten (per endpoint). */
export const THROTTLE_PAUSE_MS = 30000;

const WAY_RE = '^(motorway|trunk|primary|secondary|tertiary)(_link)?$';
// Parser accepteert ook kleinere wegen (bv. oude cache/fixtures); de query vraagt ze niet meer op.
const ROAD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'service', 'road']);
// A3.1: alle berijdbare wegen rond camera's (ook kleine wegen en *_link)
const CAMERA_WAY_RE = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$';
export const CAMERA_WAYS_AROUND_M = 60;
/** Tijdzone waarin tijdsvoorwaarden gelden (NL/BE/LU hebben dezelfde regels). */
export const LEGAL_TIME_ZONE = 'Europe/Amsterdam';

const bboxStr = (bbox) => {
  const b = normBbox(bbox);
  const f = (x) => Number(x.toFixed(6));
  return `${f(b.s)},${f(b.w)},${f(b.n)},${f(b.e)}`;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
/** (a) Handhaving voor heel NL+BE+LU: speed_camera-nodes + enforcement-relaties met ledengeometrie. */
export function buildEnforcementQuery({ timeoutS = 180, bbox = ENFORCEMENT_BBOX } = {}) {
  const bb = bboxStr(bbox);
  return [
    `[out:json][timeout:${timeoutS}];`,
    `node["highway"="speed_camera"](${bb});`,
    `out body qt;`,
    `rel["type"="enforcement"]["enforcement"~"^(maxspeed|average_speed|traffic_signals)$"](${bb})->.r;`,
    `.r out body geom qt;`,
    `node(r.r:"device");`, // D4: tags van device-nodes (bv. maxspeed) meeleveren
    `out body qt;`,
  ].join('\n');
}

/**
 * (c) A3.1 'camera-ways': alle wegen binnen 60 m van elke speed_camera-node en elk device/from/to van een
 * enforcement-relatie in NL+BE+LU, met node-id's én geometrie.
 */
export function buildCameraWaysQuery({ timeoutS = 180, bbox = ENFORCEMENT_BBOX, aroundM = CAMERA_WAYS_AROUND_M } = {}) {
  const bb = bboxStr(bbox);
  return [
    `[out:json][timeout:${timeoutS}];`,
    `node["highway"="speed_camera"](${bb})->.c;`,
    `rel["type"="enforcement"]["enforcement"~"^(maxspeed|average_speed|traffic_signals)$"](${bb})->.r;`,
    `(node(r.r:"device"); node(r.r:"from"); node(r.r:"to");)->.d;`,
    `(.c; .d;)->.p;`,
    `way(around.p:${aroundM})["highway"~"${CAMERA_WAY_RE}"];`,
    `out body geom qt;`,
  ].join('\n');
}

/** (b) Wegen per tegel: motorway t/m tertiary (+_link), alleen tags + geometrie. */
export function buildWaysQuery(bbox, { timeoutS = 60 } = {}) {
  const bb = bboxStr(bbox);
  return [
    `[out:json][timeout:${timeoutS}];`,
    `way["highway"~"${WAY_RE}"](${bb});`,
    `out tags geom qt;`,
  ].join('\n');
}

/** @deprecated alias uit het oorspronkelijke contract: = buildWaysQuery */
export const buildQuery = buildWaysQuery;

// ---------------------------------------------------------------------------
// Maxspeed
// ---------------------------------------------------------------------------
export const IMPLICIT_MAXSPEED = {
  'NL:urban': 50, 'NL:rural': 80, 'NL:trunk': 100, 'NL:motorway': 130,
  'NL:zone30': 30, 'NL:zone60': 60, 'NL:living_street': 15, 'NL:woonerf': 15, 'NL:walk': 15,
  'NL:bicycle_road': 30, 'NL:cyclestreet': 30,
  'BE:urban': 50, 'BE:rural': 90, 'BE:trunk': 120, 'BE:motorway': 120,
  'BE:zone30': 30, 'BE:zone50': 50, 'BE:school': 30, 'BE:living_street': 20, 'BE:woonerf': 20,
  'BE:walk': 20, 'BE:cyclestreet': 30, 'BE:bicycle_road': 30,
  'BE-VLG:urban': 50, 'BE-VLG:rural': 70, 'BE-VLG:trunk': 120, 'BE-VLG:motorway': 120,
  'BE-WAL:urban': 50, 'BE-WAL:rural': 90, 'BE-WAL:trunk': 120, 'BE-WAL:motorway': 120,
  'BE-BRU:urban': 30, 'BE-BRU:rural': 70, 'BE-BRU:trunk': 120, 'BE-BRU:motorway': 120,
  'LU:urban': 50, 'LU:rural': 90, 'LU:motorway': 130, 'LU:zone30': 30, 'LU:living_street': 20,
};
// NL-snelweg zonder getal (alleen via maxspeed:type e.d.): 100 overdag 06-19, anders 130.
const NL_MOTORWAY_DAY = [{ value: 100, days: null, times: [[6 * 60, 19 * 60]] }];
const IMPLICIT_CONDITIONAL = { 'NL:motorway': NL_MOTORWAY_DAY };
const SUFFIX_FALLBACK = { urban: 50, zone30: 30, living_street: 15, walk: 15 };

/**
 * Parse een maxspeed-waarde -> { value(km/h|null), conditional(rules|null), kind, country }.
 * kind: 'number'|'implicit'|'none'|'walk'|'variable'|'unknown'|'missing'
 */
export function parseMaxspeed(raw) {
  if (raw == null) return { value: null, conditional: null, kind: 'missing', country: null };
  const s = String(raw).trim();
  if (!s) return { value: null, conditional: null, kind: 'missing', country: null };
  if (s.includes(';')) {
    const vals = s.split(';').map(parseMaxspeed).filter((p) => p.value != null);
    if (!vals.length) return { value: null, conditional: null, kind: 'unknown', country: null };
    return vals.reduce((a, b) => (b.value < a.value ? b : a));
  }
  const lower = s.toLowerCase();
  if (lower === 'none' || lower === 'unlimited') return { value: null, conditional: null, kind: 'none', country: null };
  if (lower === 'walk') return { value: 15, conditional: null, kind: 'walk', country: null };
  if (lower === 'signals' || lower === 'variable') return { value: null, conditional: null, kind: 'variable', country: null };
  const m = /^(\d+(?:[.,]\d+)?)\s*(mph|km\/h|kmh|kph|knots)?$/i.exec(s);
  if (m) {
    let v = parseFloat(m[1].replace(',', '.'));
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'mph') v *= 1.609344;
    else if (unit === 'knots') v *= 1.852;
    return { value: Math.round(v), conditional: null, kind: 'number', country: null };
  }
  const code = /^([A-Z]{2}(?:-[A-Z]{2,3})?):([a-z0-9_]+)$/i.exec(s);
  if (code) {
    const country = code[1].slice(0, 2).toUpperCase();
    const suffix = code[2].toLowerCase();
    const key = `${code[1].toUpperCase()}:${suffix}`;
    let v = IMPLICIT_MAXSPEED[key] ?? IMPLICIT_MAXSPEED[`${country}:${suffix}`] ?? SUFFIX_FALLBACK[suffix];
    const z = /^zone(\d+)$/.exec(suffix);
    if (v == null && z) v = +z[1];
    if (v == null) return { value: null, conditional: null, kind: 'unknown', country };
    return { value: v, conditional: IMPLICIT_CONDITIONAL[key] || null, kind: 'implicit', country };
  }
  return { value: null, conditional: null, kind: 'unknown', country: null };
}

const DAY_IDX = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 0 };
const ORDER = [1, 2, 3, 4, 5, 6, 0];

function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(',')) {
    const r = /^([a-z]{2})(?:-([a-z]{2}))?$/.exec(part.trim().toLowerCase());
    if (!r || !(r[1] in DAY_IDX) || (r[2] && !(r[2] in DAY_IDX))) return null;
    if (!r[2]) { days.add(DAY_IDX[r[1]]); continue; }
    let i = ORDER.indexOf(DAY_IDX[r[1]]);
    const end = ORDER.indexOf(DAY_IDX[r[2]]);
    for (let k = 0; k < 7; k++) { days.add(ORDER[i]); if (i === end) break; i = (i + 1) % 7; }
  }
  return [...days];
}

const DAYS_RE = '[A-Za-z]{2}(?:-[A-Za-z]{2})?(?:\\s*,\\s*[A-Za-z]{2}(?:-[A-Za-z]{2})?)*';
const TIMES_RE = '\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}(?:\\s*,\\s*\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2})*';
const COND_RE = new RegExp(`^(?:(${DAYS_RE})\\s+)?(${TIMES_RE})$`);
const DAYS_ONLY_RE = new RegExp(`^${DAYS_RE}$`);

// Alleen zuivere tijd-/dagvensters; alles met vrije tekst, "wet", gewicht, AND, maanden … -> null (negeren).
function parseTimeCondition(cond) {
  let c = cond.trim();
  if (c.startsWith('(') && c.endsWith(')')) c = c.slice(1, -1).trim();
  c = c.replace(/\s*[;,]?\s*PH\s+off\s*$/i, '').trim();
  const m = COND_RE.exec(c);
  if (!m) {
    if (DAYS_ONLY_RE.test(c)) { const d = parseDays(c.replace(/\s/g, '')); return d ? { days: d, times: [[0, 1440]] } : null; }
    return null;
  }
  const days = m[1] ? parseDays(m[1].replace(/\s/g, '')) : null;
  if (m[1] && !days) return null;
  const times = m[2].split(',').map((r) => r.split('-').map((t) => { const [h, mi] = t.trim().split(':').map(Number); return h * 60 + mi; }));
  if (times.some(([a, b]) => !(a >= 0 && a <= 1440 && b >= 0 && b <= 1440))) return null;
  return { days, times };
}

/** Parse maxspeed:conditional; niet-tijdscondities worden genegeerd. -> rules[] | null */
export function parseConditional(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const parts = [];
  let depth = 0, quote = false, cur = '';
  for (const ch of String(raw)) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0 && !quote) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const rules = [];
  for (const p of parts) {
    const at = p.indexOf('@');
    if (at < 0) continue;
    const v = parseMaxspeed(p.slice(0, at).trim());
    if (v.value == null && v.kind !== 'none') continue;
    const tc = parseTimeCondition(p.slice(at + 1));
    if (!tc) continue;
    rules.push({ value: v.value, days: tc.days, times: tc.times });
  }
  return rules.length ? rules : null;
}

// D1: uur/minuut/weekdag in Europe/Amsterdam, los van de tijdzone van het toestel.
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();
/** -> { mins (0..1439), day (0=zo) } in `timeZone`. Fallback zonder Intl-tijdzones: EU-zomertijdregel CET/CEST. */
export function legalClock(date, timeZone = LEGAL_TIME_ZONE) {
  try {
    let f = fmtCache.get(timeZone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
      fmtCache.set(timeZone, f);
    }
    const parts = {};
    for (const p of f.formatToParts(date)) parts[p.type] = p.value;
    const h = Number(parts.hour) % 24, m = Number(parts.minute), d = WD[parts.weekday];
    if (Number.isFinite(h) && Number.isFinite(m) && d != null) return { mins: h * 60 + m, day: d };
  } catch { /* val terug */ }
  return euCentralClock(date);
}
/** Handmatige CET/CEST-berekening (laatste zondag maart/oktober, 01:00 UTC). */
export function euCentralClock(date) {
  const t = date.getTime();
  const y = date.getUTCFullYear();
  const lastSun = (month) => { const d = new Date(Date.UTC(y, month + 1, 0)); return Date.UTC(y, month, d.getUTCDate() - d.getUTCDay(), 1); };
  const offH = t >= lastSun(2) && t < lastSun(9) ? 2 : 1;
  const l = new Date(t + offH * 3600000);
  return { mins: l.getUTCHours() * 60 + l.getUTCMinutes(), day: l.getUTCDay() };
}

function ruleMatches(rule, date, timeZone) {
  const { mins, day } = legalClock(date, timeZone);
  const prevDay = (day + 6) % 7;
  for (const [a, b] of rule.times) {
    if (a <= b) {
      if (mins >= a && mins < b && (!rule.days || rule.days.includes(day))) return true;
    } else {
      if (mins >= a && (!rule.days || rule.days.includes(day))) return true;
      if (mins < b && (!rule.days || rule.days.includes(prevDay))) return true;
    }
  }
  return false;
}

/**
 * Geldende limiet op `date`, beoordeeld in Europe/Amsterdam-tijd (D1; NL/BE/LU gelijk). Werkt voor Way, Camera en Section.
 * direction: 'forward' (langs geometry, default) | 'backward'. Gebruikt `maxspeedBase` als die bestaat
 * (de provider levert objecten waarvan `maxspeed` zelf een tijdsafhankelijke getter is).
 */
export function effectiveMaxspeed(obj, date = new Date(), direction = 'forward', timeZone = LEGAL_TIME_ZONE) {
  if (!obj) return null;
  const back = direction === 'backward';
  const general = 'maxspeedBase' in obj ? obj.maxspeedBase : obj.maxspeed;
  const base = (back ? obj.maxspeedBackward : obj.maxspeedForward) ?? general ?? null;
  const rules = (back ? obj.maxspeedConditionalBackward : obj.maxspeedConditionalForward) ?? obj.maxspeedConditional ?? null;
  let v = base;
  if (rules) for (const r of rules) if (ruleMatches(r, date, timeZone)) v = r.value; // laatste geldende regel wint
  return v ?? null;
}

// ---------------------------------------------------------------------------
// Richting
// ---------------------------------------------------------------------------
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** -> graden | 'forward' | 'backward' | null. Accepteert ook NL-windrichtingen (NO, ZW, …). */
export function parseDirection(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s || s.includes(';') || s === 'BOTH' || s === 'ALL') return null;
  if (s === 'FORWARD') return 'forward';
  if (s === 'BACKWARD') return 'backward';
  if (/^-?\d+(\.\d+)?$/.test(s)) { const n = parseFloat(s); return ((n % 360) + 360) % 360; }
  const i = COMPASS.indexOf(s.replace(/O/g, 'E').replace(/Z/g, 'S'));
  return i >= 0 ? i * 22.5 : null;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
const truthy = (v) => v === 'yes' || v === 'true' || v === '1';

function geomOf(el) {
  if (!el || !Array.isArray(el.geometry)) return null;
  const g = [];
  for (const p of el.geometry) if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) g.push([p.lat, p.lon]);
  return g.length >= 2 ? g : null;
}

function contextCountry(t) {
  for (const k of ['zone:traffic', 'maxspeed:type', 'source:maxspeed', 'zone:maxspeed']) {
    const m = /^([A-Z]{2})(?:-[A-Z]{2,3})?:/i.exec(t[k] || '');
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/** Way-element -> Way (of null). Exporteerd voor tests. */
export function parseWay(el) {
  const t = el.tags || {};
  const hw = t.highway;
  if (!hw || !ROAD_TYPES.has(hw.replace(/_link$/, ''))) return null;
  const geom = geomOf(el);
  if (!geom) return null;

  let oneway = false, reversed = false;
  const ow = t.oneway;
  if (truthy(ow)) oneway = true;
  else if (ow === '-1' || ow === 'reverse') { oneway = true; reversed = true; }
  else if (ow === 'no' || ow === 'false' || ow === '0' || ow === 'reversible' || ow === 'alternating') oneway = false;
  else if (hw === 'motorway' || hw === 'motorway_link' || t.junction === 'roundabout' || t.junction === 'circular') oneway = true;

  let main = parseMaxspeed(t.maxspeed);
  if (main.kind === 'missing' || main.kind === 'unknown') {
    for (const k of ['maxspeed:type', 'source:maxspeed', 'zone:maxspeed', 'zone:traffic']) {
      const p = parseMaxspeed(t[k]);
      if (p.kind === 'implicit') { main = p; break; }
    }
  }
  const country = contextCountry(t);
  if (main.kind === 'walk' && (country === 'BE' || country === 'LU')) main = { ...main, value: 20 };
  let fv = parseMaxspeed(t['maxspeed:forward']).value;
  let bv = parseMaxspeed(t['maxspeed:backward']).value;
  let cond = parseConditional(t['maxspeed:conditional']) || main.conditional;
  let condF = parseConditional(t['maxspeed:forward:conditional']);
  let condB = parseConditional(t['maxspeed:backward:conditional']);

  let geometry = geom;
  let nodes = Array.isArray(el.nodes) && el.nodes.length === geom.length ? el.nodes.slice() : null;
  if (reversed) {
    geometry = geom.slice().reverse();
    if (nodes) nodes.reverse();
    [fv, bv] = [bv, fv];
    [condF, condB] = [condB, condF];
  }
  let maxspeed = main.value;
  if (maxspeed == null) {
    if (oneway) maxspeed = fv;
    else if (fv != null && bv != null) maxspeed = Math.min(fv, bv);
  }
  if (!cond && oneway && condF) cond = condF;

  return {
    id: el.id,
    name: t.name ?? null,
    ref: t.ref ?? null,
    highway: hw,
    maxspeed: maxspeed ?? null,
    oneway,
    geometry,
    reversed, // true = geometry is t.o.v. OSM omgedraaid (oneway=-1); OSM 'forward' = tegen geometry in
    maxspeedForward: fv ?? null,
    maxspeedBackward: bv ?? null,
    maxspeedConditional: cond || null,
    maxspeedConditionalForward: condF || null,
    maxspeedConditionalBackward: condB || null,
    ...(nodes ? { nodes } : {}), // alleen bij `out body geom` (camera-ways): node-id's, gelijk aan geometry
  };
}

function camera(id, type, lat, lon, extra = {}) {
  return {
    id, type, lat, lon,
    maxspeed: null, maxspeedConditional: null,
    direction: null, directionSource: null, directionWay: null,
    wayIds: [], sectionId: null, relationId: null, nodeId: null, tags: null,
    ...extra,
  };
}

/**
 * Parse Overpass-JSON. Werkt voor de handhavings-respons, de wegen-respons en gecombineerde/oude data.
 * -> { ways, cameras, sections, warnings }. Gooit nooit. Camera.wayIds blijft hier leeg (koppeling in provider,
 * zie link.js); `directionWay` ('forward'|'backward') wordt daar tegen de way omgezet.
 */
export function parse(json) {
  const out = { ways: [], cameras: [], sections: [], warnings: [] };
  const els = json && Array.isArray(json.elements) ? json.elements : [];
  if (!json || !Array.isArray(json.elements)) out.warnings.push('geen elements-array in respons');

  const nodes = new Map();
  const rels = [];
  for (const el of els) {
    if (!el || typeof el !== 'object') continue;
    if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) nodes.set(el.id, el);
    else if (el.type === 'way') {
      const w = parseWay(el);
      if (w) out.ways.push(w);
      else if (el.tags?.highway) out.warnings.push(`way ${el.id}: overgeslagen (geen geometrie/ongeldig)`);
    } else if (el.type === 'relation') rels.push(el);
  }

  const cameras = new Map();
  // losse highway=speed_camera
  for (const n of nodes.values()) {
    const t = n.tags || {};
    if (t.highway !== 'speed_camera') continue;
    const sc = (t.speed_camera || t.enforcement || '').toLowerCase();
    const ms = parseMaxspeed(t.maxspeed);
    const cam = camera(`n${n.id}`, sc === 'traffic_signals' || sc === 'red_light' ? 'redlight' : 'fixed', n.lat, n.lon, {
      maxspeed: ms.value, maxspeedConditional: parseConditional(t['maxspeed:conditional']), nodeId: n.id, tags: { ...t },
    });
    const d = parseDirection(t.direction ?? t['camera:direction']);
    if (typeof d === 'number') { cam.direction = d; cam.directionSource = 'tag'; }
    else if (d) cam.directionWay = d;
    cameras.set(cam.id, cam);
  }

  const deviceOf = new Set(); // node-ids die device van een geldige relatie zijn
  const sectionDevices = new Set();
  for (const rel of rels) {
    try {
      handleRelation(rel);
    } catch (e) {
      out.warnings.push(`relation ${rel?.id}: fout bij parsen (${e?.message || e})`);
    }
  }

  function handleRelation(rel) {
    const t = rel.tags || {};
    if (t.type !== 'enforcement') return;
    const kind = t.enforcement;
    const members = Array.isArray(rel.members) ? rel.members : [];
    const pt = (m) => {
      if (!m || m.type !== 'node') return null;
      const n = nodes.get(m.ref);
      const lat = Number.isFinite(m.lat) ? m.lat : n?.lat;
      const lon = Number.isFinite(m.lon) ? m.lon : n?.lon;
      return Number.isFinite(lat) && Number.isFinite(lon) ? { id: m.ref, lat, lon, tags: n?.tags || {} } : null;
    };
    const devices = [];
    const seen = new Set();
    for (const m of members) if (m?.role === 'device') {
      const p = pt(m);
      if (p && !seen.has(p.id)) { seen.add(p.id); devices.push(p); }
    }
    const from = pt(members.find((m) => m?.role === 'from'));
    const to = pt(members.find((m) => m?.role === 'to'));
    const relMax = parseMaxspeed(t.maxspeed).value;
    const relCond = parseConditional(t['maxspeed:conditional']);

    if (kind === 'maxspeed' || kind === 'traffic_signals') {
      if (!devices.length) { out.warnings.push(`relation ${rel.id}: geen bruikbaar device`); return; }
      for (const d of devices) {
        deviceOf.add(d.id);
        const id = `n${d.id}`;
        let cam = cameras.get(id);
        if (!cam) { cam = camera(id, 'fixed', d.lat, d.lon, { nodeId: d.id, tags: Object.keys(d.tags).length ? { ...d.tags } : null }); cameras.set(id, cam); }
        if (cam.maxspeedConditional == null && d.tags['maxspeed:conditional']) cam.maxspeedConditional = parseConditional(d.tags['maxspeed:conditional']);
        cam.relationId = `r${rel.id}`;
        if (kind === 'traffic_signals') { cam.type = 'redlight'; }
        if (relMax != null) { cam.maxspeed = relMax; cam.maxspeedConditional = relCond; }
        else if (cam.maxspeed == null) cam.maxspeed = parseMaxspeed(d.tags.maxspeed).value;
        const dir = pairBearing(from, d, to);
        if (dir != null) { cam.direction = dir; cam.directionSource = 'relation'; cam.directionWay = null; }
      }
      return;
    }

    if (kind === 'average_speed') {
      const parts = members.filter((m) => m?.role === 'section' && m.type === 'way').map(geomOf).filter(Boolean);
      let start = from, end = to;
      let geometry = [];
      if (parts.length) {
        geometry = chainGeometry(parts, start || end, !start && end);
        if (geometry.length >= 2) {
          if (!start) start = { lat: geometry[0][0], lon: geometry[0][1], id: null, tags: {} };
          if (!end) { const L = geometry[geometry.length - 1]; end = { lat: L[0], lon: L[1], id: null, tags: {} }; }
          geometry = trimToEndpoints(geometry, start, end);
        }
      }
      if (!start || !end || dist(start.lat, start.lon, end.lat, end.lon) < 5) {
        out.warnings.push(`relation ${rel.id}: trajectcontrole zonder bruikbaar from/to`);
        return;
      }
      for (const d of devices) sectionDevices.add(d.id);
      if (from) sectionDevices.add(from.id);
      if (to) sectionDevices.add(to.id);
      let lengthM = geometry.length >= 2 ? polylineLen(geometry) : 0;
      if (!lengthM) lengthM = parseLength(t.length) ?? dist(start.lat, start.lon, end.lat, end.lon);
      const maxspeed = relMax ?? devices.map((d) => parseMaxspeed(d.tags.maxspeed).value).find((v) => v != null) ?? null;
      const devCond = relCond ?? devices.map((d) => parseConditional(d.tags['maxspeed:conditional'])).find(Boolean) ?? null;
      const sid = `r${rel.id}`;
      const name = t.name || [t.ref, t.description].filter(Boolean).join(' ') || 'Trajectcontrole';
      out.sections.push({
        id: sid, name, ref: t.ref ?? null, maxspeed, maxspeedConditional: devCond, lengthM: Math.round(lengthM),
        start: { lat: start.lat, lon: start.lon }, end: { lat: end.lat, lon: end.lon }, geometry,
      });
      let dirStart, dirEnd;
      if (geometry.length >= 2) {
        dirStart = brng(geometry[0][0], geometry[0][1], geometry[1][0], geometry[1][1]);
        const L = geometry.length;
        dirEnd = brng(geometry[L - 2][0], geometry[L - 2][1], geometry[L - 1][0], geometry[L - 1][1]);
      } else {
        dirStart = dirEnd = brng(start.lat, start.lon, end.lat, end.lon);
      }
      for (const [p, type, dir] of [[start, 'section_start', dirStart], [end, 'section_end', dirEnd]]) {
        const id = `${sid}:${type === 'section_start' ? 'start' : 'end'}`;
        cameras.set(id, camera(id, type, p.lat, p.lon, {
          maxspeed, maxspeedConditional: devCond, direction: dir, directionSource: 'relation', sectionId: sid, relationId: sid,
          nodeId: p.id ?? null,
        }));
      }
      return;
    }
    out.warnings.push(`relation ${rel.id}: enforcement=${kind ?? '?'} niet ondersteund`);
  }

  // A1.2: device-nodes (en from/to) van trajectrelaties niet als losse flitser melden.
  for (const id of sectionDevices) {
    const c = cameras.get(`n${id}`);
    if (c && !deviceOf.has(id)) cameras.delete(`n${id}`);
  }
  out.cameras = [...cameras.values()];
  return out;
}

function pairBearing(from, device, to) {
  for (const [a, b] of [[from, device], [device, to], [from, to]]) {
    if (a && b && dist(a.lat, a.lon, b.lat, b.lon) > 3) return brng(a.lat, a.lon, b.lat, b.lon);
  }
  return null;
}

function parseLength(raw) {
  if (raw == null) return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(km|m)?$/i.exec(String(raw).trim());
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return (m[2] || 'm').toLowerCase() === 'km' ? v * 1000 : v;
}

/**
 * Rijg losse way-geometrieën aan elkaar tot één lijn in rijvolgorde. Begint bij het deel dat het dichtst bij
 * `anchor` ligt; als `anchorIsEnd` dan is anchor het eindpunt en wordt het resultaat omgekeerd.
 */
function chainGeometry(parts, anchor, anchorIsEnd = false) {
  const rest = parts.map((p) => p.slice());
  const d = (p, q) => dist(p[0], p[1], q[0], q[1]);
  let bi = 0, brev = false;
  if (anchor) {
    // kies deel + oriëntatie waarvan een uiteinde (of een punt) het dichtst bij anchor ligt
    let bd = Infinity;
    rest.forEach((p, i) => {
      let best = Infinity;
      for (const q of p) best = Math.min(best, dist(anchor.lat, anchor.lon, q[0], q[1]));
      if (best < bd - 0.5) { bd = best; bi = i; }
    });
    const p = rest[bi];
    // oriënteer zodat de lijn van anchor wég loopt naar de andere delen (of, zonder andere delen, vanaf het verste uiteinde)
    const others = rest.filter((_, i) => i !== bi);
    if (others.length) {
      const near = (pt) => Math.min(...others.flatMap((o) => [d(pt, o[0]), d(pt, o[o.length - 1])]));
      brev = near(p[0]) < near(p[p.length - 1]);
    } else {
      brev = dist(anchor.lat, anchor.lon, p[0][0], p[0][1]) > dist(anchor.lat, anchor.lon, p[p.length - 1][0], p[p.length - 1][1]);
    }
  }
  let chain = rest.splice(bi, 1)[0];
  if (brev) chain.reverse();
  while (rest.length) {
    const tail = chain[chain.length - 1];
    let ni = -1, nrev = false, nd = Infinity;
    rest.forEach((p, i) => {
      const d0 = d(tail, p[0]), d1 = d(tail, p[p.length - 1]);
      if (d0 < nd) { nd = d0; ni = i; nrev = false; }
      if (d1 < nd) { nd = d1; ni = i; nrev = true; }
    });
    if (nd > 100) break; // gat: rest is niet aaneengesloten
    const p = rest.splice(ni, 1)[0];
    if (nrev) p.reverse();
    chain = chain.concat(d(tail, p[0]) < 0.5 ? p.slice(1) : p);
  }
  if (anchorIsEnd) chain.reverse();
  return chain;
}

// Projecteer start/eind op de lijn en knip de lijn daartussen af (section-ways lopen vaak voorbij from/to).
function trimToEndpoints(line, start, end, reversedOnce = false) {
  const locate = (p) => {
    let best = { d: Infinity, i: 0, t: 0 };
    for (let i = 1; i < line.length; i++) {
      const r = pointSegDist(p.lat, p.lon, line[i - 1], line[i]);
      if (r.distM < best.d) best = { d: r.distM, i: i - 1, t: r.t };
    }
    return best;
  };
  const a = locate(start), b = locate(end);
  if (a.d > 60 || b.d > 60) return line; // from/to liggen niet op de lijn: niet knippen
  if (a.i + a.t >= b.i + b.t) {
    // lijn loopt tegen de rijrichting in: omdraaien en opnieuw
    if (!reversedOnce) return trimToEndpoints(line.slice().reverse(), start, end, true);
    return line;
  }
  const lerp = (i, t) => [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
  const out = [lerp(a.i, a.t)];
  for (let i = a.i + 1; i <= b.i; i++) out.push(line[i]);
  out.push(lerp(b.i, b.t));
  const r6 = (x) => Math.round(x * 1e7) / 1e7;
  return out.map(([la, lo]) => [r6(la), r6(lo)]).filter((p, i, arr) => i === 0 || dist(p[0], p[1], arr[i - 1][0], arr[i - 1][1]) > 0.3);
}

// ---------------------------------------------------------------------------
// Ophalen
// ---------------------------------------------------------------------------
export class OverpassError extends Error {
  constructor(message, { code, status = null, endpoint = null, attempts = [], retryable = false, throttled = false } = {}) {
    super(message);
    this.name = 'OverpassError';
    // 'timeout'|'http'|'rate_limited'|'rejected'|'network'|'bad_response'|'server_error'|'bad_request'
    // |'all_failed'|'aborted'|'config'|'budget'|'throttled'
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
    this.attempts = attempts;
    this.retryable = retryable;
    this.throttled = throttled; // server vroeg om af te remmen (429/406/504)
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(url, query, { fetch, timeoutMs, signal }) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onOuter = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onOuter, { once: true }); }
  try {
    let res;
    try {
      // Bewust geen referrerPolicy/Referrer-Policy: Overpass wil de Referer (A1.3).
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query),
        signal: ac.signal,
      });
    } catch (e) {
      if (timedOut) throw new OverpassError(`Time-out na ${timeoutMs} ms`, { code: 'timeout', endpoint: url, retryable: true });
      if (signal?.aborted) throw new OverpassError('Afgebroken', { code: 'aborted', endpoint: url });
      throw new OverpassError(`Netwerkfout: ${e?.message || e}`, { code: 'network', endpoint: url, retryable: true });
    }
    if (!res.ok) {
      const st = res.status;
      const ra = Number(res.headers?.get?.('Retry-After'));
      const retryAfterS = Number.isFinite(ra) && ra > 0 ? ra : null;
      if (st === 429) throw Object.assign(new OverpassError('Overpass: te veel verzoeken (429)', { code: 'rate_limited', status: st, endpoint: url, retryable: true, throttled: true }), { retryAfterS });
      if (st === 406) throw Object.assign(new OverpassError('Overpass: verzoek geweigerd (406)', { code: 'rejected', status: st, endpoint: url, retryable: true, throttled: true }), { retryAfterS });
      if (st === 504) throw Object.assign(new OverpassError('Overpass: server overbelast (504)', { code: 'http', status: st, endpoint: url, retryable: true, throttled: true }), { retryAfterS });
      if (st === 400) throw new OverpassError('Overpass: ongeldige query (400)', { code: 'bad_request', status: st, endpoint: url });
      throw new OverpassError(`Overpass: HTTP ${st}`, { code: 'http', status: st, endpoint: url, retryable: st >= 500 || st === 408 });
    }
    let text;
    try { text = await res.text(); } catch (e) {
      if (timedOut) throw new OverpassError(`Time-out na ${timeoutMs} ms`, { code: 'timeout', endpoint: url, retryable: true });
      throw new OverpassError(`Netwerkfout bij lezen: ${e?.message || e}`, { code: 'network', endpoint: url, retryable: true });
    }
    let json;
    try { json = JSON.parse(text); } catch {
      throw new OverpassError('Overpass: geen geldige JSON', { code: 'bad_response', endpoint: url, retryable: true });
    }
    if (!json || !Array.isArray(json.elements)) throw new OverpassError('Overpass: respons zonder elements', { code: 'bad_response', endpoint: url, retryable: true });
    if (typeof json.remark === 'string' && /runtime error|timed out|out of memory|rate_limited/i.test(json.remark)) {
      throw new OverpassError(`Overpass: ${json.remark.trim()}`, { code: 'server_error', endpoint: url, retryable: true });
    }
    return json;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuter);
  }
}

/**
 * Voer een query uit over de endpoints. -> raw JSON. Gooit alleen OverpassError.
 * - `isOnline()` false -> geen enkele poging, code 'offline' (D2).
 * - `beforeRequest(url)` (async) vóór elke poging: false = geen budget -> code 'budget'. Telt zelf NIETS.
 * - `chargeRequest(url, {status, code})` (async) ná een poging die de server bereikte: elk HTTP-antwoord en
 *   een time-out. Een netwerkfout zonder HTTP-antwoord (offline, DNS, CORS) kost niets (D2).
 * - Netwerkfout op álle endpoints -> code 'offline'.
 * - Na 429/406/504 krijgt dat endpoint >= 30 s pauze; endpoints in pauze worden overgeslagen. 504 (zware query)
 *   gaat in `cooldowns` (bv. per verzoektype); 429/406 (de server remt de client af) in `sharedCooldowns`
 *   (default = cooldowns), zodat dat voor álle verzoeken geldt. Standaard geen extra rondes (retries=0).
 */
export async function fetchOverpass(query, opts = {}) {
  const {
    fetch = globalThis.fetch,
    endpoints = DEFAULT_ENDPOINTS,
    timeoutMs = 30000,
    retries = 0,
    backoffMs = 5000,
    maxBackoffMs = 120000,
    throttlePauseMs = THROTTLE_PAUSE_MS,
    sleep = defaultSleep,
    now = Date.now,
    cooldowns = new Map(),
    sharedCooldowns = cooldowns,
    beforeRequest = null,
    chargeRequest = null,
    isOnline = null,
    signal,
  } = opts;
  if (typeof fetch !== 'function') throw new OverpassError('Geen fetch beschikbaar', { code: 'config' });
  if (!endpoints || !endpoints.length) throw new OverpassError('Geen Overpass-endpoints opgegeven', { code: 'config' });

  const offlineNow = () => { try { return isOnline ? isOnline() === false : false; } catch { return false; } };
  if (offlineNow()) throw new OverpassError('Geen verbinding (toestel offline)', { code: 'offline', retryable: true });
  const charge = async (url, info) => { if (chargeRequest) { try { await chargeRequest(url, info); } catch { /* telling is best effort */ } } };
  const attempts = [];
  for (let round = 0; round <= retries; round++) {
    let throttled = false;
    for (const url of endpoints) {
      const until = Math.max(cooldowns.get(url) ?? -Infinity, sharedCooldowns.get(url) ?? -Infinity);
      if (until > now()) { attempts.push({ endpoint: url, code: 'cooldown', status: null, message: 'pauze na afremmen' }); continue; }
      if (beforeRequest && !(await beforeRequest(url))) {
        throw new OverpassError('Dagbudget voor Overpass-verzoeken is op', { code: 'budget', attempts });
      }
      if (offlineNow()) throw new OverpassError('Geen verbinding (toestel offline)', { code: 'offline', attempts, retryable: true });
      try {
        const json = await attempt(url, query, { fetch, timeoutMs, signal });
        await charge(url, { status: 200, code: 'ok' });
        json.__endpoint = url;
        return json;
      } catch (e) {
        const err = e instanceof OverpassError ? e : new OverpassError(String(e?.message || e), { code: 'network', endpoint: url, retryable: true });
        attempts.push({ endpoint: url, code: err.code, status: err.status, message: err.message });
        if (err.status != null || err.code === 'timeout' || err.code === 'bad_response' || err.code === 'server_error') {
          await charge(url, { status: err.status, code: err.code });
        }
        if (err.code === 'aborted' || err.code === 'bad_request') { err.attempts = attempts; throw err; }
        if (err.throttled) {
          throttled = true;
          const map = err.status === 429 || err.status === 406 ? sharedCooldowns : cooldowns;
          map.set(url, Math.max(map.get(url) ?? 0, now() + Math.max(throttlePauseMs, (err.retryAfterS || 0) * 1000)));
        }
      }
    }
    if (round < retries) {
      const wait = Math.min(maxBackoffMs, Math.max(backoffMs * 2 ** round, throttled ? throttlePauseMs : 0));
      await sleep(wait);
      if (signal?.aborted) throw new OverpassError('Afgebroken', { code: 'aborted', attempts });
    }
  }
  const real = attempts.filter((a) => a.code !== 'cooldown');
  if (real.length && real.every((a) => a.code === 'network')) {
    throw new OverpassError(`Geen verbinding met Overpass (${real.length} netwerkfout(en))`, { code: 'offline', attempts, retryable: true });
  }
  const last = real[real.length - 1];
  const anyThrottled = attempts.some((a) => a.status === 429 || a.status === 406 || a.status === 504 || a.code === 'cooldown');
  if (!real.length) {
    throw new OverpassError('Alle Overpass-servers in pauze na afremmen', { code: 'throttled', attempts, throttled: true, retryable: true });
  }
  throw new OverpassError(`Overpass onbereikbaar na ${real.length} poging(en) (laatste: ${last?.message})`,
    { code: 'all_failed', status: last?.status ?? null, attempts, retryable: true, throttled: anyThrottled });
}

function finish(json) {
  const data = parse(json);
  data.endpoint = json.__endpoint ?? null;
  return data;
}

/** Wegen van één tegel ophalen + parsen -> {ways, cameras:[], sections:[], warnings, endpoint}. */
export async function fetchArea(bbox, opts = {}) {
  let query;
  try { query = buildWaysQuery(bbox, { timeoutS: Math.max(10, Math.round((opts.timeoutMs ?? 30000) / 1000)) }); }
  catch (e) { throw new OverpassError(`Ongeldige bbox: ${e.message}`, { code: 'config' }); }
  return finish(await fetchOverpass(query, opts));
}

/** A3.1: wegen rond alle camera's in NL+BE+LU (met node-id's) -> {ways, cameras:[], sections:[], warnings, endpoint}. */
export async function fetchCameraWays(opts = {}) {
  const query = buildCameraWaysQuery({ timeoutS: Math.max(30, Math.round((opts.timeoutMs ?? 90000) / 1000)) });
  const data = finish(await fetchOverpass(query, { timeoutMs: 90000, ...opts }));
  return { ...data, cameras: [], sections: [] };
}

/** Handhaving voor NL+BE+LU ophalen + parsen -> {ways:[], cameras, sections, warnings, endpoint}. */
export async function fetchEnforcement(opts = {}) {
  const query = buildEnforcementQuery({ timeoutS: Math.max(30, Math.round((opts.timeoutMs ?? 90000) / 1000)) });
  return finish(await fetchOverpass(query, { timeoutMs: 90000, ...opts }));
}
