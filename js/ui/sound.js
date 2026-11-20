// Geluid en spraak: eigen WebAudio-tonen (oscillator) per level + Nederlandse spraak.
// Moet ontgrendeld worden binnen een gebruikerstik (iOS Safari): roep unlock() aan in de "Start rit"-handler.

export function createSound(getSettings) {
  let ctx = null;
  let master = null;
  let voice = null;
  let voicesTried = false;
  const synth = globalThis.speechSynthesis || null;

  function pickVoice() {
    if (!synth) return null;
    let list = [];
    try { list = synth.getVoices() || []; } catch { list = []; }
    if (!list.length) return null;
    voicesTried = true;
    const nl = list.filter((v) => /^nl([-_]|$)/i.test(v.lang || ''));
    const nlNL = nl.filter((v) => /^nl[-_]NL$/i.test(v.lang));
    // Voorkeur: nl-NL, liefst een lokale stem (werkt offline), dan nl-BE, anders standaard (null).
    const pref = (arr) => arr.find((v) => v.localService) || arr[0] || null;
    return pref(nlNL) || pref(nl) || null;
  }
  if (synth) {
    voice = pickVoice();
    try {
      synth.addEventListener?.('voiceschanged', () => { voice = pickVoice() || voice; });
    } catch { /* oudere Safari */ }
  }

  /**
   * iOS 17+: navigator.audioSession. 'playback' = ook hoorbaar met de stilteschakelaar (kan muziek onderbreken),
   * 'transient' = standaard (respecteert stille modus, dempt muziek kort). Feature-detect.
   */
  function applyAudioSession() {
    const as = globalThis.navigator?.audioSession;
    if (!as) return false;
    try { as.type = getSettings().silentOverride ? 'playback' : 'transient'; return true; } catch { return false; }
  }

  /**
   * Binnen een tik aanroepen. greeting: tekst die SYNCHROON wordt uitgesproken (eerste speak() in de tik,
   * vereist door iOS om spraak later zonder tik toe te staan). Geeft {audio, speech, voiceName} terug.
   */
  function unlock({ greeting = '' } = {}) {
    applyAudioSession();
    let audioOk = false;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AC) {
        if (!ctx) {
          ctx = new AC();
          master = ctx.createGain();
          master.gain.value = 0.9;
          master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        // stille buffer afspelen: ontgrendelt audio op iOS
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf; src.connect(ctx.destination); src.start(0);
        audioOk = true;
      }
    } catch (e) { console.warn('Audio ontgrendelen mislukt', e); }

    let speechOk = false;
    if (synth) {
      try {
        if (!voicesTried) voice = pickVoice();
        const audible = !!greeting && getSettings().voice;
        const u = new SpeechSynthesisUtterance(audible ? greeting : ' ');
        u.lang = voice?.lang || 'nl-NL';
        if (voice) u.voice = voice;
        u.volume = audible ? 1 : 0;
        // U11: géén synth.cancel() vlak vóór deze speak(): WebKit laat dan soms de eerste utterance vallen.
        synth.speak(u);   // synchroon, nog binnen de tik
        speechOk = true;
      } catch (e) { console.warn('Spraak ontgrendelen mislukt', e); }
      if (!voicesTried) voice = pickVoice();
    }
    return { audio: audioOk, speech: speechOk, voiceName: voice ? `${voice.name} (${voice.lang})` : null };
  }

  /** Na terugkeer uit de achtergrond kan iOS de context opschorten. */
  function resume() {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  // --- tonen ---------------------------------------------------------------------------------
  function blip(t0, freq, dur, { type = 'sine', gain = 0.5, slideTo = null } = {}) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // Elk patroon: eigen ontwerp. info = zachte stijgende tweeklank, warn = drie heldere tikken,
  // now = snelle dalende sirene-achtige reeks, over = lage dubbele brom, section = drieklank.
  const PATTERNS = {
    info(t) { blip(t, 587, 0.16, { gain: 0.35 }); blip(t + 0.17, 880, 0.24, { gain: 0.35 }); },
    warn(t) { for (let i = 0; i < 3; i++) blip(t + i * 0.2, 1046, 0.12, { type: 'triangle', gain: 0.55 }); },
    now(t) {
      for (let i = 0; i < 4; i++) blip(t + i * 0.16, 1480, 0.13, { type: 'square', gain: 0.22, slideTo: 990 });
    },
    over(t) { blip(t, 330, 0.14, { type: 'sawtooth', gain: 0.18 }); blip(t + 0.2, 330, 0.14, { type: 'sawtooth', gain: 0.18 }); },
    section(t) { blip(t, 523, 0.14, { gain: 0.35 }); blip(t + 0.14, 659, 0.14, { gain: 0.35 }); blip(t + 0.28, 784, 0.26, { gain: 0.35 }); },
    // onzekere melding (uncertain): één zachte, lage toon
    maybe(t) { blip(t, 494, 0.22, { gain: 0.25 }); },
    ok(t) { blip(t, 784, 0.12, { gain: 0.3 }); blip(t + 0.13, 1046, 0.2, { gain: 0.3 }); },
  };

  function tone(kind) {
    if (!getSettings().sound || !ctx || !PATTERNS[kind]) return;
    try {
      resume();
      PATTERNS[kind](ctx.currentTime + 0.03);
    } catch (e) { console.warn('Toon mislukt', e); }
  }

  // --- spraak --------------------------------------------------------------------------------
  let lastSpoken = { text: '', t: 0 };
  function say(text, { interrupt = false } = {}) {
    if (!getSettings().voice || !synth || !text) return;
    const now = Date.now();
    if (text === lastSpoken.text && now - lastSpoken.t < 4000) return;
    lastSpoken = { text, t: now };
    try {
      if (interrupt) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voice?.lang || 'nl-NL';
      if (voice) u.voice = voice;
      u.rate = 1.05; u.pitch = 1; u.volume = 1;
      // Spraak iets na de toon laten beginnen
      setTimeout(() => { try { synth.speak(u); } catch { /* negeren */ } }, getSettings().sound ? 450 : 0);
    } catch (e) { console.warn('Spraak mislukt', e); }
  }

  function stop() { try { synth?.cancel(); } catch { /* */ } }

  return {
    unlock, resume, tone, say, stop, applyAudioSession,
    get audioSessionSupported() { return !!globalThis.navigator?.audioSession; },
    get voiceName() { return voice ? `${voice.name} (${voice.lang})` : null; },
    get unlocked() { return !!ctx; },
  };
}

// --- teksten ----------------------------------------------------------------------------------
export const TYPE_LABEL = {
  fixed: 'Flitser',
  redlight: 'Roodlichtcamera',
  section_start: 'Begin trajectcontrole',
  section_end: 'Einde trajectcontrole',
  mobile: 'Mobiele flitser',
};

/**
 * Weergave-/spraaklabel voor een alert, inclusief tak na een splitsing (Alert.branch, A3/N1-N2):
 * 'exit' -> "Flitser op de afrit", 'main' -> "Flitser na de afrit", 'unknown' -> "Flitser op de A27" of
 * "Flitser na de splitsing", null -> "Flitser".
 */
export function alertLabel(alert) {
  const base = TYPE_LABEL[alert?.camera?.type] || 'Flitser';
  if (alert?.branch === 'exit') return `${base} op de afrit`;
  if (alert?.branch === 'main') return `${base} na de afrit`;
  // Y-splitsing zonder afrit: tak benoemen als de wegnaam/ref bekend is, anders "na de splitsing" (R1)
  if (alert?.branch === 'unknown') return alert.branchName ? `${base} op de ${alert.branchName}` : `${base} na de splitsing`;
  return base;
}

/** Afstand voor spraak: <1 km afgerond op 50 m, daarboven op 100 m in kilometers. */
export function spokenDistance(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.max(50, Math.round(m / 50) * 50)} meter`;
  const km = Math.round(m / 100) / 10;
  return `${String(km).replace('.', ',')} kilometer`;
}

/** Bouwt de gesproken zin voor een alert, bv. "Flitser over 400 meter, 80". */
export function alertSpeech(alert) {
  const label = alertLabel(alert);
  if (alert.uncertain) {
    // A3/C2-C3: geen 'nu'-alarm, eerlijk "mogelijk"
    return `Mogelijk ${label.toLowerCase()} over ${spokenDistance(alert.distM)}`;
  }
  const lim = alert.limit ? `, ${alert.limit}` : '';
  if (alert.camera?.type === 'mobile') {
    if (alert.level === 'now') return 'Mobiele flitser nu';
    return `Mobiele flitser gemeld over ${spokenDistance(alert.distM)}${lim}`;
  }
  if (alert.level === 'now') {
    return alert.overLimit ? `${label} nu. Te hard${lim}` : `${label} nu`;
  }
  const extra = alert.level === 'warn' && alert.overLimit ? '. Let op, te hard' : '';
  return `${label} over ${spokenDistance(alert.distM)}${lim}${extra}`;
}
