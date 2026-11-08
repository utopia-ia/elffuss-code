// Registro de herramientas de Elffuss Code: proyecto abierto + shell + web.
import * as code from './code.js';
import * as shell from '../shell.js';
import * as web from './web.js';
import * as github from './github.js';
import * as theme from './theme.js';
import * as skills from '../skills.js';
import { anunciar, tocaFichero } from '../actividad.js';
import { entradas as memoryEntradas } from './memory.js';
import { alRegistrarHerramientas, hoy } from '../memory-wire.js';
import { mediaToolEntries, MEDIA_ALIASES, isMediaTool } from './media.js';
import { uiLang } from '../i18n.js';

export { code };

// El terminal (UI) se engancha aquí para reflejar lo que ejecuta la elfa.
let onTerminalEcho = () => {};
export function setTerminalEcho(fn) { onTerminalEcho = fn; }

export const TOOLS = {
  'code.tree':   { desc: 'Ver el árbol de archivos del proyecto', params: { path: 'subcarpeta (opcional)', depth: 'niveles (3)' }, run: a => code.tree(a) },
  'code.read':   { desc: 'Leer un archivo del proyecto. Sin más parámetros, lo lee ENTERO. Para ficheros grandes, pagina de 100 en 100 líneas con offset (offset:101 = siguiente página tras la primera). Para ir directo a donde dio un resultado de code.search (que ya incluye número de línea), usa around:N — trae ~100 líneas centradas en la línea N, con cada línea numerada (N→contenido) para poder citarla o editarla con precisión', params: { path: 'ruta relativa', offset: 'línea 1-based donde empezar (opcional)', limit: 'líneas a devolver, 100 por defecto (opcional)', around: 'centra la página en esta línea, p.ej. la que dio code.search (opcional)' }, run: a => code.read(a) },
  'code.write':  { desc: 'Escribir/crear un archivo (contenido COMPLETO; se refleja al instante en el editor). Para cambios PEQUEÑOS en un fichero YA existente, usa mejor code.edit', params: { path: 'ruta', content: 'contenido íntegro' }, run: a => code.write(a) },
  'code.edit':   { desc: 'Editar PARTE de un fichero existente sin reescribirlo entero: sustituye "search" (copia literal de unas pocas líneas, con contexto suficiente para ser única en el fichero) por "replace". Preferible a code.write para cambios pequeños/medianos — más rápido y sin riesgo de perder el resto del fichero. Si falla (no encuentra el punto con confianza), relee el fichero y reintenta con un search más ajustado', params: { path: 'ruta', search: 'texto exacto a sustituir', replace: 'texto nuevo' }, run: a => code.edit(a) },
  'code.run':    { desc: 'EJECUTAR una expresión contra un módulo JS del proyecto y ver qué devuelve de verdad. Úsalo SIEMPRE después de arreglar algo, para comprobar que el arreglo funciona antes de darlo por bueno: code.run con path del fichero y expr como "max([])" — las funciones exportadas se llaman por su nombre a secas, sin import ni require (también valen como m.max). Corre aislado y con límite de tiempo', params: { path: 'ruta del .js', expr: 'expresión a evaluar, p.ej. m.suma(2,3)' }, run: a => code.run(a) },
  'code.search': { desc: 'Buscar texto en el proyecto (grep)', params: { query: 'texto', ext: 'filtro extensión (opcional)' }, run: a => code.search(a) },
  'terminal.run': { desc: 'Ejecutar un comando de shell sobre los ficheros del proyecto (ls, cat, grep, find, mkdir, echo>fichero, git status…). node/npm/python REALES si el usuario tiene un Bridge local conectado (⚙ Ajustes → 🔌 Bridge local); si no está conectado, el propio resultado lo indica', params: { command: 'la línea de comando' }, run: async (a, ctx = {}) => { const out = await shell.runForAgent(a.command || '', { signal: ctx.signal }); onTerminalEcho(a.command || '', out); return out; } },
  'web.search': { desc: 'Buscar en internet (docs, errores, APIs; site:dominio en la búsqueda la limita a una web; no pongas años que el usuario no dijo) — devuelve títulos, URLs, fragmentos y lo que dicen las primeras páginas', params: { query: 'qué buscar' }, run: (a, ctx) => web.search(a, ctx) },
  'web.fetch':  { desc: 'Leer una URL (documentación, referencia): devuelve sus partes que responden a la pregunta', params: { url: 'https://…' }, run: (a, ctx) => web.fetchUrl(a, ctx) },
  // Imagen, música, voz y vídeo, hechos en este navegador con el SDK de elffuss-ai (tools/media.js); con `path`, el
  // fichero se guarda además en el proyecto. La descripción es la del chat de elffuss.com: el prompt va en inglés.
  ...mediaToolEntries(uiLang() === 'es' ? 'es' : 'en'),
  'elffuss.theme_get':   { desc: 'Ver el tema de «tu versión» del chat de elffuss.com (colores, redondeo, densidad, fuente, textos) y qué valores admite', params: {}, run: () => theme.get() },
  'elffuss.theme_set':   { desc: 'Guardar el tema de «tu versión» del chat de elffuss.com: JSON con colors {wall, surface, board, steel, ink, graphite, on-ink, tape, accent, selection: #rrggbb}, radius, density, font, texts. Lo valida; si falla dice por qué', params: { theme: 'el JSON del tema completo' }, run: a => theme.set(a) },
  'elffuss.theme_reset': { desc: 'Quitar el tema: elffuss.com vuelve al aspecto oficial', params: {}, run: () => theme.reset() },
  'github.connect': { desc: 'Conectar la cuenta de GitHub del usuario (abre la ventana de inicio de sesión de GitHub)', params: {}, run: () => github.connect() },
  'github.fork':    { desc: 'Preparar el fork del chat de Elffuss en el GitHub del usuario (lo crea o lo pone al día)', params: {}, run: () => github.fork() },
  'github.read':    { desc: 'Leer un fichero (o listar una carpeta) del fork del chat', params: { path: 'ruta, p. ej. chat/chat.css' }, run: a => github.read(a) },
  'github.write':   { desc: 'Escribir un fichero ENTERO en el fork del chat (un commit)', params: { path: 'ruta', content: 'contenido completo del fichero', message: 'qué cambia, en una línea' }, run: a => github.write(a) },
  'github.publish': { desc: 'Publicar el fork en GitHub Pages y esperar a que esté en línea; devuelve su dirección', params: {}, run: () => github.pages() },
  'github.pr':      { desc: 'Proponer el cambio a la versión oficial de Elffuss (abre una pull request)', params: { title: 'título corto', body: 'qué se pidió y qué se ha cambiado' }, run: a => github.pr(a) },
  'skill.create':   { desc: 'CREAR una skill propia: instrucciones especializadas que seguirás siempre', params: { name: 'nombre corto', description: 'para qué sirve', instructions: 'instrucciones detalladas en markdown' }, run: a => skills.createSkill(a) },
  'skill.list':     { desc: 'Ver las skills instaladas', params: {}, run: async () => skills.installed().map(x => `• ${x.name}: ${x.description || ''}`).join('\n') || 'No hay skills instaladas' },
  'skill.get':      { desc: 'Leer el contenido completo de una skill instalada', params: { name: 'nombre de la skill' }, run: async a => { const s = await skills.get(a.name); return s ? `# ${s.name}\n${s.description || ''}\n\n${s.content || ''}` : `No hay ninguna skill «${a.name}»`; } },
};

// Memoria compartida: memory-wire.js registra aquí las tres herramientas del
// motor cuando la memoria carga (solo en el origen de Code). Sin memoria no
// están, y el catálogo y el prompt quedan exactamente como antes.
alRegistrarHerramientas(defs => {
  for (const k of Object.keys(TOOLS)) if (TOOLS[k].memoria) delete TOOLS[k];
  Object.assign(TOOLS, memoryEntradas(defs));
});

// Cómo llega el valor de un <param> cuando el modelo usa etiquetas.
// ─────────────────────────────────────────────────────────────────────────────
// Por defecto se RECORTA, porque el modelo escribe el valor en su propia línea
// («<param name="path">\n  src/a.js\n</param>») y ese espacio es formato suyo,
// no parte de la ruta. Pero hay dos excepciones, y una se nos escapó en
// producción desde b7d7db0:
//
//   · EXACTO: el valor ES el fichero, o el texto que tiene que casar con él
//     byte a byte. Recortarlo deja la primera línea sin sangría y el fichero sin
//     salto final. En `code.edit` es peor que cosmético: `search` se compara con
//     el contenido real, así que un trim hace que no case y la edición falla EN
//     SILENCIO.
//   · NÚMERO: el valor es una cuenta de líneas; el resto del código la usa como
//     número y no como la cadena "100".
//
// Lo que NO está aquí se recorta, y nada se pasa por `JSON.parse`: un fichero
// .json es texto, no un objeto, y un valor entrecomillado conserva sus comillas.
// `tests/funciontags.mjs` comprueba que cada nombre de aquí es un parámetro de
// verdad, para que renombrar uno no deje la excepción apuntando al aire.
export const PARAM_EXACTO = {
  'code.write': ['content'],
  'github.write': ['content'],
  'elffuss.theme_set': ['theme'],
  'skill.create': ['instructions'],
  'code.edit': ['search', 'replace'],
};
export const PARAM_NUMERO = {
  'code.tree': ['depth'],
  'code.read': ['offset', 'limit', 'around'],
};

// `medios`: las herramientas de imagen, audio y vídeo entran en el catálogo solo en los turnos que las necesitan
// (tools/media-intent.js). Sin ellas el catálogo es el de antes, byte a byte.
export function toolHelp({ medios = false } = {}) {
  return Object.entries(TOOLS).filter(([n]) => medios || !isMediaTool(n)).map(([n, t]) =>
    `- ${n}(${Object.keys(t.params).join(', ')}): ${t.desc}`).join('\n');
}

// `ctx` lo pone el agente: hoy, la señal de parada de su turno ({ signal }), que
// terminal.run pasa al bridge para matar el comando si se para el agente.
export async function runTool(name, args, ctx = {}) {
  // Otros nombres que un modelo usa para las herramientas de medios (generate_image, tts…).
  if (!TOOLS[name] && Object.hasOwn(MEDIA_ALIASES, name)) name = MEDIA_ALIASES[name];
  // Buscar dentro de una web no es una herramienta aparte: web.search con site: (tools/web.js lo monta con la url).
  if (!TOOLS[name] && /^(web\.site|web\.site_search|web\.search_site|site_search|search_site|web_site)$/.test(name)) name = 'web.search';
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Herramienta desconocida: ${name}`);
  // Se anuncia para que la vista de ciudad y su pila lo vean en directo. Si la
  // herramienta falla, se anuncia el fallo y el error sigue su camino normal.
  const quien = tocaFichero(name, args);
  anunciar({ fase: 'inicio', herramienta: name, args: args || {}, ...(quien || {}) });
  try {
    const v = await tool.run(args || {}, ctx || {});
    anunciar({ fase: 'fin', herramienta: name, ok: true, resumen: resumenDe(v), ...(quien || {}) });
    return v;
  } catch (e) {
    anunciar({ fase: 'fin', herramienta: name, ok: false, resumen: String(e?.message || e).slice(0, 160), ...(quien || {}) });
    throw e;
  }
}

// Una línea para el registro. El resultado completo va al modelo; aquí solo
// se enseña para que se vea qué pasó.
const resumenDe = v => {
  const t = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  const linea = (t || '').split('\n').find(l => l.trim()) || '';
  return linea.slice(0, 160);
};

// La hora, TRUNCADA A LA HORA EN PUNTO, y el motivo no es estético.
// ─────────────────────────────────────────────────────────────────────────────
// Esto era `new Date().toLocaleString()`, que incluye SEGUNDOS, y va en la
// primera línea del contexto — o sea en la cabeza del prompt de sistema. El
// motor reutiliza el prefijo solo si los tokens del turno EMPIEZAN EXACTAMENTE
// por los que ya ingirió, así que un reloj con segundos hacía diverger el
// prefijo en el token ~5 de CADA turno: la caché de prefijo existía, estaba
// encendida, estaba medida —sin ella la espera hasta la primera letra crece
// ×3,2 del turno 1 al 6; con ella se queda plana— y no saltaba NUNCA en
// producción porque este prompt la invalidaba sola.
//
// Truncar a la hora la deja estable durante toda una sesión normal; cruzar una
// hora cuesta UN re-prefill, no uno por turno. La fecha se conserva entera
// porque el modelo la usa; los segundos no los usaba nadie —«ayer» se resuelve
// con el `ts` del turno en que se dijo (ver annotateDates en acer-core.js), no
// con este reloj—.
//
// La fecha va con el texto del motor (memory-wire.js `hoy`: «Hoy es 2026-11-04,
// miércoles.»), igual en todas las apps y en la forma de las fechas del bloque
// <memoria>; antes era «4/11/26», sin día de la semana.
const horaEstable = () => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return `${hoy('es', d.getTime())} Hora: ${String(d.getHours()).padStart(2, '0')}:00.`;
};

// CONTEXTO AHORA del IDE: proyecto, archivo abierto y árbol resumido.
export async function snapshot() { return (await snapshotDetalle()).text; }

// Lo mismo, diciendo además si lleva texto del PROYECTO (árbol, README, fichero
// abierto): `ajeno`. Ese texto es de otros —un repo clonado, un fichero bajado—
// y entra en el contexto en cada paso sin que el modelo lo pida, igual que el
// resultado de code.tree o code.read. Para la memoria cuenta como tal: contamina
// el turno (memory-wire.js).
export async function snapshotDetalle() {
  const { projectName, currentFile } = code.current();
  let ajeno = false;
  const parts = [
    horaEstable(),
    'Proyecto abierto: ' + (projectName || 'ninguno'),
    'Archivo abierto en el editor: ' + (currentFile || 'ninguno'),
  ];
  try { parts.push('Árbol del proyecto (resumen):\n' + await code.tree({ depth: 2 })); ajeno = true; }
  catch { /* aún sin proyecto */ }
  // GROUNDING: incluye el contenido REAL de los archivos clave (README, config)
  // para que el modelo NO alucine sobre el proyecto — el heal no domina las
  // herramientas code.* así que le damos el material masticado.
  for (const key of ['README.md', 'readme.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
    try { const body = await code.read({ path: key }); parts.push(`Contenido REAL de ${key}:\n${body.slice(0, 1400)}`); ajeno = true; break; } catch { /* siguiente */ }
  }
  if (currentFile) {
    try {
      const body = await code.read({ path: currentFile });
      parts.push(`Contenido REAL del archivo abierto ${currentFile}:\n` + body.slice(0, 2000));
      ajeno = true;
    } catch { /* borrado */ }
  }
  return { text: parts.join('\n'), ajeno };
}
