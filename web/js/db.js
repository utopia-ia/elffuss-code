// IndexedDB mínima: stores clave→valor.
const NAME = 'elffuss-code', VERSION = 2;
const STORES = ['kv', 'apps', 'tasks', 'vault', 'fs', 'memory'];
// Una conexión IndexedDB que sobrevive a que el navegador la cierre. Safari
// cierra por su cuenta las conexiones de una página (pestaña dormida en segundo
// plano, falta de memoria, almacenamiento desalojado) y desde entonces cada
// db.transaction() lanza «The database connection is closing». Así que la
// conexión se olvida al cerrarse o cuando otra pestaña pide una versión nueva,
// y una transacción que no pudo empezar, o que el navegador abortó, se repite
// UNA vez con una conexión nueva. Nunca escribe dos veces: una transacción
// abortada no confirma nada, y la que falla por sí misma (una clave mala, la
// cuota) no se repite.
//   abrir()  → promesa de una conexión NUEVA
//   run(fn)  → fn(db) abre una transacción y devuelve su promesa
const CONEXION_PERDIDA = new Set(['InvalidStateError', 'AbortError', 'UnknownError']);
export function conexion(abrir) {
  let actual = null;
  const olvida = p => { if (actual === p) actual = null; };
  const open = () => {
    if (actual) return actual;
    const p = actual = abrir().then(db => {
      db.onclose = () => olvida(p);
      db.onversionchange = () => { db.close(); olvida(p); };
      return db;
    });
    p.catch(() => olvida(p));
    return p;
  };
  const run = async fn => {
    for (let otra = false; ; otra = true) {
      const p = open();
      const db = await p;
      try { return await fn(db); }
      catch (e) {
        if (otra || !CONEXION_PERDIDA.has(e?.name)) throw e;
        olvida(p);
        try { db.close(); } catch { /* ya se estaba cerrando */ }
      }
    }
  };
  return { open, run };
}

const { run } = conexion(() => new Promise((resolve, reject) => {
  const req = indexedDB.open(NAME, VERSION);
  req.onupgradeneeded = () => {
    for (const s of STORES)
      if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
}));

// Resuelve con el resultado de la petición cuando la transacción TERMINA (una
// escritura ya está guardada); rechaza si la transacción se aborta.
function tx(store, mode, fn) {
  return run(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onabort = () => reject(t.error || req.error || new Error('transacción abortada'));
  }));
}

// Quien necesite saber que algo se escribió (el espacio de trabajo, que copia
// conversaciones y skills a tu disco con «Guardar solo») se apunta aquí. Un
// fallo de quien escucha nunca rompe la escritura.
const oyentes = [];
export function onWrite(fn) {
  oyentes.push(fn);
  return () => { const i = oyentes.indexOf(fn); if (i >= 0) oyentes.splice(i, 1); };
}
const avisa = (store, key) => (r) => { for (const f of oyentes) { try { f(store, key); } catch { /* */ } } return r; };

export const get  = (store, key)      => tx(store, 'readonly',  s => s.get(key));
export const set  = (store, key, val) => tx(store, 'readwrite', s => s.put(val, key)).then(avisa(store, key));
export const del  = (store, key)      => tx(store, 'readwrite', s => s.delete(key)).then(avisa(store, key));
export const keys = (store)           => tx(store, 'readonly',  s => s.getAllKeys());
export const all  = (store)           => tx(store, 'readonly',  s => s.getAll());
