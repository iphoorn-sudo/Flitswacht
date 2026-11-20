// Instellingen: opslag in localStorage (altijd met try/catch) + koppeling met het instellingenpaneel.

const KEY = 'flitswacht.settings.v1';

export const DEFAULTS = Object.freeze({
  sound: true,
  voice: true,
  tolerance: 3,     // km/h boven limiet voordat "te hard" geldt
  leadS: 15,        // voorwaarschuwtijd in seconden
  night: false,
  headingUp: false,
  showMap: true,
  silentOverride: false, // "Geluid ook bij stille modus" (navigator.audioSession.type = 'playback')
});

const LIMITS = {
  tolerance: [0, 15],
  leadS: [5, 40],
};

function clamp(v, [lo, hi]) { return Math.min(hi, Math.max(lo, v)); }

function sanitize(raw) {
  const s = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in raw)) continue;
      const def = DEFAULTS[k];
      if (typeof def === 'boolean') s[k] = !!raw[k];
      else if (typeof def === 'number' && Number.isFinite(Number(raw[k]))) s[k] = clamp(Number(raw[k]), LIMITS[k] || [-Infinity, Infinity]);
    }
  }
  return s;
}

export function createSettings() {
  let state = load();
  const listeners = new Set();

  function load() {
    try {
      const txt = globalThis.localStorage?.getItem(KEY);
      return sanitize(txt ? JSON.parse(txt) : null);
    } catch {
      return { ...DEFAULTS };
    }
  }
  function save() {
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify(state)); } catch { /* privémodus / vol: negeren */ }
  }

  return {
    get: () => ({ ...state }),
    set(patch) {
      const prev = state;
      state = sanitize({ ...state, ...patch });
      save();
      const changed = Object.keys(state).filter((k) => state[k] !== prev[k]);
      if (changed.length) listeners.forEach((cb) => { try { cb(state, changed); } catch (e) { console.error(e); } });
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

/** Koppelt het instellingen-sheet in de DOM aan het settings-object. */
export function bindSettingsUI(settings, root = document) {
  const boolKeys = ['sound', 'voice', 'night', 'headingUp', 'showMap', 'silentOverride'];
  const stepKeys = ['tolerance', 'leadS'];

  function render(s) {
    for (const k of boolKeys) {
      const el = root.getElementById(`set-${k}`);
      if (el) el.checked = !!s[k];
    }
    for (const k of stepKeys) {
      const el = root.getElementById(`set-${k}`);
      if (el) el.textContent = String(s[k]);
    }
  }

  for (const k of boolKeys) {
    root.getElementById(`set-${k}`)?.addEventListener('change', (e) => settings.set({ [k]: e.target.checked }));
  }
  root.querySelectorAll('[data-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.step;
      const d = Number(btn.dataset.delta) || 0;
      settings.set({ [k]: settings.get()[k] + d });
    });
  });

  render(settings.get());
  settings.onChange(render);
}
