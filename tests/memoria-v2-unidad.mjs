// La memoria compartida en Code, sin navegador: el agente con el almacén del
// motor abierto en el mismo proceso (memory-wire.js usarAlmacenEnProceso) y un
// modelo guionado.
//
//   node tests/memoria-v2-unidad.mjs
//
// Lo que se comprueba:
//   · sin memoria (fuera del origen de Code) el prompt de sistema es BYTE A BYTE
//     el de la rama base, y no hay herramientas de memoria;
//   · con memoria: las tres herramientas en el catálogo y en «USA SOLO», las
//     reglas y un ejemplo, y el prompt no cambia entre turnos;
//   · «recuerda que…» escrito → guardado como pedido por el usuario, desde
//     Code, con su tarjeta; el bloque <memoria> va en el mensaje de estado del
//     turno siguiente, no en el prompt de sistema;
//   · lo NO escrito (pegado, una tarea) no se guarda; tras cualquier herramienta
//     que no sea de memoria, guardar es solo una propuesta; olvidar nunca borra
//     sin el clic;
//   · hechos del proyecto → ámbito del proyecto, y otro proyecto no los ve;
//     «Sin memoria» en un proyecto: ni bloque ni escrituras;
//   · modo básico: «recuerda que…» llama a memory.save solo con memoria;
//   · la reserva del bloque solo va al proveedor que la declara (LiteRT).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };

// ── 0. Sin memoria: el prompt de la rama base, byte a byte ─────────────────
const agente = await import('../web/js/agent.js');
const indice = await import('../web/js/tools/index.js');
const wire = await import('../web/js/memory-wire.js');
const sinMemoria = agente.systemPrompt('');
ok('sin memoria: ninguna herramienta de memoria en el catálogo', !Object.keys(indice.TOOLS).some((k) => k.startsWith('memory.')));
ok('sin memoria: el prompt no nombra la memoria', !/memory\.|MEMORIA/.test(sinMemoria));
let base = null;
try {
  const git = (args) => execFileSync('git', ['-C', RAIZ, ...args], { encoding: 'utf8' }).trim();
  const mb = git(['merge-base', 'HEAD', process.env.MEMORIA_BASE || 'main']);
  const dir = mkdtempSync(join(tmpdir(), 'code-base-'));
  execFileSync('sh', ['-c', `git -C "$1" archive "$2" web/js | tar -x -C "$3"`, 'sh', RAIZ, mb, dir]);
  const b = await import(pathToFileURL(join(dir, 'web', 'js', 'agent.js')).href);
  base = b.systemPrompt('');
  rmSync(dir, { recursive: true, force: true });
} catch (e) { console.log('   (sin git o sin la rama base: no se compara con ella)', e?.message || ''); }
if (base !== null) ok('sin memoria: el prompt es byte a byte el de la rama base', sinMemoria === base, `${sinMemoria.length} vs ${base.length}`);

// Fuera del origen de Code (aquí no hay location) la memoria no carga.
ok('sin el origen de Code la memoria no carga', (await wire.cargar()) === null);

// ── 1. Con memoria: el almacén del motor en este proceso ───────────────────
globalThis.location = { origin: 'https://code.elffuss.com', href: 'https://code.elffuss.com/' };
const { default: cfg } = await import('../web/memory/memory.config.js');
const almacen = await import('../web/js/engine/memory-store.js');
const store = await almacen.openStore(cfg, { backend: almacen.memoryBackend() });
// Code necesita el permiso del usuario para escribir: se da como lo daría su tarjeta.
ok('(permiso de Code dado)', (await store.call('grant', { state: 'granted' }, { app: 'code', direct: true })).ok === true);
wire.usarAlmacenEnProceso(store);
// Dos «carpetas» de proyecto, con lo que memory-wire mira de ellas.
const carpeta = (name, ficheros) => {
  const yo = { name, kind: 'directory', async *keys() { for (const f of ficheros) yield f; }, isSameEntry: async (o) => o === yo };
  return yo;
};
const P1 = carpeta('tienda-web', ['package.json', 'src', 'README.md', 'vite.config.js']);
const P2 = carpeta('otro-repo', ['Cargo.toml', 'src']);
let abierta = P1;
wire.alPreguntarProyecto(() => abierta);
wire.alPreguntarModelo(() => 'rules');

// La carga anterior falló (sin location) y no se quedó apagada: esta vez carga.
const M = await wire.cargar();
ok('con el origen de Code la memoria carga', !!M, 'cargar() devolvió null');
if (!M) { console.log('— no sigo sin memoria'); process.exit(1); }

const nombres = Object.keys(indice.TOOLS).filter((k) => k.startsWith('memory.'));
ok('las tres herramientas de memoria están en el catálogo', nombres.join() === 'memory.save,memory.list,memory.forget', nombres.join());
const conMemoria = agente.systemPrompt('');
ok('«USA SOLO» nombra las de memoria', /web\.fetch \/ memory\.save \/ memory\.list \/ memory\.forget\. NO existen/.test(conMemoria));
ok('el prompt lleva las reglas de memoria (5) y un ejemplo de memory.save',
  /MEMORIA \(/.test(conMemoria) && /\n5\. /.test(conMemoria.split('MEMORIA (')[1] || '') && conMemoria.includes('{"tool": "memory.save", "args": {"fact": "Prefiere pnpm"}}'));
ok('…y nada más cambia: quitando eso es el prompt sin memoria', (() => {
  const reglas = '\n\nMEMORIA (lo que el usuario te pidió recordar; la comparte con sus otras apps Elffuss):\n' + wire.reglas();
  const ej = '\nUsuario: recuerda que prefiero pnpm\nTú:\n```tool\n{"tool": "memory.save", "args": {"fact": "Prefiere pnpm"}}\n```';
  const catalogo = '\n' + nombres.map((n) => `- ${n}(${Object.keys(indice.TOOLS[n].params).join(', ')}): ${indice.TOOLS[n].desc}`).join('\n');
  return conMemoria.replace(catalogo, '').replace(' / memory.save / memory.list / memory.forget', '').replace(reglas, '').replace(ej, '') === sinMemoria;
})());

// ── 2. El modelo guionado ──────────────────────────────────────────────────
// Decide por el último mensaje del usuario que no es un resultado y por cuántos
// resultados lleva detrás. Apunta lo que recibe en cada llamada.
const llamadas = [];
let guion = () => 'Vale.';
const modelo = {
  chat: async (history, system, onToken, opts) => {
    llamadas.push({ history: history.map((x) => ({ ...x, efimero: !!x.efimero })), system, opts });
    let i = history.length - 1, resultados = 0;
    while (i >= 0 && (history[i].role !== 'user' || history[i].efimero || history[i].content.startsWith('[resultado'))) {
      if (history[i].role === 'user' && history[i].content.startsWith('[resultado')) resultados++;
      i--;
    }
    return guion(history[i]?.content || '', resultados);
  },
};
const llamada = (tool, args) => '```tool\n' + JSON.stringify({ tool, args }) + '\n```';
const ag = new agente.Agent(modelo);
ag.convId = 'cprueba1';
const turno = async (texto, { typed = true, g } = {}) => {
  guion = g || guion;
  const ev = [];
  llamadas.length = 0;
  await ag.handle(texto, (e) => ev.push(e), { typed });
  return ev;
};
const todos = async () => (await store.call('all', {}, { app: 'manager', ui: true, direct: true })).result;

// a) «recuerda que…» escrito
let ev = await turno('recuerda que prefiero respuestas cortas', {
  g: (u, r) => (r === 0 ? llamada('memory.save', { fact: 'Prefiere respuestas cortas' }) : 'Hecho.'),
});
let recs = (await todos()).records.filter((x) => x.status === 'active');
const corta = recs.find((x) => /respuestas cortas/.test(x.fact));
ok('«recuerda que…» escrito: guardado activo', !!corta, JSON.stringify(recs.map((x) => x.fact)));
ok('…pedido por el usuario y desde Code', corta?.source?.how === 'user-asked' && corta?.source?.app === 'code', JSON.stringify(corta?.source));
ok('…de la conversación de Code', corta?.source?.conv === 'cprueba1');
ok('…de todas las apps (no es del proyecto)', corta?.scope === 'all', corta?.scope);
ok('…con la tarjeta «Recordado»', ev.some((e) => e.type === 'memoria' && e.card?.type === 'saved'));
const sist1 = llamadas[0]?.system;
const estado2 = llamadas[1]?.history.find((x) => x.efimero)?.content || '';
ok('tras guardar, el bloque se rehace en el mismo turno (va en el mensaje de estado)', /<(memoria|memory)>[\s\S]*respuestas cortas[\s\S]*<\/(memoria|memory)>/.test(estado2), estado2.slice(0, 200));
ok('el prompt de sistema no lleva hechos', !/respuestas cortas/.test(sist1 || ''));

// b) el turno siguiente lo tiene presente, y el prompt no cambia
ev = await turno('¿cómo te pedí que te respondiera?', { g: () => 'Corto.' });
const estado = llamadas[0]?.history.find((x) => x.efimero);
ok('turno siguiente: <memoria> en el mensaje de estado, antes del último mensaje',
  /<(memoria|memory)>[\s\S]*respuestas cortas/.test(estado?.content || '') && llamadas[0].history.at(-1).content === '¿cómo te pedí que te respondiera?');
ok('…y el mensaje de estado sigue llevando el estado del IDE', /Proyecto abierto:/.test(estado?.content || ''));
ok('el prompt de sistema es el mismo byte a byte entre turnos', llamadas[0]?.system === sist1);
ok('«N recuerdos presentes» tras la respuesta', ev.some((e) => e.type === 'memoria-usados' && e.facts?.length >= 1));
ok('sin reserva para un proveedor que no la declara: le llega la señal sola', llamadas[0]?.opts && typeof llamadas[0].opts.aborted === 'boolean');

// c) lo NO escrito no se guarda
ev = await turno('recuerda que uso yarn', { typed: false, g: (u, r) => (r === 0 ? llamada('memory.save', { fact: 'Usa yarn' }) : 'Vale.') });
recs = (await todos()).records.filter((x) => x.status === 'active');
ok('un mensaje no escrito (pegado, tarea) no guarda nada', !recs.some((x) => /yarn/.test(x.fact)), JSON.stringify(recs.map((x) => x.fact)));
ok('…ni deja propuesta', !(await todos()).proposals.some((x) => /yarn/.test(x.fact)));
// Aunque no sea escrito, el bloque (lo fijo: «Sobre ti», preferencias) ha entrado
// en el prompt: «N recuerdos presentes» lo tiene que decir igual.
const estadoNoEscrito = llamadas[0]?.history.find((x) => x.efimero)?.content || '';
ok('un turno no escrito también lleva el bloque fijo', /<(memoria|memory)>[\s\S]*respuestas cortas/.test(estadoNoEscrito));
ok('…y lo dice: «N recuerdos presentes» con esos hechos', ev.some((e) => e.type === 'memoria-usados' && e.facts?.some((f) => /respuestas cortas/.test(f))),
  JSON.stringify(ev.filter((e) => String(e.type).startsWith('memoria'))));

// d) tras otra herramienta, guardar es solo una propuesta
ev = await turno('recuerda que mi editor favorito es helix', {
  g: (u, r) => (r === 0 ? llamada('code.tree', {}) : r === 1 ? llamada('memory.save', { fact: 'Su editor favorito es helix' }) : 'Vale.'),
});
recs = (await todos()).records.filter((x) => x.status === 'active');
ok('turno contaminado (code.tree antes): nada activo', !recs.some((x) => /helix/.test(x.fact)));
const prop = (await todos()).proposals.find((x) => /helix/.test(x.fact));
ok('…queda una propuesta «no sale de tus palabras»', prop?.label === 'from-content', JSON.stringify(prop));
ok('…y su tarjeta pide el clic', ev.some((e) => e.type === 'memoria' && e.card?.type === 'proposal'));

// e) el modelo inventa: nada
await turno('hola, ¿qué tal?', { g: (u, r) => (r === 0 ? llamada('memory.save', { fact: 'Su contraseña del banco es 4321' }) : 'Vale.') });
ok('lo que el modelo se inventa no se guarda', !(await todos()).records.some((x) => /4321/.test(x.fact)) && !(await todos()).proposals.some((x) => /4321/.test(x.fact)));

// f) olvidar nunca borra sin el clic
ev = await turno('olvida lo de las respuestas cortas', { g: (u, r) => (r === 0 ? llamada('memory.forget', { query: 'respuestas cortas' }) : 'Te he preguntado.') });
ok('olvidar: tarjeta que pregunta', ev.some((e) => e.type === 'memoria' && e.card?.type === 'forget' && /respuestas cortas/.test(e.card.fact)));
ok('…y el hecho sigue activo hasta el clic', (await todos()).records.some((x) => /respuestas cortas/.test(x.fact) && x.status === 'active'));

// g) hechos del proyecto
await turno('recuerda que en este proyecto los tests van con vitest', {
  g: (u, r) => (r === 0 ? llamada('memory.save', { fact: 'En este proyecto los tests van con vitest' }) : 'Vale.'),
});
const p1 = await wire.proyecto();
const vit = (await todos()).records.find((x) => /vitest/.test(x.fact));
ok('un hecho de «este proyecto» va al ámbito del proyecto', vit?.scope === `project:${p1?.pid}`, vit?.scope);
ok('el pid del proyecto es aleatorio, local y estable', /^p[a-z0-9]{12}$/.test(p1?.pid || '') && (await wire.proyecto()).pid === p1.pid);
await turno('recuerda que vite.config.js usa el puerto 5174', {
  g: (u, r) => (r === 0 ? llamada('memory.save', { fact: 'vite.config.js usa el puerto 5174' }) : 'Vale.'),
});
ok('un hecho que nombra un fichero del proyecto también', (await todos()).records.find((x) => /5174/.test(x.fact))?.scope === `project:${p1.pid}`);
// Otro proyecto no lo ve.
abierta = P2;
await turno('¿con qué van los tests?', { g: () => 'No lo sé.' });
const estadoP2 = llamadas[0]?.history.find((x) => x.efimero)?.content || '';
ok('otro proyecto no ve los hechos del primero', !/vitest|5174/.test(estadoP2) && (await wire.proyecto()).pid !== p1.pid, estadoP2.slice(0, 160));
abierta = P1;
await turno('¿con qué van los tests?', { g: () => 'Con vitest.' });
ok('…y el primero sí', /vitest/.test(llamadas[0]?.history.find((x) => x.efimero)?.content || ''));

// h) «Sin memoria» en este proyecto
await wire.ponerSinMemoria(true);
ev = await turno('recuerda que uso tabs', { g: (u, r) => (r === 0 ? llamada('memory.save', { fact: 'Usa tabs' }) : 'Vale.') });
ok('«Sin memoria»: sin bloque', !/<(memoria|memory)>/.test(llamadas[0]?.history.find((x) => x.efimero)?.content || ''));
ok('…y sin escrituras', !(await todos()).records.some((x) => /tabs/.test(x.fact)));
await wire.ponerSinMemoria(false);

// i) Sin permiso todavía: el guardado pide permiso y, tras «Permitir», se repite
// con el estado del turno de CUANDO se pidió. Si el turno ha corrido otra
// herramienta después (y por eso está contaminado), el reintento sigue siendo
// lo que el usuario pidió con sus palabras, no una propuesta «No sale de tus palabras».
ok('(permiso de Code retirado)', (await store.call('revoke', { origin: 'https://code.elffuss.com' }, { app: 'manager', ui: true, direct: true, manager: true })).ok === true);
ev = await turno('recuerda que prefiero pnpm y luego mira el package.json', {
  g: (u, r) => (r === 0 ? llamada('memory.save', { fact: 'Prefiere pnpm' }) : r === 1 ? llamada('code.tree', {}) : 'Vale.'),
});
const permiso = ev.find((e) => e.type === 'memoria' && e.card?.type === 'grant');
ok('sin permiso: tarjeta de permiso con reintento', typeof permiso?.reintento === 'function');
ok('…y nada guardado aún', !(await todos()).records.some((x) => /pnpm/.test(x.fact)));
await store.call('grant', { state: 'granted' }, { app: 'code', direct: true });
await permiso?.reintento?.();
const pnpm = (await todos()).records.find((x) => /pnpm/.test(x.fact) && x.status === 'active');
ok('tras «Permitir», aunque el turno corriera otra herramienta después: guardado activo, pedido por el usuario',
  pnpm?.source?.how === 'user-asked', JSON.stringify({ rec: pnpm?.source, prop: (await todos()).proposals.find((x) => /pnpm/.test(x.fact))?.label }));

// ── 3. Modo básico ──────────────────────────────────────────────────────────
const rules = await import('../web/js/providers/rules.js');
const r1 = await rules.chat([{ role: 'user', content: 'recuerda que trabajo en Valencia' }], '');
ok('modo básico: «recuerda que…» llama a memory.save', /"tool":"memory\.save"/.test(r1) && /trabajo en Valencia/.test(r1), r1);
const r2 = await rules.chat([{ role: 'user', content: 'olvida dónde trabajo' }], '');
ok('modo básico: «olvida…» llama a memory.forget por el texto', /"tool":"memory\.forget"/.test(r2) && /"query"/.test(r2), r2);
const r3 = await rules.chat([{ role: 'user', content: 'árbol' }], '');
ok('modo básico: lo demás sigue igual', /"tool":"code\.tree"/.test(r3));

// ── 4. Reserva del bloque ──────────────────────────────────────────────────
const opciones = [];
const conReserva = { memoriaFueraDelHistorial: () => true, chat: async (h, s, t, o) => { opciones.push(o); return 'Vale.'; } };
const ag2 = new agente.Agent(conReserva);
await ag2.handle('¿cómo me gustan las respuestas?', () => {}, { typed: true });
ok('un proveedor que declara memoriaFueraDelHistorial recibe reserveTokens = tamaño del bloque',
  opciones[0] && opciones[0].reserveTokens > 0 && typeof opciones[0].signal?.aborted === 'boolean', JSON.stringify(opciones[0] && { r: opciones[0].reserveTokens }));

// ── 5. ¿Es del proyecto? ───────────────────────────────────────────────────
const ctxP = { nombre: 'tienda-web', ficheros: ['package.json', 'src', 'README.md', 'docs'] };
for (const [f, esperado] of [
  ['En este proyecto se usa pnpm', true], ['This project uses tabs', true], ['El repo despliega con rsync', true],
  ['tienda-web usa Vite', true], ['src/app.js tiene el router', true], ['Hay que tocar package.json con cuidado', true],
  ['Prefiere respuestas cortas', false], ['Vive en Valencia', false], ['Programa en Go', false], ['Su web es ejemplo.com', false],
]) ok(`¿del proyecto? «${f}» → ${esperado}`, wire.esDelProyecto(f, ctxP) === esperado);
// Palabras corrientes que también son carpetas de la raíz (web, app, docs…), fechas
// con barra, «y/o» y un proyecto que se llama como el usuario: datos personales,
// de todas las apps. Una ranura exclusiva (nombre, ciudad, cumpleaños…) nunca es
// del proyecto: en otro ámbito no sustituiría a la de todas las apps.
const ctxW = { nombre: 'ana', ficheros: ['web', 'app', 'docs', 'data', 'src', 'blog', 'package.json', 'vite.config.js', 'tienda_api'] };
for (const [f, esperado] of [
  ['Su web es ejemplo.com', false], ['Mi web es ejemplo.com', false], ['Escribe en su blog los domingos', false],
  ['Trabaja con data science', false], ['Su cumpleaños es el 4/11', false], ['Vive en Madrid y/o Toledo', false],
  ['Se llama Ana', false], ['Me llamo Ana', false], ['Trabaja en el repo de Acme', false],
  ['web/js/app.js tiene el router', true], ['La carpeta docs/ tiene la guía', true], ['vite.config.js usa el puerto 5174', true],
  ['tienda_api va con FastAPI', true], ['En este proyecto los tests van con vitest', true], ['El código de ana usa tabs', true],
]) ok(`¿del proyecto? (raíz con palabras corrientes) «${f}» → ${esperado}`, wire.esDelProyecto(f, ctxW) === esperado);

console.log(fallos ? `\n❌ ${fallos} fallos` : '\n✅ todo bien');
process.exit(fallos ? 1 : 0);
