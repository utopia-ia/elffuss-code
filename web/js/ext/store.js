// Extensiones instaladas, en su PROPIA base IndexedDB (elffuss-code-ext): así
// db.js no sube de versión y otra pestaña abierta con la versión vieja no
// bloquea la actualización. Nada de OPFS: con ?test-opfs la raíz de OPFS ES el
// proyecto, y los ficheros de las extensiones aparecerían en el árbol y para
// el agente.
//
//   ext    id → registro (versión, sha256, licencia, activa, contribuciones…)
//   files  "id@versión/ruta" → contenido ya parseado (tema, gramática…)
//          "id@versión/code/ruta" → bytes del código (nivel 2, js/ext2/host2.js)
//   meta   marcas internas
//
// La lista [{id, version, enabled, runs}] se refleja en kv «extensions» de la
// base principal, que es lo que ven el inventario y la copia del espacio de
// trabajo.
import * as maindb from '../db.js';

const NAME = 'elffuss-code-ext', VERSION = 1;
const MIRROR = 'extensions';
// La conexión se reabre si el navegador la cierra, y se aparta si otra pestaña
// pide una versión nueva (conexion() de db.js). Cada operación es UNA
// transacción dentro de run(), que la repite una vez si no pudo empezar o el
// navegador la abortó (abortada no escribió nada).
const { run } = maindb.conexion(() => new Promise((resolve, reject) => {
  const req = indexedDB.open(NAME, VERSION);
  req.onupgradeneeded = () => {
    for (const s of ['ext', 'files', 'meta']) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  req.onblocked = () => reject(Object.assign(new Error('base de extensiones bloqueada por otra pestaña'), { code: 'blocked' }));
}));
const done = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('transacción abortada')); });

export const fileKey = (id, version, path) => `${id}@${version}/${path}`;
export const codeKey = (id, version, path) => `${id}@${version}/code/${path}`;

export async function list() {
  const recs = await run(db => done(db.transaction('ext').objectStore('ext').getAll()));
  return recs.sort((a, b) => (a.installedAt || 0) - (b.installedAt || 0));
}
export const get = id => run(db => done(db.transaction('ext').objectStore('ext').get(id)));
export const getFile = key => run(db => done(db.transaction('files').objectStore('files').get(key)));

// Instala/reemplaza en UNA transacción: registro + ficheros nuevos, y fuera
// los de la versión anterior.
export async function put(rec, files) {
  await run(async db => {
    const tx = db.transaction(['ext', 'files'], 'readwrite');
    const fin = txDone(tx);
    fin.catch(() => {});   // se espera más abajo; si antes falla la lectura, que no quede sin atender
    const prev = await done(tx.objectStore('ext').get(rec.id));
    if (prev && prev.version !== rec.version) tx.objectStore('files').delete(rango(`${prev.id}@${prev.version}/`));
    for (const [k, v] of files) tx.objectStore('files').put(v, k);
    tx.objectStore('ext').put(rec, rec.id);
    await fin;
  });
  await writeMirror();
}

const rango = prefijo => IDBKeyRange.bound(prefijo, prefijo + '￿');

export async function remove(id) {
  await run(db => {
    const tx = db.transaction(['ext', 'files'], 'readwrite');
    tx.objectStore('files').delete(rango(`${id}@`));
    tx.objectStore('ext').delete(id);
    return txDone(tx);
  });
  await writeMirror();
}

export const getFiles = keys => run(db => {
  const st = db.transaction('files').objectStore('files');
  return Promise.all(keys.map(k => done(st.get(k))));
});

// Caché de cosas pequeñas de Open VSX (p. ej. lo que se sabe de un manifiesto
// por id@versión, para el filtro «Funciona en Code»).
export const getMeta = key => run(db => done(db.transaction('meta').objectStore('meta').get('cache:' + key)));
export const setMeta = (key, value) => run(db => {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, 'cache:' + key);
  return txDone(tx);
});

// Cambia un registro en una transacción (`cambia(rec)` lo modifica).
export async function update(id, cambia, { mirror = true } = {}) {
  const rec = await run(async db => {
    const tx = db.transaction('ext', 'readwrite');
    const fin = txDone(tx);
    fin.catch(() => {});   // se espera más abajo; si antes falla la lectura, que no quede sin atender
    const rec = await done(tx.objectStore('ext').get(id));
    if (!rec) throw new Error('no instalada: ' + id);
    cambia(rec);
    tx.objectStore('ext').put(rec, id);
    await fin;
    return rec;
  });
  if (mirror) await writeMirror();
  return rec;
}
export const setEnabled = (id, enabled) => update(id, r => { r.enabled = !!enabled; });

async function writeMirror() {
  const recs = await list();
  await maindb.set('kv', MIRROR, recs.map(r => ({ id: r.id, version: r.version, enabled: !!r.enabled, runs: !!r.runs })));
  await run(db => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(true, 'mirrored');
    return txDone(tx);
  });
}

// Al arrancar: la lista de kv «extensions» manda. Si alguien la borró (copia
// del espacio de trabajo → «borrar»), se borran también las extensiones; si
// nunca llegó a escribirse, se escribe ahora. Y fuera los ficheros huérfanos
// (de versiones viejas o de instalaciones a medias).
export async function reconcile() {
  let espejo;
  try { espejo = await maindb.get('kv', MIRROR); } catch { return; }   // sin lectura fiable no se toca nada
  const yaEscrito = await run(db => done(db.transaction('meta').objectStore('meta').get('mirrored')));
  let recs = await list();
  if (Array.isArray(espejo)) {
    const enLista = new Map(espejo.filter(e => e && e.id).map(e => [e.id, e]));
    for (const r of recs) if (!enLista.has(r.id)) await remove(r.id);
  } else if (espejo == null && yaEscrito) {
    for (const r of recs) await remove(r.id);
  }
  recs = await list();
  const vivos = new Set(recs.map(r => `${r.id}@${r.version}/`));
  const huerfanos = await run(async db => {
    const tx = db.transaction('files', 'readwrite');
    const fin = txDone(tx);
    fin.catch(() => {});   // se espera más abajo; si antes falla la lectura, que no quede sin atender
    const keys = await done(tx.objectStore('files').getAllKeys());
    let n = 0;
    for (const k of keys) {
      const i = String(k).indexOf('/');
      if (!vivos.has(String(k).slice(0, i + 1))) { tx.objectStore('files').delete(k); n++; }
    }
    await fin;
    return n;
  });
  await writeMirror();
  return { huerfanos };
}
