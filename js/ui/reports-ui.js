// Eigen meldingen (A2.2): meldknop op het rijscherm, "Staat er nog"/"Weg" bij een waarschuwing voor een eigen
// melding, en de lijst in Instellingen. De opslag zelf zit in js/data/reports.js (createReports, A2.1).

const $ = (id) => document.getElementById(id);
const LONG_PRESS_MS = 700;
const STANDSTILL_MS = 1.5; // m/s

/** Geheugen-opslag met getItem/setItem (voor simulatie, zodat testmeldingen niet in je echte lijst belanden). */
export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => m.delete(k) };
}

/** localStorage-achtige opslag die nooit gooit (privémodus, quota). */
export function safeLocalStorage() {
  return {
    getItem(k) { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } },
    setItem(k, v) { try { globalThis.localStorage?.setItem(k, v); } catch { /* negeren */ } },
    removeItem(k) { try { globalThis.localStorage?.removeItem(k); } catch { /* negeren */ } },
  };
}

/**
 * Koppelt de meldknop. ctx:
 *  getReports() -> reports-object of null, getState() -> laatste geldige State of null, getWay() -> Way|null,
 *  sound, hud
 */
export function bindReportButton(ctx) {
  const btn = $('btn-report');
  let timer = null, longFired = false, downAt = 0;

  function doReport(kind) {
    const reports = ctx.getReports();
    const st = ctx.getState();
    if (!reports) return;
    if (!st || !Number.isFinite(st.lat)) {
      ctx.hud.banner('report', { kind: 'warn', title: 'Nog geen positie', text: 'Melden kan zodra er een GPS-positie is.', timeoutMs: 4000 });
      return;
    }
    let item = null;
    try {
      item = reports.add({
        lat: st.lat, lon: st.lon,
        heading: Number.isFinite(st.heading) ? st.heading : null,
        speed: Number.isFinite(st.speed) ? st.speed : null,
        way: ctx.getWay() || undefined,
        kind,
      });
    } catch (e) {
      console.error('Melden mislukt', e);
      ctx.hud.banner('report', { title: 'Melden mislukt', text: String(e?.message || e), timeoutMs: 5000 });
      return;
    }
    Promise.resolve(item).then((it) => {
      // reports.add -> { id, item, confirmed } | null (null = ongeldige invoer)
      if (!it) { ctx.hud.banner('report', { kind: 'warn', title: 'Melden mislukt', text: 'Positie ongeldig.', timeoutMs: 4000 }); return; }
      const id = it.id;
      const confirmed = !!it.confirmed;
      ctx.sound.tone('ok');
      const spoken = kind === 'vast_eigen' ? 'Vaste plek opgeslagen' : confirmed ? 'Melding bevestigd' : 'Flitser gemeld';
      ctx.sound.say(spoken, { interrupt: true });
      ctx.onReported?.({ id, kind, confirmed });
      ctx.hud.banner('report', {
        kind: 'info',
        title: spoken,
        text: kind === 'vast_eigen' ? 'Bewaard tot je hem verwijdert.' : confirmed ? 'Bestaande melding verlengd.' : 'Vervalt over 3 uur.',
        timeoutMs: 5000,
        actions: id && !confirmed ? [{ label: 'Ongedaan maken', onClick: () => { try { ctx.getReports()?.remove(id); ctx.sound.say('Melding verwijderd'); } catch (e) { console.error(e); } } }] : [],
      });
    }).catch((e) => console.error('Melden mislukt', e));
  }

  btn.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    longFired = false; downAt = Date.now();
    btn.classList.add('pressing');
    clearTimeout(timer);
    timer = setTimeout(() => {
      longFired = true;
      btn.classList.remove('pressing');
      const st = ctx.getState();
      const still = st && (st.speed || 0) < STANDSTILL_MS;
      doReport(still ? 'vast_eigen' : 'mobiel');
    }, LONG_PRESS_MS);
  });
  const cancel = () => { clearTimeout(timer); btn.classList.remove('pressing'); };
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    cancel();
    if (longFired) { longFired = false; return; }
    // click zonder pointerdown (toetsenbord) of korte tik
    if (!downAt || Date.now() - downAt < LONG_PRESS_MS) doReport('mobiel');
    downAt = 0;
  });

  // "Staat er nog" / "Weg" voor de eigen melding waarvoor nu gewaarschuwd wordt.
  let currentId = null;
  $('btn-rep-confirm').addEventListener('click', () => {
    if (!currentId) return;
    try { ctx.getReports()?.confirm(currentId); ctx.sound.tone('ok'); ctx.sound.say('Bevestigd'); } catch (e) { console.error(e); }
  });
  $('btn-rep-remove').addEventListener('click', () => {
    if (!currentId) return;
    try { ctx.getReports()?.remove(currentId); ctx.sound.say('Verwijderd'); } catch (e) { console.error(e); }
    setOwnAlert(null);
  });

  function setOwnAlert(id) {
    currentId = id || null;
    $('report-actions').hidden = !currentId;
    btn.hidden = !!currentId;
  }

  return {
    setOwnAlert,
    setAvailable(on) { $('reportzone').hidden = !on; },
  };
}

function fmtTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const sameDay = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : `${d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} ${hm}`;
}

/** Vult de lijst in Instellingen. reports kan null zijn (module niet beschikbaar). */
export function renderReportsList(reports) {
  const ul = $('reports-list');
  const block = $('reports-block');
  if (!ul) return;
  block.hidden = !reports;
  ul.textContent = '';
  if (!reports) return;
  let items = [];
  try { items = reports.list() || []; } catch (e) { console.error(e); }
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nog geen eigen meldingen.';
    ul.append(li);
    return;
  }
  items.sort((a, b) => String(b.gemeldOm).localeCompare(String(a.gemeldOm)));
  for (const it of items) {
    const li = document.createElement('li');
    const txt = document.createElement('div');
    txt.className = 'rl-txt';
    const kind = it.type === 'vast_eigen' ? 'Vaste eigen plek' : 'Mobiele flitser';
    txt.append(document.createTextNode(`${kind}${it.weg ? ' · ' + it.weg : ''}`));
    const small = document.createElement('small');
    const bits = [`gemeld ${fmtTime(it.gemeldOm)}`];
    if (it.vervaltOm) bits.push(`vervalt ${fmtTime(it.vervaltOm)}`);
    if (it.bevestigingen) bits.push(`${it.bevestigingen}× bevestigd`);
    if (Number.isFinite(it.richting)) bits.push(`richting ${Math.round(it.richting)}°`);
    small.textContent = bits.join(' · ');
    txt.append(small);
    const del = document.createElement('button');
    del.type = 'button'; del.textContent = 'Verwijder';
    del.setAttribute('aria-label', `Verwijder ${kind}`);
    del.addEventListener('click', () => { try { reports.remove(it.id); } catch (e) { console.error(e); } renderReportsList(reports); });
    li.append(txt, del);
    ul.append(li);
  }
}
