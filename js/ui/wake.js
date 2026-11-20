// Scherm-aan-houden via de Screen Wake Lock API, opnieuw aanvragen na terugkeer (visibilitychange).

export function createWakeLock(onStatus = () => {}) {
  let sentinel = null;
  let wanted = false;

  async function request() {
    if (!('wakeLock' in navigator)) {
      onStatus('unsupported');
      return false;
    }
    try {
      const s = await navigator.wakeLock.request('screen');
      if (!wanted) { try { await s.release(); } catch { /* */ } return false; } // intussen gestopt
      sentinel = s;
      onStatus('active');
      s.addEventListener?.('release', () => {
        // U4: alleen de HUIDIGE sentinel wissen, niet een nieuwere na snel stop-start
        if (sentinel !== s) return;
        sentinel = null;
        // Bij verbergen laat het systeem de lock vallen; dat is geen fout.
        if (wanted && document.visibilityState === 'visible') onStatus('released');
      });
      return true;
    } catch (e) {
      onStatus('denied', e);
      return false;
    }
  }

  function onVisibility() {
    if (wanted && document.visibilityState === 'visible' && !sentinel) request();
  }
  document.addEventListener('visibilitychange', onVisibility);

  return {
    /** Binnen een tik aanroepen. Geeft de promise van de eerste aanvraag terug. */
    start() { wanted = true; return request(); },
    async stop() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      try { await s?.release(); } catch { /* */ }
    },
    get active() { return !!sentinel; },
  };
}

export const WAKE_HELP =
  'Gaat het scherm uit, dan stopt iOS de app: géén waarschuwingen. Scherm-aan vereist iOS 18.4+ en werkt niet in ' +
  'Energiebesparing. Anders: Instellingen › Beeldscherm en helderheid › Automatisch slot op "Nooit".';
