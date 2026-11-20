// Mini-kaart met Leaflet (lokaal in vendor/leaflet, global L).

/** Instelbare tegelbron. Standaard-OSM-tegels; respecteer het tegelgebruiksbeleid van OSM. */
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_MAX_ZOOM = 19;
/** Attributie wordt als eigen (niet-roterend) element getoond in index.html. */
export const TILE_ATTRIBUTION = '© OpenStreetMap-bijdragers';

import { ICON_ME, iconForType } from './icons.js';

const CAM_RADIUS_DEG = 0.05;   // ~5 km rond positie markers tonen
const CAM_COLORS = { mobile: '#ba8cff', fixed: '#ffb020', redlight: '#ff6b81', section_start: '#5ef2d6', section_end: '#5ef2d6' };

export function createMap(wrapEl, mapEl) {
  const L = globalThis.L;
  if (!L) {
    console.warn('Leaflet niet geladen; kaart uitgeschakeld');
    return null;
  }

  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
    keyboard: false,
    inertia: false,
    fadeAnimation: true,
    zoomSnap: 0.5,
    tap: false,
  }).setView([52.1, 5.1], 8);

  L.tileLayer(TILE_URL, {
    maxZoom: TILE_MAX_ZOOM,
    // tegels niet agressief laden: alleen zichtbaar gebied + 1 rand
    keepBuffer: 1,
    crossOrigin: false,
    detectRetina: false,
  }).addTo(map);

  const meIcon = L.divIcon({ className: 'me-marker', html: ICON_ME, iconSize: [44, 44], iconAnchor: [22, 22] });
  const me = L.marker([0, 0], { icon: meIcon, interactive: false, keyboard: false, zIndexOffset: 1000 });
  let meAdded = false;

  const camLayer = L.layerGroup().addTo(map);
  const secLayer = L.layerGroup().addTo(map);
  const wayLayer = L.layerGroup().addTo(map);
  let wayLine = null;
  let wayLineId = null;

  let data = { cameras: [], sections: [] };
  let lastCamCenter = null;
  let headingUp = false;
  let userPannedAt = 0;
  let lastPos = null;
  let lastUpdateAt = 0;
  let mapRot = 0;   // ongewikkelde rotatie (geen 359->0 draai via de lange kant)
  let meRot = 0;
  const unwrap = (prev, target) => prev + ((((target - prev) % 360) + 540) % 360) - 180;

  map.on('dragstart', () => { userPannedAt = Date.now(); });

  function sizeForRotation() {
    const W = wrapEl.clientWidth, H = wrapEl.clientHeight;
    if (headingUp) {
      const D = Math.ceil(Math.hypot(W, H));
      Object.assign(mapEl.style, { width: `${D}px`, height: `${D}px`, left: `${(W - D) / 2}px`, top: `${(H - D) / 2}px` });
    } else {
      Object.assign(mapEl.style, { width: '100%', height: '100%', left: '0px', top: '0px', transform: '' });
    }
    map.invalidateSize({ pan: false });
  }

  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => sizeForRotation()) : null;
  ro?.observe(wrapEl);
  globalThis.addEventListener('orientationchange', () => setTimeout(sizeForRotation, 300));

  function setHeadingUp(on) {
    headingUp = !!on;
    wrapEl.classList.toggle('heading-up', headingUp);
    sizeForRotation();
    if (!headingUp) mapEl.style.transform = '';
  }

  function renderCameras(center) {
    camLayer.clearLayers();
    secLayer.clearLayers();
    if (!center) return;
    const [la, lo] = center;
    const near = (p) => Math.abs(p.lat - la) < CAM_RADIUS_DEG && Math.abs(p.lon - lo) < CAM_RADIUS_DEG * 1.6;
    let n = 0;
    for (const c of data.cameras || []) {
      if (!near(c) || n > 300) continue;
      n++;
      const icon = L.divIcon({ className: 'cam-marker', html: iconForType(c.type, CAM_COLORS[c.type] || '#ffb020'), iconSize: [30, 30], iconAnchor: [15, 15] });
      L.marker([c.lat, c.lon], { icon, interactive: false, keyboard: false }).addTo(camLayer);
    }
    for (const s of data.sections || []) {
      if (!(s.start && near(s.start)) && !(s.end && near(s.end))) continue;
      const g = s.geometry && s.geometry.length > 1 ? s.geometry : [[s.start.lat, s.start.lon], [s.end.lat, s.end.lon]];
      L.polyline(g, { color: '#5ef2d6', weight: 6, opacity: 0.55, dashArray: '2 10', lineCap: 'round', interactive: false }).addTo(secLayer);
    }
    lastCamCenter = center;
  }

  function setData(d) {
    data = d || { cameras: [], sections: [] };
    renderCameras(lastPos || lastCamCenter);
  }

  function zoomForSpeed(kmh) {
    if (kmh > 95) return 15;
    if (kmh > 55) return 15.5;
    if (kmh > 25) return 16.5;
    return 17;
  }

  /** Volg de positie. state: {lat,lon,speed,heading}. matchedWay: Way|null */
  function update(state, matchedWay) {
    if (!state || !Number.isFinite(state.lat)) return;
    const ll = [state.lat, state.lon];
    lastPos = ll;
    me.setLatLng(ll);
    if (!meAdded) { me.addTo(map); meAdded = true; }
    const heading = Number.isFinite(state.heading) ? state.heading : 0;
    const svg = me.getElement()?.querySelector('svg');
    meRot = unwrap(meRot, heading);
    if (svg) svg.style.transform = `rotate(${meRot}deg)`;

    // Gematchte weg licht oplichten
    if (matchedWay && matchedWay.id !== wayLineId && matchedWay.geometry?.length > 1) {
      wayLayer.clearLayers();
      wayLine = L.polyline(matchedWay.geometry, { color: '#4cc9f0', weight: 5, opacity: 0.45, interactive: false }).addTo(wayLayer);
      wayLineId = matchedWay.id;
    } else if (!matchedWay && wayLine) {
      wayLayer.clearLayers(); wayLine = null; wayLineId = null;
    }

    if (!lastCamCenter || Math.abs(lastCamCenter[0] - ll[0]) > 0.004 || Math.abs(lastCamCenter[1] - ll[1]) > 0.006) {
      renderCameras(ll);
    }

    if (Date.now() - userPannedAt < 15000) return; // gebruiker kijkt rond; na 15 s weer volgen
    const kmh = (state.speed || 0) * 3.6;
    const z = zoomForSpeed(kmh);
    // Positie iets onder het midden zodat je meer weg vóór je ziet
    // N4: auto onder het midden, zodat er meer weg vóór je zichtbaar is
    const ahead = Math.min(wrapEl.clientHeight * 0.28, Math.max(wrapEl.clientWidth, wrapEl.clientHeight) * 0.3);
    const rad = (heading * Math.PI) / 180;
    const p = map.project(ll, z).add(L.point(Math.sin(rad) * ahead, -Math.cos(rad) * ahead));
    const target = map.unproject(p, z);
    // Pan-duur afgestemd op het fix-interval: de animatie is klaar vóór de volgende fix, ook bij versnelde sim.
    const now = performance.now();
    const dt = lastUpdateAt ? (now - lastUpdateAt) / 1000 : 1;
    lastUpdateAt = now;
    const dur = Math.min(0.9, dt * 0.8);
    if (Math.abs(map.getZoom() - z) > 0.01 || dur < 0.2) map.setView(target, z, { animate: false });
    else map.panTo(target, { animate: true, duration: dur, easeLinearity: 1, noMoveStart: true });

    if (headingUp) {
      mapRot = unwrap(mapRot, -heading);
      mapEl.style.transform = `rotate(${mapRot}deg)`;
    }
  }

  return {
    map, update, setData, setHeadingUp,
    invalidate: () => sizeForRotation(),
  };
}
