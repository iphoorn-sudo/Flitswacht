// Rijscherm-weergave: snelheid, limietbord, waarschuwingsbalk, trajectpaneel, statusregel, meldingen.

import { iconForType, ICON_ROAD } from './icons.js';
import { alertLabel } from './sound.js';

const $ = (id) => document.getElementById(id);

function fmtDist(m) {
  if (!Number.isFinite(m)) return '';
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace('.', ',')}<small>km</small>`;
  const r = m >= 200 ? Math.round(m / 10) * 10 : Math.round(m / 5) * 5;
  return `${Math.max(0, r)}<small>m</small>`;
}

function setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }
function setHTML(el, html) { if (el && el.__html !== html) { el.innerHTML = html; el.__html = html; } }

export function createHud() {
  const el = {
    speedBox: $('speed-box'), speed: $('speed'),
    limit: $('limit'), limitNum: $('limit-num'),
    alertbar: $('alertbar'), alertIcon: $('alert-icon'), alertType: $('alert-type'), alertSub: $('alert-sub'), alertDist: $('alert-dist'),
    sec: $('section-panel'), secTitle: $('sec-title'), secLeft: $('sec-left'), secAvg: $('sec-avg'),
    secAllowed: $('sec-allowed'), secLimit: $('sec-limit'), secBar: $('sec-bar'),
    stGps: $('st-gps'), stData: $('st-data'), stWake: $('st-wake'), stSim: $('st-sim'),
    banners: $('banners'),
  };
  // Maximale afstand waarop een alert binnenkwam: basis voor de aftelbalk.
  const startDist = new Map();

  function speed(kmh, over) {
    setText(el.speed, Number.isFinite(kmh) ? String(Math.round(kmh)) : '–');
    el.speed.classList.toggle('empty', !Number.isFinite(kmh));
    el.speedBox.classList.toggle('over', !!over);
  }

  function limit(lim, over) {
    const known = Number.isFinite(lim) && lim > 0;
    setText(el.limitNum, known ? String(Math.round(lim)) : '?');
    el.limit.classList.toggle('unknown', !known);
    el.limit.classList.toggle('over', known && !!over);
    el.limit.setAttribute('aria-label', known ? `Maximumsnelheid ${Math.round(lim)}` : 'Maximumsnelheid onbekend');
  }

  /** alert: Alert|null; idle: {title, sub} voor de rustige toestand; more: aantal extra alerts */
  function alert(a, idle = {}, more = 0) {
    const bar = el.alertbar;
    if (!a) {
      bar.className = 'alertbar level-idle';
      bar.style.setProperty('--p', 0);
      setHTML(el.alertIcon, ICON_ROAD('#8ea3b0'));
      setText(el.alertType, idle.title || 'Vrije weg');
      setText(el.alertSub, idle.sub || '');
      setHTML(el.alertDist, '');
      return;
    }
    const cam = a.camera || {};
    const key = a.id ?? cam.id;
    const prev = startDist.get(key);
    if (!prev || a.distM > prev) startDist.set(key, Math.max(a.distM, 1));
    if (startDist.size > 50) startDist.clear();
    const p = Math.min(1, Math.max(0, 1 - a.distM / (startDist.get(key) || a.distM || 1)));

    // uncertain (A3): rustig weergeven, nooit als 'now'-alarm
    const level = a.uncertain ? 'uncertain' : (a.level || 'info');
    bar.className = `alertbar level-${level}`;
    bar.style.setProperty('--p', p.toFixed(3));
    const color = level === 'uncertain' ? '#8ea3b0' : level === 'now' ? '#ffffff' : level === 'warn' ? '#ffb020' : cam.type === 'mobile' ? '#ba8cff' : '#4cc9f0';
    setHTML(el.alertIcon, iconForType(cam.type, color));
    const label = alertLabel(a);
    setText(el.alertType, a.uncertain ? `Mogelijk ${label.toLowerCase()}` : label);
    const bits = [];
    if (a.limit) bits.push(`limiet ${a.limit}`);
    if (Number.isFinite(a.etaS) && a.etaS < 600) bits.push(`${Math.max(0, Math.round(a.etaS))} s`);
    if (a.uncertain) bits.push('weg onzeker');
    if (a.overLimit) bits.push('te hard!');
    if (more > 0) bits.push(`+${more} verder`);
    setText(el.alertSub, bits.join(' · '));
    setHTML(el.alertDist, fmtDist(a.distM));
  }

  function section(s) {
    if (!s) { el.sec.hidden = true; return; }
    el.sec.hidden = false;
    const over = s.status === 'over';
    el.sec.classList.toggle('over', over);
    setText(el.secTitle, `Traject${s.section?.name ? ' · ' + s.section.name : 'controle'}`);
    const left = Number.isFinite(s.distLeftM) ? s.distLeftM : null;
    setText(el.secLeft, left != null ? `nog ${(left / 1000).toFixed(1).replace('.', ',')} km` : '');
    const num = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '–');
    setHTML(el.secAvg, `${num(s.avgKmh)}<small>km/h</small>`);
    let allowed = num(s.allowedRemainingKmh);
    if (Number.isFinite(s.allowedRemainingKmh) && s.allowedRemainingKmh > 250) allowed = '∞';
    setHTML(el.secAllowed, `${allowed}<small>km/h</small>`);
    setText(el.secLimit, num(s.limit ?? s.section?.maxspeed));
    const total = (s.distDoneM || 0) + (s.distLeftM || 0);
    el.secBar.style.width = total > 0 ? `${Math.min(100, (100 * (s.distDoneM || 0)) / total).toFixed(1)}%` : '0%';
  }

  /** chip: 'gps'|'data'|'wake'; quality: 'good'|'fair'|'bad'|''; */
  function status(chip, text, quality = '') {
    const node = { gps: el.stGps, data: el.stData, wake: el.stWake }[chip];
    if (!node) return;
    setText(node.querySelector('.chip-txt'), text);
    node.classList.remove('good', 'fair', 'bad');
    if (quality) node.classList.add(quality);
  }
  function simBadge(on) { el.stSim.hidden = !on; }
  /** U13: geen geldige positie sinds een paar seconden -> waarden grijs en snelheid "–". */
  function stale(on) {
    document.getElementById('screen-drive').classList.toggle('stale', !!on);
    if (on) { setText(el.speed, '–'); el.speed.classList.add('empty'); }
  }

  // --- meldingen (N4) -----------------------------------------------------------------------
  // Compacte strook van één regel direct onder de statuschips (buiten de kaart): icoon + korte titel (+ acties, ×).
  // Tik op de titel = uitklappen: overlay met de volledige uitleg van alle meldingen, sluitbaar, na 8 s vanzelf dicht.
  // Zo blijven de weg vóór de auto, het limietbord en de OSM-vermelding altijd vrij.
  const bannerMap = new Map();   // key -> {title, text, kind, actions, timer, t}
  const KIND_ICON = {
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#ff3d5a"/><path d="M12 6.5v7M12 16.8v.2" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 22.5 21h-21z" fill="#ffb020"/><path d="M12 9v5.5M12 17.6v.2" stroke="#1e1606" stroke-width="2.4" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#4cc9f0"/><path d="M12 11v6M12 7.2v.2" stroke="#06202a" stroke-width="2.6" stroke-linecap="round"/></svg>',
  };
  const overlay = document.getElementById('notice-overlay');
  const overlayList = document.getElementById('notice-list');
  let overlayTimer = null;

  function mkBtn(cls, label, onClick, aria) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = label;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function renderStrip() {
    const strip = el.banners;
    strip.textContent = '';
    const items = [...bannerMap.entries()];
    if (!items.length) { strip.hidden = true; closeOverlay(); return; }
    strip.hidden = false;
    const [key, b] = items[items.length - 1];      // nieuwste
    const row = document.createElement('div');
    row.className = `notice notice-${b.kind}`;
    row.setAttribute('role', b.kind === 'error' ? 'alert' : 'status');
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'notice-open';
    open.setAttribute('aria-label', `${b.title}. Tik voor uitleg`);
    open.innerHTML = KIND_ICON[b.kind] || KIND_ICON.info;
    const t = document.createElement('span'); t.className = 'notice-title'; t.textContent = b.title;
    open.append(t);
    if (items.length > 1) { const c = document.createElement('span'); c.className = 'notice-count'; c.textContent = `+${items.length - 1}`; open.append(c); }
    if (b.text) { const m = document.createElement('span'); m.className = 'notice-more'; m.textContent = 'meer'; open.append(m); }
    open.addEventListener('click', openOverlay);
    row.append(open);
    for (const a of b.actions) row.append(mkBtn('notice-act', a.label, () => { clearBanner(key); a.onClick?.(); }));
    row.append(mkBtn('notice-x', '×', () => clearBanner(key), 'Melding sluiten'));
    strip.append(row);
    if (overlay && !overlay.hidden) fillOverlay();
  }

  function fillOverlay() {
    overlayList.textContent = '';
    for (const [key, b] of [...bannerMap.entries()].reverse()) {
      const card = document.createElement('div');
      card.className = `notice-card notice-${b.kind}`;
      const h = document.createElement('div'); h.className = 'notice-card-head';
      h.innerHTML = KIND_ICON[b.kind] || KIND_ICON.info;
      const tt = document.createElement('b'); tt.textContent = b.title; h.append(tt);
      const p = document.createElement('p'); p.textContent = b.text || '';
      const acts = document.createElement('div'); acts.className = 'notice-card-acts';
      for (const a of b.actions) acts.append(mkBtn('btn btn-ghost', a.label, () => { clearBanner(key); a.onClick?.(); }));
      acts.append(mkBtn('btn btn-ghost', 'Melding wissen', () => clearBanner(key)));
      card.append(h, p, acts);
      overlayList.append(card);
    }
  }
  function openOverlay() {
    if (!overlay) return;
    fillOverlay();
    overlay.hidden = false;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(closeOverlay, 8000);   // na 8 s vanzelf inklappen
  }
  function closeOverlay() { if (overlay) overlay.hidden = true; clearTimeout(overlayTimer); }
  overlay?.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]')) closeOverlay(); });

  /** Toont of vervangt een melding met sleutel. kind: 'error'|'warn'|'info'. timeoutMs optioneel. */
  function banner(key, { title, text, kind = 'error', timeoutMs = 0, actions = [] }) {
    const prev = bannerMap.get(key);
    if (prev) clearTimeout(prev.timer);
    bannerMap.delete(key);   // opnieuw toevoegen = nieuwste
    const timer = timeoutMs ? setTimeout(() => clearBanner(key), timeoutMs) : null;
    bannerMap.set(key, { title: title || '', text: text || '', kind: KIND_ICON[kind] ? kind : 'info', actions, timer });
    renderStrip();
  }
  function clearBanner(key) {
    const b = bannerMap.get(key);
    if (!b) return;
    clearTimeout(b.timer); bannerMap.delete(key);
    renderStrip();
  }
  function clearAllBanners() { for (const b of bannerMap.values()) clearTimeout(b.timer); bannerMap.clear(); renderStrip(); }

  function reset() {
    speed(NaN, false); limit(null, false); alert(null, { title: 'Vrije weg', sub: 'Wachten op GPS…' }); section(null);
    status('gps', 'GPS…'); status('data', 'Data…'); status('wake', 'Scherm');
    startDist.clear(); clearAllBanners(); stale(false);
  }

  return { speed, limit, alert, section, status, simBadge, stale, banner, clearBanner, clearAllBanners, reset };
}
