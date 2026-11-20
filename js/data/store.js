// Flitswacht — tegel-cache (W-DATA). IndexedDB met in-memory fallback.
// Record: { key, t (ms epoch, moment van opslaan), data:{ways,cameras,sections} }

const DB_NAME = 'flitswacht';
const META_PREFIX = 'meta:';
export const DAILY_BUDGET = 50; // A1.3: max. Overpass-verzoeken per kalenderdag
/** Sleutels die prune() nooit verwijdert (handhavingsdata is de enige kopie als je offline bent). */
export const PROTECTED_KEYS = new Set(['enforcement', 'camera-ways']);

const isMeta = (r) => typeof r?.key === 'string' && r.key.startsWith(META_PREFIX);
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; // lokale kalenderdag
}
const DB_VERSION = 1;
const STORE = 'tiles';

function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB-fout'));
  });
}

function createMemoryBackend() {
  const map = new Map();
  return {
    kind: 'memory',
    async get(key) { return map.get(key) ?? null; },
    async put(rec) { map.set(rec.key, rec); },
    async del(key) { map.delete(key); },
    async all() { return [...map.values()]; },
  };
}

function createIdbBackend(indexedDB, dbName) {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(dbName, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open mislukt'));
      req.onblocked = () => reject(new Error('IndexedDB geblokkeerd'));
    });
    return dbp;
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction(STORE, mode);
      const os = tx.objectStore(STORE);
      req2promise(fn(os)).then((r) => { result = r; }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB-transactie mislukt'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB-transactie afgebroken'));
    });
  }
  return {
    kind: 'indexeddb',
    async get(key) { return (await run('readonly', (os) => os.get(key))) ?? null; },
    async put(rec) { await run('readwrite', (os) => os.put(rec)); },
    async del(key) { await run('readwrite', (os) => os.delete(key)); },
    async all() { return (await run('readonly', (os) => os.getAll())) || []; },
  };
}

/**
 * createStore({indexedDB, now, dbName}) -> { getTile, putTile, listTiles, prune, backend }
 * Bij ontbreken of falen van IndexedDB schakelt de store (blijvend) over op geheugen.
 */
export function createStore({ indexedDB = null, now = Date.now, dbName = DB_NAME, dailyBudget = DAILY_BUDGET } = {}) {
  let backend = indexedDB ? createIdbBackend(indexedDB, dbName) : createMemoryBackend();
  let lastError = null;
  let budgetChain = Promise.resolve(); // serialiseert budget-updates (geen dubbele telling)

  async function call(method, ...args) {
    try {
      return await backend[method](...args);
    } catch (e) {
      if (backend.kind === 'memory') throw e;
      lastError = e;
      backend = createMemoryBackend(); // terugval; eerder opgeslagen IDB-data is in deze sessie niet meer zichtbaar
      return backend[method](...args);
    }
  }

  const api = {
    get backend() { return backend.kind; },
    get lastError() { return lastError; },
    /** -> {key, t, data} | null */
    async getTile(key) {
      const rec = await call('get', key);
      return rec && rec.data ? rec : null;
    },
    async putTile(key, data) {
      const rec = { key, t: now(), data };
      await call('put', rec);
      return rec;
    },
    /** -> [{key, t}] nieuwste eerst (zonder meta-records) */
    async listTiles() {
      const all = await call('all');
      return all.filter((r) => !isMeta(r)).map((r) => ({ key: r.key, t: r.t })).sort((a, b) => b.t - a.t);
    },
    async getMeta(name) {
      const r = await call('get', META_PREFIX + name);
      return r ? r.value : null;
    },
    async setMeta(name, value) {
      await call('put', { key: META_PREFIX + name, t: now(), value });
    },
    /** Resterend dagbudget (lokale kalenderdag). */
    async budgetLeft(limit = dailyBudget) {
      const b = await api.getMeta('budget');
      const used = b && b.day === dayKey(now()) ? b.used : 0;
      return Math.max(0, limit - used);
    },
    /** Neem 1 verzoek uit het dagbudget. -> {ok, left} ; ok=false als het op is (er wordt dan niets geteld). */
    consumeBudget(limit = dailyBudget) {
      const run = async () => {
        const day = dayKey(now());
        const b = await api.getMeta('budget');
        const used = b && b.day === day ? b.used : 0;
        if (used >= limit) return { ok: false, left: 0 };
        await api.setMeta('budget', { day, used: used + 1 });
        return { ok: true, left: limit - used - 1 };
      };
      const p = budgetChain.then(run, run);
      budgetChain = p.catch(() => {});
      return p;
    },
    /** Verwijder tegels ouder dan maxAgeMs en daarna alles boven maxCount (oudste eerst). Meta-records en
     *  PROTECTED_KEYS ('enforcement', 'camera-ways') blijven altijd staan. -> aantal verwijderd */
    async prune(maxAgeMs = Infinity, maxCount = Infinity) {
      const list = (await api.listTiles()).filter((r) => !PROTECTED_KEYS.has(r.key));
      const cutoff = now() - maxAgeMs;
      const doomed = [];
      let kept = 0;
      for (const r of list) {
        if (r.t < cutoff || kept >= maxCount) doomed.push(r.key);
        else kept++;
      }
      for (const k of doomed) await call('del', k);
      return doomed.length;
    },
  };
  return api;
}
