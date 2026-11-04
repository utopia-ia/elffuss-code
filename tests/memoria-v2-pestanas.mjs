// Dos pestañas de Code con la misma memoria de proyectos (Node, sin navegador).
//
//   node tests/memoria-v2-pestanas.mjs
//
// El registro de proyectos de la memoria (el pid aleatorio de cada carpeta y su
// «Sin memoria») vive en el kv de Code, en IndexedDB, que comparten todas las
// pestañas del mismo origen. Aquí se cargan DOS copias de memory-wire.js (dos
// pestañas) sobre una IndexedDB falsa compartida, y se comprueba que ninguna
// pestaña trabaja con una copia vieja del registro:
//   · una pestaña abierta antes no crea otro pid para un proyecto que la otra
//     ya registró (los hechos del proyecto no se quedan huérfanos);
//   · «Sin memoria» puesto en una pestaña vale en la otra en su siguiente turno;
//   · abrir otro proyecto en una pestaña no devuelve a «con memoria» lo que la
//     otra puso en «Sin memoria»;
//   · dos pestañas que abren a la vez un proyecto nuevo acaban con el mismo pid.

// IndexedDB mínima, compartida por las dos «pestañas». Guarda copias, como la
// de verdad: lo que una pestaña cambia en su array no le llega a la otra hasta
// que lo escribe y la otra lo vuelve a leer.
const bases = new Map();
const copia = (v) => (Array.isArray(v) ? v.map((o) => (o && typeof o === 'object' ? { ...o } : o)) : v);
const peticion = (fn) => {
  const r = {};
  setTimeout(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }, 0);
  return r;
};
globalThis.indexedDB = {
  open(name) {
    const r = {};
    setTimeout(() => {
      if (!bases.has(name)) bases.set(name, new Map());
      const stores = bases.get(name);
      const nueva = stores.size === 0;
      r.result = {
        objectStoreNames: { contains: (s) => stores.has(s) },
        createObjectStore: (s) => stores.set(s, new Map()),
        transaction: (s) => ({
          objectStore: () => {
            const m = stores.get(s);
            return {
              get: (k) => peticion(() => copia(m.get(k))),
              put: (v, k) => peticion(() => { m.set(k, copia(v)); }),
              delete: (k) => peticion(() => { m.delete(k); }),
            };
          },
        }),
      };
      if (nueva) r.onupgradeneeded?.();
      r.onsuccess?.();
    }, 0);
    return r;
  },
};

let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };

const carpeta = (name) => {
  const yo = { name, kind: 'directory', async *keys() {}, isSameEntry: async (o) => o === yo };
  return yo;
};
const X = carpeta('tienda-web');
const Y = carpeta('otro-repo');
const Z = carpeta('tercero');

const A = await import('../web/js/memory-wire.js?pestana=a');
const B = await import('../web/js/memory-wire.js?pestana=b');
const C = await import('../web/js/memory-wire.js?pestana=c');
let enA = null, enB = null, enC = null;
A.alPreguntarProyecto(() => enA);
B.alPreguntarProyecto(() => enB);
C.alPreguntarProyecto(() => enC);

// La pestaña B se abrió antes, con otro proyecto: ya ha leído el registro vacío.
enB = Y;
await B.proyecto({ crear: false });

// a) A abre X y le da un pid. Luego B abre X: tiene que ser el MISMO pid.
enA = X;
const pA = await A.proyecto();
enB = X;
const pB = await B.proyecto();
ok('una pestaña abierta antes usa el pid que la otra ya dio al proyecto', pA?.pid && pB?.pid === pA.pid, `${pA?.pid} vs ${pB?.pid}`);
const pA2 = await A.proyecto();
ok('…y la primera pestaña conserva su pid (no se ha sobrescrito)', pA2?.pid === pA?.pid, `${pA?.pid} vs ${pA2?.pid}`);

// b) «Sin memoria» en A vale en B en su siguiente turno.
await A.ponerSinMemoria(true);
ok('«Sin memoria» puesto en una pestaña vale en la otra', (await B.proyecto())?.sinMemoria === true);

// c) B abre otro proyecto (escribe el registro): X sigue «Sin memoria».
enB = Z;
await B.proyecto();
enC = X;
ok('abrir otro proyecto en una pestaña no quita el «Sin memoria» que puso la otra', (await C.proyecto({ crear: false }))?.sinMemoria === true);
ok('…ni cambia el pid del proyecto', (await C.proyecto({ crear: false }))?.pid === pA?.pid);

// d) Dos pestañas abren a la vez un proyecto que nadie tenía.
const N = carpeta('nuevo-a-la-vez');
enA = N; enB = N;
const [n1, n2] = await Promise.all([A.proyecto(), B.proyecto()]);
ok('dos pestañas que abren a la vez un proyecto nuevo le dan el mismo pid', n1?.pid && n1.pid === n2?.pid, `${n1?.pid} vs ${n2?.pid}`);
enC = N;
ok('…y es el que queda guardado', (await C.proyecto({ crear: false }))?.pid === n1?.pid);

console.log(fallos ? `\n❌ ${fallos} fallos` : '\n✅ todo bien');
process.exit(fallos ? 1 : 0);
