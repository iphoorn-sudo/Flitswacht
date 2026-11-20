// Flitswacht — bootstrap en koppeling van modules.
// Keten: geolocation -> gpsfilter -> provider.ensureAround (+ onChange -> matcher.setWays / alerts.setCameras / setSections)
//        -> matcher.match -> alerts.update -> section.update -> weergave + geluid/spraak.

import { createSettings, bindSettingsUI } from './ui/settings.js';
import { createSound, alertSpeech } from './ui/sound.js';
import { createHud } from './ui/hud.js';
import { createMap } from './ui/map.js';
import { createWakeLock, WAKE_HELP } from './ui/wake.js';
import { createSimGeolocation, createSimProvider } from './ui/sim.js';
import { bindReportButton, renderReportsList, memoryStorage, safeLocalStorage } from './ui/reports-ui.js';

export const APP_VERSION = '1.0.0';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIM_SPEED = Math.min(20, Math.max(1, Number(params.get('speed')) || 1));

// --- core/data-modules (dynamisch geladen zodat een fout netjes getoond kan worden) ------------
let M = null;
async function loadModules() {
  const [gps, matcher, alerts, section, store, provider, overpass] = await Promise.all([
    import('./core/gpsfilter.js'),
    import('./core/matcher.js'),
    import('./core/alerts.js'),
    import('./core/section.js'),
    import('./data/store.js'),
    import('./data/provider.js'),
    import('./data/overpass.js'),
  ]);
  return {
    createGpsFilter: gps.createGpsFilter,
    createMatcher: matcher.createMatcher,
    createAlertEngine: alerts.createAlertEngine,
    createSectionTracker: section.createSectionTracker,
    createStore: store.createStore,
    createProvider: provider.createProvider,
    effectiveMaxspeed: typeof overpass.effectiveMaxspeed === 'function' ? overpass.effectiveMaxspeed : null,
    countryAt: await loadRegion(),
    createReports: await loadReports(),
  };
}

/** js/core/region.js (A1.4). Ontbreekt de module, dan geen landgrens-blokkade (met waarschuwing in de console). */
async function loadRegion() {
  try {
    const region = await import('./core/region.js');
    if (typeof region.countryAt === 'function') return region.countryAt;
  } catch (e) { console.warn('region.js niet beschikbaar; landgrens-controle uit', e); }
  return null;
}

/** js/data/reports.js (A2.1). Ontbreekt de module, dan is de meldknop verborgen. */
async function loadReports() {
  try {
    const m = await import('./data/reports.js');
    if (typeof m.createReports === 'function') return m.createReports;
  } catch (e) { console.warn('reports.js niet beschikbaar; meldknop uit', e); }
  return null;
}

export const OUTSIDE_TEXT = 'Waarschuwingen uit: buiten NL/BE/LU (in o.a. Duitsland en Zwitserland verboden)';

// --- gedeelde objecten --------------------------------------------------------------------------
const settings = createSettings();
const sound = createSound(() => settings.get());
const hud = createHud();
let mapView = null;
let mapInitTried = false;
let realProvider = null;
let realReports = null;
let reportUI = null;

// U1: de wake-status wordt onthouden, ook als hij binnenkomt vóórdat de rit bestaat (iOS < 18.4 meldt
// 'unsupported' synchroon binnen wake.start()), en toegepast zodra de rit er is.
let wakeState = null;
function showWake(st) {
  if (!ride || !st) return;
  if (st === 'active') { hud.status('wake', 'Scherm', 'good'); hud.clearBanner('wake'); }
  else if (st === 'released') hud.status('wake', 'Scherm…', 'fair');
  else {
    hud.status('wake', 'Scherm!', 'bad');
    hud.banner('wake', {
      kind: 'warn',
      title: st === 'unsupported' ? 'Scherm-aan wordt niet ondersteund' : 'Scherm-aan geweigerd',
      text: WAKE_HELP, timeoutMs: 20000,
    });
  }
}
const wake = createWakeLock((st) => { wakeState = st; showWake(st); });

// Debug-/testhaak (alleen lezen); handig voor de headless test en voor eigen controle in de console.
const debug = { reports: () => ride?.reports || null, simDistance: () => ride?.simD ?? null, announced: [], lastAlerts: [], lastSection: null, lastState: null, lastMatch: null, errors: [] };
globalThis.__flitswacht = debug;

// --- rit-toestand -------------------------------------------------------------------------------
let ride = null;

function newEngines() {
  const s = settings.get();
  return {
    filter: M.createGpsFilter({ maxAccuracy: 35 }),
    matcher: M.createMatcher({}),
    alerts: M.createAlertEngine({ minDistM: 300, leadS: s.leadS, tolerance: s.tolerance }),
    section: M.createSectionTracker({ tolerance: s.tolerance }),
  };
}

/** Goedkope sleutel over de set way-id's (U2): alleen bij een andere set de wegenindex herbouwen. */
function waysKey(ways) {
  let h = ways.length | 0;
  for (const w of ways) {
    const id = w.id;
    if (typeof id === 'number') h = (Math.imul(h, 31) + (id | 0) + Math.floor(id / 4294967296)) | 0;
    else { const t = String(id); for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0; }
  }
  return `${ways.length}:${h}`;
}

/** Nieuwe providerdata: camera's/sections direct, wegenindex alleen bij gewijzigde set en buiten de gps-tick. */
function applyData(r, fresh = null) {
  const d = (fresh && typeof fresh === 'object' && Array.isArray(fresh.cameras) ? fresh : r.provider.getData()) || {};
  r.provCameras = d.cameras || [];
  r.data.sections = d.sections || [];
  const ways = d.ways || [];
  const key = waysKey(ways);
  if (key !== r.waysKey) {
    r.waysKey = key;
    scheduleSetWays(r, ways);
  }
  applyCameras(r);
}

/**
 * Wegenindex buiten de gps-tick opbouwen (U2). iOS Safari heeft geen requestIdleCallback, dus een korte timer.
 * Biedt de matcher een incrementele variant aan (`setWaysAsync(ways, { yieldFn, budgetMs })`, voorstel aan W-CORE),
 * dan wordt die gebruikt zodat de hoofdthread nooit > ~50 ms aaneengesloten blokkeert; de oude index blijft dan
 * bruikbaar tot de nieuwe klaar is. Zonder die API: één setWays-aanroep in een setTimeout (kan bij veel wegen
 * nog 0,2–0,9 s blokkeren; gemeten in debug.setWaysMs).
 */
const yieldToMain = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((res) => setTimeout(res, 0)));

function scheduleSetWays(r, ways) {
  if (r.waysJob) r.waysJob.cancel();
  let cancelled = false;
  const run = async () => {
    if (cancelled || ride !== r) return;
    const t0 = performance.now();
    try {
      const m = r.eng.matcher;
      if (typeof m.setWaysAsync === 'function') {
        await m.setWaysAsync(ways, { yieldFn: yieldToMain, budgetMs: 12, isCancelled: () => cancelled || ride !== r });
      } else {
        m.setWays(ways);
      }
    } catch (e) { reportError('matcher.setWays', e); }
    if (cancelled || ride !== r) return;
    r.waysJob = null;
    r.data.ways = ways;
    debug.setWaysCount = (debug.setWaysCount || 0) + 1;
    debug.setWaysMs = Math.round(performance.now() - t0);
  };
  const h = setTimeout(run, 50);
  r.waysJob = { cancel: () => { cancelled = true; clearTimeout(h); } };
}

/** Provider-camera's + eigen meldingen samenvoegen (A2.2) en aan de alert-engine geven; geen wegenindex (U2). */
function applyCameras(r) {
  let own = [];
  try { own = r.reports ? r.reports.toCameras() || [] : []; } catch (e) { reportError('reports.toCameras', e); }
  r.ownIds = new Set(own.map((c) => c.id));
  // eigen id's zijn 'eigen:…', dus geen botsing met OSM-id's
  r.data.cameras = [...r.provCameras, ...own];
  try {
    r.eng.alerts.setCameras(r.data.cameras);
    r.eng.alerts.setSections(r.data.sections);
  } catch (e) { reportError('Data verwerken', e); }
  r.lastCamRefresh = Date.now();
  mapView?.setData(r.data);
  updateDataStatus();
}

function makeReports(storage) {
  if (!M?.createReports) return null;
  try {
    return M.createReports({ storage, now: () => Date.now(), countryAt: M.countryAt || null });
  } catch (e) { reportError('createReports', e); return null; }
}

function reportError(where, e) {
  console.error(where, e);
  debug.errors.push(`${where}: ${e?.message || e}`);
}

function startRide({ sim = false, auto = false } = {}) {
  if (ride) stopRide();
  if (!M) { showStartMsg('De app is nog niet volledig geladen. Probeer het zo opnieuw.'); return; }

  // 1) Alles wat een gebruikerstik vereist: meteen, synchroon in de tik.
  // Automatische start (?sim=1) is geen tik: dan pas bij de eerste aanraking ontgrendelen (zie pointerdown-handler).
  const audio = auto ? { audio: true } : sound.unlock({ greeting: sim ? 'Simulatie gestart' : 'Flitswacht actief' });
  wakeState = null;
  const wakePromise = wake.start();

  const geo = sim
    ? createSimGeolocation({ speedFactor: SIM_SPEED, onEnd: onSimEnd, onProgress: (p) => { if (ride) ride.simD = p.d; } })
    : navigator.geolocation;

  if (!geo) {
    showStartMsg('Deze browser heeft geen locatievoorziening. Gebruik Safari op iPhone.');
    wake.stop();
    return;
  }
  if (!sim && !globalThis.isSecureContext) {
    showStartMsg('Locatie werkt alleen via HTTPS. Open de app via een https://-adres.');
    wake.stop();
    return;
  }

  if (!sim && !realProvider) { showStartMsg('Dataopslag is niet beschikbaar; alleen simulatie werkt.'); wake.stop(); return; }
  const provider = sim ? createSimProvider({ cameraWays: params.get('simCamWays') !== '0' }) : realProvider;
  const reports = sim ? makeReports(memoryStorage()) : realReports;
  const r = {
    sim, geo, provider, reports, ownIds: new Set(), provCameras: [],
    eng: newEngines(),
    data: { ways: [], cameras: [], sections: [] },
    watchId: null,
    lastFixAt: Date.now(),
    lastEnsure: null,
    overSince: 0, overEpisode: false, lastOverSpeech: 0, underSince: 0,
    prevSection: null, lastSecSpeech: 0,
    outsideCount: 0, outside: false, hiddenAt: 0,
    silentBranch: new Map(),
    unsub: null,
  };
  ride = r;
  debug.announced.length = 0;

  // De echte provider heeft één vaste abonnee (zie boot); de sim-provider krijgt er per rit één.
  if (sim) {
    const u = provider.onChange((data) => { if (ride === r) applyData(r, data); });
    r.unsub = typeof u === 'function' ? u : null;
  }
  if (reports) {
    const u2 = reports.onChange(() => { if (ride === r) { applyCameras(r); renderReportsList(reports); } });
    r.unsubReports = typeof u2 === 'function' ? u2 : null;
  }
  reportUI?.setAvailable(!!reports);
  reportUI?.setOwnAlert(null);
  applyData(r);

  showScreen('drive');
  // Kaart pas bij de eerste rit aanmaken: geen tegelverzoeken op het startscherm.
  if (!mapView && !mapInitTried) {
    mapInitTried = true;
    try { mapView = createMap($('mapwrap'), $('map')); } catch (e) { reportError('Kaart', e); }
    if (mapView) { mapView.setData(r.data); mapView.setHeadingUp(settings.get().headingUp); }
  }
  hud.reset();
  hud.simBadge(sim);
  hud.status('wake', 'Scherm…', 'fair');
  showWake(wakeState);   // U1: status die al vóór de rit binnenkwam
  mapView?.invalidate();
  mapView?.setHeadingUp(settings.get().headingUp);

  if (!audio.audio) hud.banner('audio', { kind: 'warn', title: 'Geluid niet beschikbaar', text: 'Deze browser staat geen geluid toe. Waarschuwingen zijn alleen zichtbaar.', timeoutMs: 12000 });
  wakePromise.catch(() => {});
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* niet ondersteund */ }

  try {
    r.watchId = geo.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  } catch (e) {
    reportError('watchPosition', e);
    onGeoError({ code: 2, message: String(e) });
  }
  r.watchdog = setInterval(() => watchdog(r), 1000);
}

function stopRide() {
  const r = ride;
  if (!r) return;
  ride = null;
  try { if (r.watchId != null) r.geo.clearWatch(r.watchId); } catch { /* */ }
  clearInterval(r.watchdog);
  clearTimeout(r.simRestart);
  try { r.unsub?.(); } catch { /* */ }
  try { r.unsubReports?.(); } catch { /* */ }
  wake.stop();
  sound.stop();
  hud.reset();
  showScreen('start');
}

function onSimEnd() {
  const r = ride;
  if (!r || !r.sim) return;
  hud.banner('sim', { kind: 'info', title: 'Simulatie afgelopen', text: 'Over 4 seconden begint de testroute opnieuw.', timeoutMs: 4000 });
  r.simRestart = setTimeout(() => {
    if (ride !== r) return;
    // nieuwe rit met verse engines, zonder opnieuw te tikken (audio is al ontgrendeld)
    try { r.geo.clearWatch(r.watchId); } catch { /* */ }
    const geo = createSimGeolocation({ speedFactor: SIM_SPEED, onEnd: onSimEnd, onProgress: (p) => { if (ride) ride.simD = p.d; } });
    r.geo = geo;
    r.eng = newEngines();
    r.prevSection = null;
    r.waysKey = null;
    r.silentBranch.clear();
    applyData(r);
    r.watchId = geo.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, maximumAge: 0 });
  }, 4000);
}

// --- GPS ----------------------------------------------------------------------------------------
function toFix(pos) {
  const c = pos.coords || {};
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracy: Number.isFinite(c.accuracy) ? c.accuracy : 999,
    speed: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null,
    heading: Number.isFinite(c.heading) && c.heading >= 0 ? c.heading : null,
    t: Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now(),
  };
}

function onGeoError(err) {
  const r = ride;
  if (!r) return;
  if (err?.code === 1) {
    hud.status('gps', 'Geweigerd', 'bad');
    hud.banner('gps', {
      title: 'Locatietoegang geweigerd',
      text: 'Zonder locatie kan Flitswacht niet waarschuwen. iPhone: Instellingen › Privacy en beveiliging › ' +
        'Locatievoorzieningen › Safari-websites › "Bij gebruik van app" én "Nauwkeurige locatie" aan. ' +
        'Tik in Safari eventueel op "aA" › Website-instellingen › Locatie › Sta toe. Laad daarna de pagina opnieuw.',
    });
  } else if (err?.code === 3) {
    hud.status('gps', 'Zoeken…', 'fair');
  } else {
    hud.status('gps', 'Geen GPS', 'bad');
    hud.banner('gps', { kind: 'warn', title: 'Locatie niet beschikbaar', text: 'Controleer of Locatievoorzieningen aan staan en of je vrij zicht op de lucht hebt.', timeoutMs: 15000 });
  }
}

function watchdog(r) {
  if (ride !== r) return;
  // U3: verlopen eigen meldingen elke minuut uit de alert-engine halen
  if (r.reports && Date.now() - (r.lastCamRefresh || 0) > 60000) applyCameras(r);
  // U13: geen geldige positie sinds > 3 s -> waarden grijs/"–"
  if (r.gotFix) hud.stale(Date.now() - (r.lastValidAt || 0) > 3000);
  const age = Date.now() - r.lastFixAt;
  if (age > 10000 && r.gotFix) hud.status('gps', `Geen fix ${Math.round(age / 1000)} s`, 'bad');
  else if (age > 15000 && !r.gotFix && !r.noFixWarned) {
    r.noFixWarned = true;
    hud.banner('gps-wait', { kind: 'info', title: 'Nog geen GPS-positie', text: 'Even geduld; buiten of bij de voorruit gaat het sneller.', timeoutMs: 15000 });
  }
  updateDataStatus();
}

function onPosition(pos) {
  const r = ride;
  if (!r) return;
  r.lastFixAt = Date.now();
  if (!r.gotFix) { r.gotFix = true; hud.clearBanner('gps-wait'); hud.clearBanner('gps'); }
  try {
    processFix(r, toFix(pos));
  } catch (e) {
    reportError('Verwerken positie', e);
  }
}

function processFix(r, fix) {
  const state = r.eng.filter.update(fix);
  debug.lastState = state;

  const acc = Math.round(fix.accuracy);
  const q = !state?.valid ? 'bad' : acc <= 12 ? 'good' : 'fair';
  hud.status('gps', state?.valid ? `±${acc}m` : `Zwak ±${acc}m`, q);

  if (!state || !Number.isFinite(state.lat)) return;
  if (!state.valid) {
    // Slechte fix: laatste staat behouden, geen nieuwe waarschuwingslogica op ruis (U13: watchdog maakt het grijs).
    return;
  }
  r.lastValidAt = Date.now();
  hud.stale(false);

  // Data voor dit gebied (en vooruit) laten laden; niet wachten.
  maybeEnsure(r, state);

  let match = null;
  try { match = r.eng.matcher.match(state); } catch (e) { reportError('matcher', e); }
  debug.lastMatch = match;

  // A1.4: buiten NL/BE/LU geen flitserwaarschuwingen (snelheid en limiet blijven werken).
  const enabled = regionAllows(r, state);
  let alerts = [];
  try { alerts = r.eng.alerts.update(state, match, { enabled }) || []; } catch (e) { reportError('alerts', e); }
  if (!enabled) alerts = [];
  debug.lastAlerts = alerts;

  let sec = null;
  try { sec = r.eng.section.update(state, alerts, r.data.sections, match) || null; } catch (e) { reportError('section', e); }
  debug.lastSection = sec;

  render(r, state, match, alerts, sec);
}

function regionAllows(r, state) {
  if (!M.countryAt) return true;
  let c = null;
  try { c = M.countryAt(state.lat, state.lon); } catch (e) { reportError('countryAt', e); return true; }
  // kleine hysterese (2 fixes) tegen flapperen precies op de grens
  r.outsideCount = c ? 0 : r.outsideCount + 1;
  const outside = r.outside ? !c : r.outsideCount >= 2;
  if (outside !== r.outside) {
    r.outside = outside;
    if (outside) {
      hud.banner('region', { kind: 'warn', title: 'Buiten NL/BE/LU', text: OUTSIDE_TEXT });
      sound.say('Waarschuwingen uit, buiten Nederland, België en Luxemburg');
    } else {
      hud.clearBanner('region');
      sound.say('Waarschuwingen weer aan');
    }
  }
  debug.country = c;
  return !outside;
}

function maybeEnsure(r, state) {
  const now = Date.now();
  const L = r.lastEnsure;
  const movedFar = !L || Math.abs(L.lat - state.lat) > 0.004 || Math.abs(L.lon - state.lon) > 0.006;
  if (!movedFar && now - L.at < 30000) return;
  r.lastEnsure = { lat: state.lat, lon: state.lon, at: now };
  Promise.resolve()
    .then(() => r.provider.ensureAround(state.lat, state.lon, state.heading, state.speed))
    .catch((e) => {
      reportError('ensureAround', e);
      if (ride === r) hud.status('data', 'Laden mislukt', 'bad');
    })
    .finally(updateDataStatus);
}

// --- weergave + meldingen -----------------------------------------------------------------------
function wayLimit(match) {
  const way = match?.way;
  if (!way || (Number.isFinite(match.confidence) && match.confidence < 0.3)) return null;
  // provider.getData(): way.maxspeed is al de nu geldende limiet (tijdsvoorwaarden in NL/BE-tijdzone, A3.3)
  const dir = match.dir < 0 ? way.maxspeedBackward : way.maxspeedForward;
  if (!way.oneway && Number.isFinite(dir)) return dir;
  return Number.isFinite(way.maxspeed) ? way.maxspeed : null;
}

/** R1: bij een Y-splitsing (branch 'unknown') de ref/naam van de tak van de camera, als die bekend is. */
function withBranchName(r, a) {
  if (a.branch !== 'unknown') return a;
  const ids = a.camera?.wayIds || [];
  const way = ids.length ? r.data.ways.find((w) => ids.includes(w.id)) : null;
  const name = way ? (way.ref || way.name || '') : '';
  return { ...a, branchName: name };
}

function roadName(way) {
  if (!way) return '';
  return [way.ref, way.name].filter(Boolean).join(' · ');
}

function render(r, state, match, alerts, sec) {
  const s = settings.get();
  const kmh = (state.speed || 0) * 3.6;
  const limit = sec ? (sec.limit ?? sec.section?.maxspeed ?? null) : wayLimit(match);
  const over = Number.isFinite(limit) && kmh > limit + s.tolerance;

  hud.speed(kmh, over);
  hud.limit(limit, over);

  const first = alerts[0] || null;
  reportUI?.setOwnAlert(first && r.ownIds.has(first.camera?.id) ? first.camera.id : null);
  if (first) hud.alert(withBranchName(r, first), null, alerts.length - 1);
  else {
    const name = roadName(match?.way);
    hud.alert(null, {
      title: name || (match?.way ? 'Onbekende weg' : 'Vrije weg'),
      sub: r.outside ? 'Waarschuwingen uit (buiten NL/BE/LU)'
        : r.data.cameras.length ? 'Geen controles in jouw rijrichting' : 'Nog geen flitserdata in dit gebied',
    });
  }
  hud.section(sec);
  mapView?.update(state, match?.way || null);

  announce(r, state, alerts, sec, over, limit);
}

function announce(r, state, alerts, sec, over, limit) {
  const now = Date.now();
  const s = settings.get();

  // Alerts: alerts.update levert elke tick de actieve lijst; geluid/spraak ALLEEN bij isNew === true.
  // Bij meerdere nieuwe tegelijk: alleen de dichtstbijzijnde uitspreken.
  // R1: een 'info' voorbij een nog open splitsing (branch gezet) krijgt alleen een zachte toon + de balk, GEEN spraak.
  // Spraak volgt pas bij escalatie (warn/now = isNew) of zodra de splitsing beslist is en de camera op jouw tak
  // blijkt te liggen (alerts.js: branch wordt dan null terwijl de alert actief blijft). Verdwijnt hij: stil.
  const ids = new Set(alerts.map((x) => x.camera?.id ?? x.id));
  for (const id of r.silentBranch.keys()) if (!ids.has(id)) r.silentBranch.delete(id);
  const a = alerts.find((x) => x.isNew === true);
  let spokeAlert = false;
  const decided = !a && alerts.find((x) => x.branch == null && r.silentBranch.has(x.camera?.id ?? x.id));
  if (decided) {
    r.silentBranch.delete(decided.camera?.id ?? decided.id);
    sound.tone(decided.uncertain ? 'maybe' : 'info');
    sound.say(alertSpeech(decided));
    spokeAlert = true;
    debug.announced.push({ id: decided.camera?.id ?? decided.id, level: decided.level, distM: Math.round(decided.distM), text: alertSpeech(decided), decided: true });
  }
  if (a && a.level === 'info' && a.branch != null) {
    r.silentBranch.set(a.camera?.id ?? a.id, true);
    sound.tone('maybe');
    debug.announced.push({ id: a.camera?.id ?? a.id, level: a.level, distM: Math.round(a.distM), text: '', branch: a.branch, silent: true });
  } else if (a) {
    r.silentBranch.delete(a.camera?.id ?? a.id);
    if (a.uncertain) {
      // A3: onzekere camera -> rustige toon, "mogelijk", nooit het 'now'-alarm
      sound.tone('maybe');
      if (a.level === 'info') sound.say(alertSpeech(a));
    } else {
      sound.tone(a.level === 'info' ? 'info' : a.level === 'warn' ? 'warn' : 'now');
      sound.say(alertSpeech(withBranchName(r, a)), { interrupt: a.level !== 'info' });
    }
    spokeAlert = true;
    debug.announced.push({ id: a.camera?.id ?? a.id, level: a.level, distM: Math.round(a.distM), text: alertSpeech(a) });
  }

  // Trajectcontrole: begin, te hoog gemiddelde, weer in orde, einde.
  const prev = r.prevSection;
  if (sec && !prev) {
    sound.tone('section');
    const lim = sec.limit ?? sec.section?.maxspeed;
    sound.say(`Trajectcontrole gestart${lim ? `, maximaal ${lim}` : ''}`);
  } else if (sec && prev && sec.status !== prev.status && now - r.lastSecSpeech > 8000) {
    r.lastSecSpeech = now;
    if (sec.status === 'over') {
      sound.tone('over');
      const allow = Number.isFinite(sec.allowedRemainingKmh) ? Math.max(0, Math.round(sec.allowedRemainingKmh)) : null;
      sound.say(allow != null ? `Gemiddelde te hoog. Rij maximaal ${allow}` : 'Gemiddelde te hoog');
    } else {
      sound.tone('ok');
      sound.say('Gemiddelde weer in orde');
    }
  } else if (!sec && prev) {
    const avg = Number.isFinite(prev.avgKmh) ? Math.round(prev.avgKmh) : null;
    sound.say(`Einde traject${avg != null ? `, gemiddeld ${avg}` : ''}`);
  }
  r.prevSection = sec ? { status: sec.status, avgKmh: sec.avgKmh } : null;

  // Overschrijding van de limiet: één signaal per episode (met hysterese).
  const kmh = (state.speed || 0) * 3.6;
  if (over) {
    r.underSince = 0;
    if (!r.overSince) r.overSince = now;
    if (!r.overEpisode && now - r.overSince >= 1500) {
      r.overEpisode = true;
      sound.tone('over');
      if (!spokeAlert && !alerts.length && !sec && now - r.lastOverSpeech > 45000) {
        r.lastOverSpeech = now;
        sound.say(`Te hard, maximaal ${limit}`);
      }
    }
  } else {
    r.overSince = 0;
    if (r.overEpisode && (!Number.isFinite(limit) || kmh < limit + s.tolerance - 2)) {
      if (!r.underSince) r.underSince = now;
      if (now - r.underSince > 4000) { r.overEpisode = false; r.underSince = 0; }
    }
  }
}

function updateDataStatus() {
  const r = ride;
  if (!r) return;
  let st = null;
  try { st = r.provider.status?.(); } catch { st = null; }
  const n = r.data.cameras.length;
  let text = 'Data', q = '';
  if (typeof st === 'string') text = st;
  else if (st && typeof st === 'object') {
    // A1.3: { online, loading, lastError, enforcementAgeMs, tilesLoaded, budgetLeft, stale }
    // (oudere vorm met st.state wordt ook begrepen)
    const loading = st.loading === true || (typeof st.loading === 'number' && st.loading > 0) || st.state === 'loading';
    const offline = st.online === false || st.state === 'offline';
    const budgetOut = st.budgetExhausted === true || (Number.isFinite(st.budgetLeft) && st.budgetLeft <= 0);
    const stale = st.stale === true || st.state === 'stale';
    if (st.mode === 'sim') { text = 'Sim'; q = 'good'; }
    else if (loading) { text = 'Laden…'; q = 'fair'; }
    else if (!n && (st.lastError || st.state === 'error' || offline)) { text = 'Geen data'; q = 'bad'; }
    else if (offline) { text = 'Offline'; q = 'fair'; }
    else if (budgetOut) { text = 'Budget op'; q = 'fair'; }
    else if (stale) { text = 'Verouderd'; q = 'fair'; }
    else if (st.lastError) { text = 'Cache'; q = 'fair'; }
    else if (n) { text = 'Vers'; q = 'good'; }
    if (Number.isFinite(st.enforcementAgeMs) && st.mode !== 'sim' && n) {
      const days = Math.floor(st.enforcementAgeMs / 86400000);
      if (days >= 1) text += ` ${days}d`;
    }
  }
  // A3.1: zonder 'camera-ways' is de wegkoppeling van camera's beperkt -> meer "mogelijk"-meldingen
  if (st && typeof st === 'object' && st.cameraWaysLoaded === false && q === 'good') { text = 'Beperkt'; q = 'fair'; }
  if (!(st && st.mode === 'sim') && n) text += ` · ${n}`;
  hud.status('data', text, q);
}

// --- schermen, sheets ---------------------------------------------------------------------------
function showScreen(name) {
  $('screen-start').hidden = name !== 'start';
  $('screen-drive').hidden = name !== 'drive';
  if (name === 'drive') setTimeout(() => mapView?.invalidate(), 50);
  if (name === 'start' && pendingUpdate) $('update-banner').hidden = false;
}
function showStartMsg(txt) {
  const el = $('start-msg');
  el.textContent = txt; el.hidden = !txt;
}
function openSheet(id) { $(id).hidden = false; }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; }); }

function applySettings(s, changed = null) {
  document.body.classList.toggle('night', !!s.night);
  $('mapwrap').classList.toggle('hidden-map', !s.showMap);
  if (!changed || changed.includes('headingUp')) mapView?.setHeadingUp(s.headingUp);
  if (!changed || changed.includes('silentOverride')) sound.applyAudioSession();
  if (ride && changed && (changed.includes('tolerance') || changed.includes('leadS'))) {
    // U5: niet midden in de rit de engines vervangen (dat herhaalt alle waarschuwingen en wist een lopend traject).
    hud.banner('settings', { kind: 'info', title: 'Instelling bewaard', text: 'De voorwaarschuwing en tolerantie voor waarschuwingen gelden vanaf de volgende rit. Het limietbord gebruikt de nieuwe tolerantie meteen.', timeoutMs: 6000 });
  }
}

// --- service worker -----------------------------------------------------------------------------
let pendingUpdate = null;
function registerSW() {
  if (!('serviceWorker' in navigator) || params.has('nosw')) return;
  if (!globalThis.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => {
      pendingUpdate = worker;
      if (!ride) $('update-banner').hidden = false;
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // Af en toe controleren op een nieuwe versie (alleen buiten een rit relevant)
    setInterval(() => { if (!ride) reg.update().catch(() => {}); }, 60 * 60 * 1000);
  }).catch((e) => console.warn('Service worker niet geregistreerd', e));

  // U9: de service worker meldt gewijzigde shell-inhoud (nieuwe versie staat al in de cache; herladen is genoeg).
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'SHELL_UPDATED') return;
    pendingUpdate = pendingUpdate || 'content';
    debug.shellUpdated = true;
    if (!ride) $('update-banner').hidden = false;
  });
  try { navigator.serviceWorker.startMessages?.(); } catch { /* */ }

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !userAskedUpdate) return;
    reloading = true;
    location.reload();
  });
}
let userAskedUpdate = false;

// --- opstarten ----------------------------------------------------------------------------------
function wireUI() {
  $('btn-start').addEventListener('click', () => startRide({ sim: false }));
  $('btn-sim').addEventListener('click', () => startRide({ sim: true }));
  $('btn-sim-settings').addEventListener('click', () => { closeSheets(); startRide({ sim: true }); });
  $('btn-stop').addEventListener('click', () => stopRide());
  $('btn-about-start').addEventListener('click', () => openSheet('sheet-about'));
  $('btn-test-sound').addEventListener('click', () => {
    sound.unlock();
    sound.tone('warn');
    sound.say('Flitser over 400 meter, 80');
  });
  document.querySelectorAll('.sheet').forEach((sh) => {
    sh.addEventListener('click', (e) => { if (e.target === sh || e.target.closest('[data-close]')) sh.hidden = true; });
  });
  $('update-banner').addEventListener('click', () => {
    userAskedUpdate = true;
    if (pendingUpdate && typeof pendingUpdate.postMessage === 'function') pendingUpdate.postMessage({ type: 'SKIP_WAITING' });
    else { location.reload(); return; }
    setTimeout(() => location.reload(), 1500);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (ride) ride.hiddenAt = Date.now();
      return;
    }
    sound.resume();
    if (ride && ride.hiddenAt) {
      const secs = Math.round((Date.now() - ride.hiddenAt) / 1000);
      ride.hiddenAt = 0;
      hud.banner('background', {
        kind: 'warn',
        title: 'Flitswacht stond op de achtergrond: geen waarschuwingen in die tijd',
        text: `(${secs} s) Houd het scherm aan en Flitswacht vooraan open tijdens de rit; iOS pauzeert de app anders. ` +
          'Scherm-aan-houden vraagt iOS 18.4+, anders: Automatisch slot op "Nooit".',
        timeoutMs: 25000,
      });
    }
  });
  if (!sound.audioSessionSupported) {
    const cb = $('set-silentOverride');
    if (cb) cb.disabled = true;
    const note = $('note-silentOverride');
    if (note) note.textContent = 'Niet ondersteund in deze browser (vereist iOS 17 of nieuwer).';
  }
  // Bij ?sim=1 start de rit automatisch; de eerste tik ergens ontgrendelt dan alsnog het geluid.
  document.addEventListener('pointerdown', () => { if (!sound.unlocked) sound.unlock(); }, { once: true, capture: true });

  reportUI = bindReportButton({
    getReports: () => ride?.reports || null,
    getState: () => (ride && debug.lastState?.valid ? debug.lastState : null),
    getWay: () => debug.lastMatch?.way || null,
    sound, hud,
  });
  const openSettings = () => { renderReportsList(ride?.reports || realReports); openSheet('sheet-settings'); };
  $('btn-settings-start').addEventListener('click', openSettings);
  $('btn-settings-drive').addEventListener('click', openSettings);
  $('about-version').textContent = `Versie ${APP_VERSION}`;
  bindSettingsUI(settings);
  settings.onChange((s, changed) => applySettings(s, changed));
  applySettings(settings.get());
}

async function boot() {
  wireUI();
  applySettings(settings.get());

  const startBtn = $('btn-start');
  startBtn.disabled = true;
  try {
    M = await loadModules();
  } catch (e) {
    reportError('Modules laden', e);
    showStartMsg('Kon de app-onderdelen niet laden. Controleer de verbinding en laad de pagina opnieuw.');
    return;
  } finally {
    startBtn.disabled = false;
  }

  try {
    const store = M.createStore({ indexedDB: globalThis.indexedDB });
    realProvider = M.createProvider({
      store, fetch: globalThis.fetch.bind(globalThis), now: () => Date.now(),
      isOnline: () => navigator.onLine !== false,
    });
    realReports = makeReports(safeLocalStorage());
    realProvider.onChange((data) => { if (ride && ride.provider === realProvider) applyData(ride, data); });
  } catch (e) {
    reportError('Provider', e);
    showStartMsg('Dataopslag kon niet worden gestart; alleen simulatie is beschikbaar.');
  }

  registerSW();
  if (params.get('sim') === '1') startRide({ sim: true, auto: true });
}

boot();
