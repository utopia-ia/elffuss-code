// Las conexiones IndexedDB de Code (web/js/db.js y la base de extensiones,
// web/js/ext/store.js) sobreviven a que el navegador las cierre. Safari las
// cierra por su cuenta (pestaña dormida, falta de memoria, almacenamiento
// desalojado) y cada db.transaction() siguiente lanzaba «The database connection
// is closing». Sobre un IndexedDB falso (tests/lib/fake-idb.mjs) que cierra la
// conexión entre llamadas o debajo de una transacción: lecturas y escrituras
// reabren y se repiten UNA vez, nada se escribe dos veces, y lo que falla por sí
// mismo no se repite. Solo Node:
//   node tests/db-reconexion.mjs
import { fakeIndexedDB } from './lib/fake-idb.mjs';

let fallos = 0, n = 0;
const ok = (nombre, c, e = '') => { n++; console.log((c ? '✅' : '❌') + ' ' + nombre + (e && !c ? '  — ' + e : '')); if (!c) fallos++; };
const falla = async p => { try { await p; return null; } catch (e) { return e || new Error('rechazada sin error'); } };

const idb = fakeIndexedDB();
globalThis.indexedDB = idb;
globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper, includes: k => k >= lower && k <= upper }) };
const db = await import('../web/js/db.js');
const ext = await import('../web/js/ext/store.js');

// ── db.js ──
let avisos = 0;
db.onWrite(() => avisos++);
await db.set('kv', 'a', 1);
idb.closeAll();
ok('db: tras cerrar el navegador la conexión, leer reabre y lee', (await db.get('kv', 'a')) === 1);
idb.closeAll();
let w = idb.stats.writes;
await db.set('kv', 'b', 2);
ok('db: tras un cierre, escribir guarda exactamente una vez', idb.stats.writes - w === 1);
idb.abortNext();
w = idb.stats.writes;
await db.set('kv', 'c', 3);
ok('db: una escritura abortada se repite y se aplica una vez', idb.stats.writes - w === 1, String(idb.stats.writes - w));
ok('db: … y se avisa una vez por escritura', avisos === 3, String(avisos));
idb.abortNext(2);
w = idb.stats.writes;
const e = await falla(db.set('kv', 'd', 4));
ok('db: abortada dos veces: el error llega (un solo reintento) y no escribe', e?.name === 'AbortError' && idb.stats.writes === w, String(e?.name));
idb.versionChangeAll();
ok('db: versionchange aparta la conexión y la siguiente reabre', idb.liveConnections === 0 && (await db.keys('kv')).length === 3);

// ── ext/store.js ──
const rec = (v) => ({ id: 'acme.tema', version: v, enabled: true, runs: false, installedAt: 1 });
await ext.put(rec('1.0.0'), [[ext.fileKey('acme.tema', '1.0.0', 'tema.json'), { a: 1 }]]);
idb.closeAll();
ok('ext: tras un cierre, la lista reabre y lee', (await ext.list()).map(r => r.version).join() === '1.0.0');
idb.closeAll();
idb.abortNext();
await ext.put(rec('2.0.0'), [[ext.fileKey('acme.tema', '2.0.0', 'tema.json'), { a: 2 }]]);
const ficheros = [...idb.data('elffuss-code-ext', 'files').keys()];
ok('ext: instalar tras un cierre y un aborto deja la versión nueva, sin la vieja', ficheros.join() === 'acme.tema@2.0.0/tema.json', ficheros.join());
ok('ext: … y el reflejo en kv «extensions» se escribió', (await db.get('kv', 'extensions'))?.[0]?.version === '2.0.0');
idb.closeAll();
idb.abortNext();

const r2 = await ext.update('acme.tema', r => { r.enabled = false; });
ok('ext: update tras cierre y aborto: lo aplicado está guardado', r2.enabled === false && (await ext.get('acme.tema')).enabled === false);
const e2 = await falla(ext.update('no.existe', () => {}));
ok('ext: un error propio (no instalada) no se repite', /no instalada/.test(e2?.message || ''));
idb.closeAll();
ok('ext: getFiles tras un cierre', (await ext.getFiles([ext.fileKey('acme.tema', '2.0.0', 'tema.json')]))[0]?.a === 2);
idb.closeAll();
await ext.setMeta('x', { ok: true });
ok('ext: meta tras un cierre', (await ext.getMeta('x'))?.ok === true);
idb.closeAll();
const rc = await ext.reconcile();
ok('ext: reconcile tras un cierre', rc && rc.huerfanos === 0, JSON.stringify(rc));
idb.closeAll();
await ext.remove('acme.tema');
ok('ext: desinstalar tras un cierre borra registro y ficheros', (await ext.list()).length === 0 && idb.data('elffuss-code-ext', 'files').size === 0);

console.log(`\n${n - fallos}/${n} ${fallos ? '❌' : '✅'}`);
process.exit(fallos ? 1 : 0);
