// La memoria compartida (v2) dentro de Code.
// ─────────────────────────────────────────────────────────────────────────────
// Una sola memoria para todas las apps de Elffuss: la guarda la página almacén
// (claw.elffuss.com/memory/, con su propia base de datos) y la usan el chat de
// elffuss.com, Claw y Code. Code NO abre esa base de datos: habla con la página
// almacén por un iframe oculto (lo hace el cliente del motor, memory.js), y el
// panel es esa misma página en un iframe visible.
//
// Lo que hace este módulo, y nada más:
//   · cargar el motor de memoria (js/engine/memory*.js) y la configuración de
//     Elffuss (web/memory/memory.config.js, copia byte a byte de la de Claw);
//   · darle al agente lo que necesita en cada turno: el bloque de memoria, la
//     evidencia de lo que el usuario ESCRIBIÓ, la marca de turno contaminado, y
//     las tarjetas que la interfaz tiene que enseñar;
//   · el proyecto: un id aleatorio por proyecto (para los hechos «de este
//     proyecto») y su interruptor «Sin memoria».
//
// Solo se enciende en el origen de Code que dice la configuración. En cualquier
// otro (localhost de las pruebas, una copia servida en otro sitio) no hay
// memoria: ni iframe, ni herramientas, ni bloque, y el prompt queda como antes.
// Así una copia local nunca llama a la página almacén de producción.
//
// Si la memoria no carga, `cargar()` devuelve null y el turno sigue sin memoria
// (falla cerrada). La siguiente llamada lo vuelve a intentar.
import { uiLang } from './i18n.js';
import * as db from './db.js';

const APP = 'code';
// Code habla con el modelo en español (agent.js systemPrompt): las reglas y la
// descripción de las herramientas van en español para que los bytes de la
// cabeza del prompt no cambien con el idioma de la página. Las tarjetas y el
// bloque, en el idioma de la página.
const LANG_PROMPT = 'es';
// Code es oscuro: tarjetas y panel con la paleta «dark» de la configuración.
const SCHEME = 'dark';
// Proyectos que la memoria conoce: [{ handle, pid, sinMemoria }]. El handle es
// el de la carpeta (se compara con isSameEntry); el pid, aleatorio y local.
const PROYECTOS_KEY = 'memoria.proyectos';

let cargando = null;
let almacenEnProceso = null;      // ver usarAlmacenEnProceso
let M = null;             // { cfg, mem, memory, cards, core, text, rank }
let herramientasPuestas = null;   // (defs) => void, lo pone tools/index.js
let modeloActivo = () => null;    // () => id del cerebro activo, lo pone main.js
let proyectoActual = () => null;  // () => handle de la carpeta abierta, lo pone main.js

export function alRegistrarHerramientas(fn) { herramientasPuestas = fn; }
export function alPreguntarModelo(fn) { modeloActivo = fn; }
export function alPreguntarProyecto(fn) { proyectoActual = fn; }
export const lista = () => M;
// Un almacén del motor abierto en este mismo proceso (memory-store.js openStore)
// en lugar de la página almacén por iframe. Code no comparte origen con ella, así
// que en producción no se usa: es para las pruebas en Node, que no tienen
// iframes. Hay que llamarlo antes de la primera carga.
export function usarAlmacenEnProceso(store) { almacenEnProceso = store; }

// ── Carga ────────────────────────────────────────────────────────────────────

export function cargar() {
  if (!cargando) {
    cargando = abrir().catch((e) => {
      console.warn('[memoria] sin memoria:', e?.name || 'error');
      cargando = null;
      return null;
    });
  }
  return cargando;
}

async function abrir() {
  const { default: cfg } = await import('../memory/memory.config.js');
  const yo = cfg.apps.find((a) => a.id === APP);
  // Fuera del origen de Code no hay memoria (ver arriba). No es un fallo: se
  // recuerda para no reintentar en cada turno.
  if (!yo || yo.origin !== location.origin) { cargando = Promise.resolve(null); return null; }
  const [memory, cards, core, text, rank] = await Promise.all([
    import('./engine/memory.js'),
    import('./engine/memory-cards.js'),
    import('./engine/memory-core.js'),
    import('./engine/memory-text.js'),
    import('./engine/memory-rank.js'),
  ]);
  const slow = /(^|-)(2g|3g)$/.test(navigator.connection?.effectiveType || '');
  const mem = memory.createMemory(cfg, { app: APP, lang: uiLang(), slowNetwork: slow, ...(almacenEnProceso ? { direct: almacenEnProceso } : {}) });
  M = { cfg, mem, memory, cards, core, text, rank };
  herramientasPuestas?.(memory.memoryTools(cfg, LANG_PROMPT, { app: APP }));
  return M;
}

// ── Lo que ve el modelo ─────────────────────────────────────────────────────

// Las reglas de memoria para el prompt de sistema ('' sin memoria).
export function reglas() {
  return M ? M.memory.memoryPromptRules(M.cfg, LANG_PROMPT) : '';
}
// Los nombres de las herramientas de memoria ([] sin memoria).
export function nombresHerramientas() {
  return M ? Object.keys(M.memory.memoryTools(M.cfg, LANG_PROMPT, { app: APP })) : [];
}

// Modo básico (sin modelo): «recuerda que X», «qué recuerdas», «olvida X».
// null si no hay memoria o el texto no es una de esas órdenes.
export function intencionBasica(texto) {
  if (!M) return null;
  const i = M.memory.basicIntent(texto);
  if (!i) return null;
  const p = M.cfg.tools.prefix;
  if (i.op === 'save') return { tool: p + 'save', args: { fact: i.fact } };
  if (i.op === 'list') return { tool: p + 'list', args: {} };
  if (i.op === 'forget') return { tool: p + 'forget', args: { query: String(i.query).replace(/[?.!]+$/, '').trim() } };
  return null;
}

// ── Proyecto ─────────────────────────────────────────────────────────────────

// El registro lo comparten TODAS las pestañas de Code (es el kv de IndexedDB),
// así que se relee siempre antes de usarlo y se modifica dentro de un cerrojo
// Web Lock: leer, cambiar y escribir de una vez. Una copia guardada en la
// pestaña hacía que otra pestaña abierta antes diera OTRO pid al mismo proyecto
// (sus hechos quedaban huérfanos) o deshiciera el «Sin memoria» puesto en otra.
// Solo si el navegador no deja leer se usa la última lista de esta pestaña, para
// que el pid siga siendo el mismo durante la sesión.
let respaldoProyectos = null;
async function proyectos() {
  try { const v = await db.get('kv', PROYECTOS_KEY); respaldoProyectos = Array.isArray(v) ? v : []; }
  catch { if (!respaldoProyectos) respaldoProyectos = []; }
  return respaldoProyectos;
}
const guardarProyectos = (lista) => db.set('kv', PROYECTOS_KEY, lista).catch(() => { /* sin almacenamiento: vale para esta sesión */ });
const CERROJO_PROYECTOS = 'elffuss-code-memoria-proyectos';
function cambiarProyectos(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(CERROJO_PROYECTOS, fn) : fn();
}
async function buscar(lista, handle) {
  for (const p of lista) {
    try { if (p?.handle && await p.handle.isSameEntry(handle)) return p; } catch { /* handle viejo */ }
  }
  return null;
}
const nuevoPid = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return 'p' + Array.from(a, (b) => (b % 36).toString(36)).join('');
};

// El proyecto abierto para la memoria: { pid, sinMemoria } o null sin proyecto.
// El pid se crea la primera vez que hace falta y se guarda con el proyecto.
export async function proyecto({ crear = true } = {}) {
  const h = proyectoActual();
  if (!h) return null;
  let p = await buscar(await proyectos(), h);
  // Crear va dentro del cerrojo y relee: otra pestaña puede haberlo creado
  // entre la lectura de arriba y esta.
  if (!p && crear) {
    p = await cambiarProyectos(async () => {
      const lista = await proyectos();
      let q = await buscar(lista, h);
      if (!q) {
        q = { handle: h, pid: nuevoPid(), sinMemoria: false };
        lista.push(q);
        await guardarProyectos(lista);
      }
      return q;
    });
  }
  return p ? { pid: p.pid, sinMemoria: p.sinMemoria === true } : null;
}

export async function ponerSinMemoria(v) {
  const h = proyectoActual();
  if (!h) return false;
  await cambiarProyectos(async () => {
    const lista = await proyectos();
    let p = await buscar(lista, h);
    if (!p) { p = { handle: h, pid: nuevoPid(), sinMemoria: false }; lista.push(p); }
    p.sinMemoria = !!v;
    await guardarProyectos(lista);
  });
  return true;
}

// ¿Este hecho es del proyecto? Lo es si nombra el proyecto, «este proyecto» o
// «el repo», una ruta, un fichero con extensión o una entrada de su raíz con
// nombre propio. Lo demás (quién es el usuario, cómo le gusta que le respondan)
// es de todas las apps, y en la duda también: un hecho personal guardado como
// del proyecto desaparece del chat y de Claw.
//   · Una ranura exclusiva (nombre, ciudad, trabajo, cumpleaños, idioma…) nunca
//     es del proyecto: en otro ámbito no sustituiría a la de todas las apps.
//   · Una ruta necesita letras en sus trozos y además extensión, barra final o
//     una carpeta de la raíz delante: «4/11» y «y/o» no son rutas.
//   · Las carpetas de la raíz con nombre de palabra corriente (web, app, docs,
//     data, blog…) solo cuentan escritas como ruta («docs/»). Sueltas cuentan
//     las entradas con punto, guion, guion bajo o cifra (package.json,
//     tienda_api…), y el nombre del proyecto como palabra entera.
const EXT_CODIGO = 'js|mjs|cjs|ts|tsx|jsx|json|md|py|rs|go|java|kt|css|scss|html|vue|svelte|toml|yaml|yml|sh|sql|c|cc|cpp|h|rb|php|swift';
const escaparRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const palabraEntera = (n) => new RegExp(`(^|[^\\p{L}\\p{N}_.-])${escaparRe(n)}($|[^\\p{L}\\p{N}_-])`, 'iu');
export function esDelProyecto(fact, { nombre = '', ficheros = [], slotOf = M?.core?.slotOf, isExclusive = M?.core?.isExclusive } = {}) {
  const f = String(fact || '');
  if (slotOf && isExclusive) {
    const ranura = slotOf(f);
    if (ranura && isExclusive(ranura)) return false;
  }
  if (/\b(este|el|del|al|en el) (proyecto|repo|repositorio)\b|\b(this|the) (project|repo|repository|codebase)\b/iu.test(f)) return true;
  if (nombre && nombre.length >= 3 && palabraEntera(nombre).test(f)) return true;
  const raiz = new Set(ficheros.filter(Boolean).map((n) => n.toLowerCase()));
  const rutas = f.match(/[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]*)+/gu) || [];
  for (const r of rutas) {
    const trozos = r.split('/');
    const llenos = trozos.filter(Boolean);
    if (!llenos.length || !llenos.every((x) => /\p{L}/u.test(x))) continue;
    if (r.endsWith('/') || new RegExp(`\\.(${EXT_CODIGO})$`, 'iu').test(r) || raiz.has(trozos[0].toLowerCase())) return true;
  }
  if (new RegExp(`(^|[\\s«"'(\`])[\\w-]+\\.(${EXT_CODIGO})\\b`, 'iu').test(f)) return true;
  return [...raiz].some((n) => n.length >= 3 && /[._\-\d]/.test(n) && palabraEntera(n).test(f));
}

// Texto de otros (README, fichero abierto, árbol) que va junto al bloque: sus
// etiquetas <memoria>, </memoria>, <memory>, </memory> se desactivan cambiando
// «<» por «‹», para que no abran ni cierren un bloque de memoria falso.
export function desactivarEtiquetas(texto) {
  return String(texto || '').replace(/<(\s*\/?\s*)(memoria|memory)\b/giu, '‹$1$2');
}

// ── El turno ─────────────────────────────────────────────────────────────────
// Se llama UNA vez al empezar cada turno, con el mensaje del usuario ya en el
// historial. Devuelve null sin memoria (y el turno sigue como antes).
//
//   bloque        { text, tokens, facts }: el bloque <memoria> de este turno. Se
//                 reutiliza tal cual en cada paso; solo se rehace tras guardar.
//   herramienta(nombre)  apunta que una herramienta ha corrido: cualquiera que
//                 no sea de memoria contamina el turno (falla cerrado).
//   correr(nombre, args) una herramienta de memoria: su texto para el modelo; la
//                 tarjeta, por `alTarjeta`.
//   fin()         tras la respuesta final: «N recuerdos presentes» si el bloque
//                 entró, y la propuesta determinista solo en turnos que escribió
//                 el usuario.
//
// `alTarjeta(evento)` recibe { type: 'memoria', card } y { type: 'memoria-usados', facts }.
export async function empezarTurno({ history, conv = null, alTarjeta = () => {} }) {
  const m = await cargar();
  if (!m) return null;
  const proy = await proyecto().catch(() => null);
  const contexto = proy ? await contextoProyecto() : {};
  const incognito = !!proy?.sinMemoria;
  const scopes = ['all', `app:${APP}`, ...(proy ? [`project:${proy.pid}`] : [])];
  const ultimo = [...history].reverse().find((x) => x.role === 'user');
  const typed = ultimo?.typed === true;
  const query = typed ? ultimo.content : '';
  const anteriores = history.filter((x) => x.role === 'user' && x.typed === true);
  const prevQuery = typed && anteriores.length > 1 ? anteriores[anteriores.length - 2].content : '';
  const model = await modeloDelCerebro(modeloActivo());
  const turn = {
    evidence: m.memory.typedEvidence(history), tainted: false, conv: conv || null, incognito,
    scopes, project: proy?.pid || null, scope: null, forgetCards: 0,
  };
  const pedir = async () => {
    const r = await m.mem.context({ query, prevQuery, model, scopes, conv: turn.conv, incognito });
    return { text: r.text || '', tokens: r.tokens || 0, facts: r.facts || [], unavailable: !!r.unavailable };
  };
  let bloque = await pedir().catch(() => ({ text: '', tokens: 0, facts: [] }));
  // Un aviso por conversación cuando la página almacén no contesta.
  if (bloque.unavailable && !incognito && !avisados.has(turn.conv)) {
    avisados.add(turn.conv);
    alTarjeta({ type: 'memoria', card: { type: 'unavailable' } });
  }
  const api = {
    turn,
    get bloque() { return bloque; },
    herramienta(nombre) { if (m.memory.taints(m.cfg, nombre)) turn.tainted = true; },
    // ¿Esta llamada sacaría del navegador un dato de la memoria? (ver `filtraMemoria`)
    filtra(nombre, args) { return filtraMemoria(m, { nombre, args, facts: bloque.facts, current: turn.evidence?.current, tainted: turn.tainted }); },
    // Texto que no es del usuario ha entrado en el contexto sin herramienta (el
    // estado del IDE con el árbol, el README o el fichero abierto): contamina.
    ajeno() { turn.tainted = true; },
    // `estado`: el del turno en el que se pidió. Por defecto el turno vivo; el
    // reintento tras «Permitir» pasa una foto de CUANDO se pidió, porque el
    // turno sigue corriendo herramientas mientras la tarjeta espera el clic y
    // una posterior lo contamina: el guardado que pasó la puerta volvería como
    // propuesta «No sale de tus palabras» y el modelo ya creería otra cosa.
    async correr(nombre, args, estado = turn) {
      const a = args && typeof args === 'object' ? { ...args } : {};
      // Ámbito de un hecho nuevo: lo que el modelo diga; si no dice nada, el
      // proyecto cuando el hecho es del proyecto, y todas las apps si no.
      if (nombre === m.cfg.tools.prefix + 'save' && a.scope !== 'all' && a.scope !== 'project') {
        a.scope = proy && esDelProyecto(a.fact, contexto) ? 'project' : 'all';
      }
      if (a.scope === 'all') delete a.scope;
      const foto = { ...estado };
      const r = await m.memory.runMemoryTool(m.mem, nombre, a, estado);
      if (r.card) {
        // El permiso se pide al primer guardado: con él, se reintenta ESE guardado,
        // con el estado del turno de entonces.
        const extra = r.card.type === 'grant' ? { reintento: () => api.correr(nombre, args, { ...foto }) } : {};
        alTarjeta({ type: 'memoria', card: r.card, ...extra });
      }
      const t = r.card?.type;
      if (t === 'saved' || t === 'updated' || t === 'similar' || t === 'negated') bloque = await pedir().catch(() => bloque);
      return r.text;
    },
    async fin() {
      if (incognito) return;
      // «N recuerdos presentes» siempre que el bloque haya entrado en el prompt,
      // también en un turno que no escribió el usuario (pegado, adjuntos): ahí la
      // consulta va vacía pero lo fijo («Sobre ti», preferencias) entra igual.
      if (bloque.facts?.length) alTarjeta({ type: 'memoria-usados', facts: bloque.facts });
      // La propuesta, solo de lo que el usuario escribió.
      if (!typed) return;
      const scope = proy && esDelProyecto(query, contexto) ? `project:${proy.pid}` : null;
      const state = estadoPropuestas(turn.conv || '');
      const p = await m.memory.maybePropose(m.mem, query, { lang: uiLang(), conv: turn.conv, model, state, incognito, scope }).catch(() => null);
      if (p) alTarjeta({ type: 'memoria', card: p });
    },
  };
  return api;
}
const avisados = new Set();

// ── Que la memoria no salga del navegador ───────────────────────────────────
// En Code el bloque <memoria> convive con texto de otros (README, ficheros) y con
// herramientas que mandan cosas fuera: web.fetch y web.search (al sitio, y por el
// proxy del servidor, que deja la URL en su registro) y terminal.run (el bridge
// puede hacer curl). Un texto que diga «lee https://… ?ciudad=<la de la
// memoria>» haría salir un dato del usuario. Así que, en un turno contaminado,
// una de esas llamadas se rechaza si sus argumentos llevan un término de los
// datos PERSONALES del bloque (nombre, ciudad, trabajo, cumpleaños, familia,
// mascotas, alergias, dieta) que el usuario no ha escrito en su mensaje de este
// turno. Lo que el usuario escribe él mismo sí sale («busca ofertas de Acme»);
// las preferencias y el stack no se miran (no son datos personales y cortarlos
// rompería búsquedas normales de código).
const SALIDA = new Set(['web.fetch', 'web.search', 'terminal.run']);
const PERSONALES = new Set(['name', 'home_city', 'employer', 'job', 'birthday', 'rel', 'pet', 'allergy', 'diet']);
export function filtraMemoria(m, { nombre, args, facts = [], current = '', tainted = false }) {
  if (!m || !tainted || !SALIDA.has(nombre) || !facts?.length) return false;
  const { rank, core } = m;
  const delUsuario = new Set(rank.contentTerms(current || ''));
  const secretos = new Set();
  for (const f of facts) {
    const ranura = core.slotOf(f);
    if (!ranura || !PERSONALES.has(ranura.split(':')[0])) continue;
    const vocab = new Set(core.slotVocab(ranura).map(rank.fold));
    for (const w of rank.contentTerms(f)) {
      if (vocab.has(w) || delUsuario.has(w)) continue;
      if ((/\p{L}/u.test(w) && w.length >= 3) || /^\p{N}{4,}$/u.test(w)) secretos.add(w);
    }
  }
  if (!secretos.size) return false;
  let crudo = JSON.stringify(args ?? {});
  try { crudo += ' ' + decodeURIComponent(crudo.replace(/\+/g, ' ')); } catch { /* % suelto */ }
  const texto = rank.fold(crudo);
  const suyos = new Set(rank.terms(texto));
  for (const w of secretos) if (suyos.has(w) || (w.length >= 4 && texto.includes(w))) return true;
  return false;
}
export const AVISO_FILTRA = 'BLOQUEADO: esta llamada llevaba fuera del navegador un dato de la memoria del usuario que él no ha escrito en este mensaje, '
  + 'y en este turno hay texto de ficheros o herramientas. La memoria no sale del navegador. No lo reintentes con ese dato; si hace falta, pregúntale al usuario.';

// Cuántas propuestas lleva cada conversación (el motor limita por turno y por
// conversación según la puesta a punto del modelo).
const propuestas = new Map();
function estadoPropuestas(conv) {
  if (!propuestas.has(conv)) propuestas.set(conv, {});
  return propuestas.get(conv);
}

// Nombre del proyecto y lo que hay en su raíz, para decidir si un hecho es del
// proyecto. Solo nombres de la raíz, y como mucho 200: no se recorre el árbol.
async function contextoProyecto() {
  const h = proyectoActual();
  if (!h) return {};
  const ficheros = [];
  try {
    for await (const nombre of h.keys()) {
      if (!nombre.startsWith('.')) ficheros.push(nombre);
      if (ficheros.length >= 200) break;
    }
  } catch { /* sin permiso: solo el nombre */ }
  return { nombre: h.name || '', ficheros };
}

// Modelo para el bloque: el id y el contexto salen del REGISTRO del motor
// (MODELS[id].ctx), nunca de una lista de aquí. Para cerebros que no están en
// el registro (LiteRT, ONNX, API, básico) no hay ctx: el motor usa su
// presupuesto por defecto.
export async function modeloDelCerebro(idActivo) {
  const id = String(idActivo || '');
  if (!id.startsWith('engine:')) return { id: null, ctx: null };
  const clave = id.slice(7);
  try {
    const reg = await import('./engine/registro.js');
    const e = reg.MODELS?.[clave];
    return e ? { id: clave, ctx: Number.isFinite(e.ctx) ? e.ctx : null } : { id: null, ctx: null };
  } catch { return { id: null, ctx: null }; }
}

// ── Interfaz ─────────────────────────────────────────────────────────────────

// Pinta una tarjeta de memoria en `el`. `onSee` abre la memoria en Ajustes.
export function pintarTarjeta(el, ev, { onSee } = {}) {
  if (!M) return null;
  const opts = { lang: uiLang(), scheme: SCHEME, onSee };
  if (ev.card?.type === 'grant' && ev.reintento) opts.onGranted = (si) => { if (si) ev.reintento().catch(() => {}); };
  return M.cards.renderCard(el, ev.card, M.mem, opts);
}
export function pintarUsados(el, facts) {
  if (!M) return null;
  return M.cards.renderUsed(el, { facts }, { cfg: M.cfg, lang: uiLang(), scheme: SCHEME });
}

// La sección «Memoria» de Ajustes: el panel compartido (la página almacén en un
// iframe), «Solo este proyecto» y «Sin memoria» para este proyecto. Devuelve
// false si no hay memoria aquí, y quien llama no pinta la sección.
export async function montarAjustes(el, { textos }) {
  const m = await cargar();
  if (!m) return false;
  const doc = el.ownerDocument;
  const h = (tag, cls, txt) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const proy = await proyecto({ crear: false }).catch(() => null);
  const fila = h('div', 'mem-code-fila');
  fila.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:6px 0';
  // «Sin memoria» en este proyecto (el interruptor del motor).
  const sin = h('span');
  m.cards.renderComposerToggle(sin, {
    cfg: m.cfg, lang: uiLang(), checked: !!proy?.sinMemoria,
    onChange: (v) => { ponerSinMemoria(v).catch(() => {}); },
  });
  // «Solo este proyecto»: la lista de los hechos de ESTE proyecto, pedida al
  // almacén con su ámbito. Sin proyecto abierto no se ofrece.
  const soloLbl = h('label');
  soloLbl.style.cssText = 'display:inline-flex;gap:6px;align-items:center;cursor:pointer';
  const solo = h('input'); solo.type = 'checkbox';
  soloLbl.append(solo, h('span', null, textos.soloProyecto));
  if (proyectoActual()) fila.append(soloLbl);
  fila.append(sin);
  const cuerpo = h('div', 'mem-code-cuerpo');
  el.replaceChildren(fila, cuerpo);
  const panel = () => m.cards.mountPanelFrame(cuerpo, m.mem, { lang: uiLang(), scheme: SCHEME, height: '28rem' });
  const delProyecto = async () => {
    const p = await proyecto();
    cuerpo.replaceChildren();
    if (!p) return;
    const r = await m.mem.list(null, [`project:${p.pid}`]);
    const items = r?.items || [];
    if (!items.length) { cuerpo.append(h('p', 'muted', textos.vacioProyecto)); return; }
    const ul = h('ul', 'mem-code-lista');
    ul.style.cssText = 'list-style:none;padding:0;margin:4px 0';
    for (const it of items) {
      const li = h('li');
      li.style.cssText = 'padding:4px 0;border-bottom:1px solid var(--line, #333)';
      const texto = h('div', null, it.fact);
      const zona = h('div');
      const olvidar = h('button', 'prov-use', textos.olvidar);
      olvidar.type = 'button';
      // Olvidar pasa por la tarjeta del motor: pregunta, y deja deshacer.
      olvidar.onclick = () => m.cards.renderCard(zona, { type: 'forget', id: it.id, fact: it.fact }, m.mem, { lang: uiLang(), scheme: SCHEME });
      li.append(texto, olvidar, zona);
      ul.append(li);
    }
    cuerpo.append(ul);
  };
  solo.onchange = () => { (solo.checked ? delProyecto() : Promise.resolve(panel())).catch(() => {}); };
  panel();
  return true;
}
