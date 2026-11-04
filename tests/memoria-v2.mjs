// La memoria compartida (v2) en Code, en el navegador y con los orígenes DE VERDAD.
//
//   node tests/memoria-v2.mjs            (CLAW=<checkout de Claw> opcional)
//
// Un servidor HTTPS local contesta como code.elffuss.com y claw.elffuss.com
// (memoria-v2-servidor.mjs), y el navegador del sistema se apunta a él con
// --host-resolver-rules. Así Code habla con la página almacén por su iframe
// como en producción: mismo sitio, la base de datos de la página almacén, las
// cabeceras que se despliegan. Sin modelo ni pesos: el cerebro es un proveedor
// guionado que se pone en la página.
//
// Lo que se comprueba:
//   · la memoria se conecta por el iframe oculto a la página almacén, y en otro
//     origen (code-copia.test) no hay memoria: ni iframe, ni herramientas, ni
//     sección en Ajustes;
//   · «recuerda que…» escrito en la caja: primero la tarjeta de permiso; con
//     «Permitir», como hay un proyecto abierto (texto de otros en el contexto),
//     una propuesta, y con «Sí» se guarda en la base de datos de la página
//     almacén, desde Code, confirmado por el usuario;
//   · lo que guarda otra app (Claw) entra en el bloque <memoria> del turno de Code;
//   · texto pegado y lo recuperado con ↑ de algo pegado no cuentan como escritos;
//   · tras code.tree, guardar es una propuesta «No sale de tus palabras»;
//   · olvidar: tarjeta, nada borrado hasta el clic; «Olvidar» y «Deshacer»;
//   · Ajustes: la sección «Memoria» con el panel (la página almacén en un iframe
//     visible), «Solo este proyecto» y «Sin memoria»;
//   · ningún texto de la memoria en ninguna URL pedida, y ningún pageerror.
import { chromium } from 'playwright';
import { arrancar } from './memoria-v2-servidor.mjs';
import { CHROME_ARGS } from './chrome-args.mjs';

const srv = await arrancar();
console.log(`   página almacén: ${srv.almacen}`);
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, { veces = 150, cada = 100 } = {}) {
  for (let i = 0; i < veces; i++) { try { if (await cond()) return true; } catch { /* aún no */ } await espera(cada); }
  return false;
}

const b = await chromium.launch({ channel: 'chrome', headless: true, args: [...srv.args, ...CHROME_ARGS] });
const ctx = await b.newContext({ locale: 'es-ES', viewport: { width: 1400, height: 900 } });
const errores = [];
const urls = [];
ctx.on('page', (p) => { p.on('pageerror', (e) => errores.push(`${p.url()}: ${e.message}`)); });
ctx.on('request', (r) => urls.push(r.url()));
await ctx.addInitScript(() => { try { localStorage.setItem('elffusscode.model', 'rules'); } catch { /* — */ } });
const CODE = 'https://code.elffuss.com';
const CLAW = 'https://claw.elffuss.com';

// Lee la memoria desde el origen de la página almacén (el gestor), sin tocar nada.
const gestor = await ctx.newPage();
await gestor.goto(CLAW + '/memory/');
const registros = () => gestor.evaluate(() => new Promise((ok) => {
  const r = indexedDB.open('elffuss-memory');
  r.onerror = () => ok(null);
  r.onsuccess = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains('records')) { d.close(); ok([]); return; }
    const q = d.transaction('records', 'readonly').objectStore('records').getAll();
    q.onsuccess = () => { d.close(); ok(q.result); };
    q.onerror = () => { d.close(); ok(null); };
  };
}));
ok('la página almacén abre en claw.elffuss.com/memory/', await hasta(async () => Array.isArray(await registros())));

// ── 1. Otro origen: sin memoria ─────────────────────────────────────────────
const copia = await ctx.newPage();
await copia.goto('https://code-copia.test/?test-opfs', { waitUntil: 'domcontentloaded' });
await hasta(() => copia.evaluate(() => !document.getElementById('ide')?.hidden));
await espera(1500);
ok('en otro origen: ningún iframe a la página almacén', await copia.evaluate(() => ![...document.querySelectorAll('iframe')].some((f) => f.src.startsWith('https://claw.elffuss.com/memory'))));
ok('en otro origen: el prompt no nombra la memoria', await copia.evaluate(async () => !/memory\.save|MEMORIA/.test((await import('/js/agent.js')).systemPrompt(''))));
await copia.evaluate(() => { location.hash = '#/settings'; });
await espera(800);
ok('en otro origen: Ajustes sin sección de memoria', await copia.evaluate(() => { const h = document.getElementById('set-memoria'); return !h || h.hidden; }));
await copia.close();

// ── 2. Code en su origen ───────────────────────────────────────────────────
const p = await ctx.newPage();
await p.goto(CODE + '/?test-opfs', { waitUntil: 'domcontentloaded' });
ok('Code abre el proyecto', await hasta(() => p.evaluate(() => !document.getElementById('ide')?.hidden)));
const listo = await p.evaluate(async () => { const w = await import('/js/memory-wire.js'); const m = await w.cargar(); return m ? (await m.mem.ready()).mode : 'sin memoria'; });
ok('la memoria se conecta a la página almacén por el iframe', listo === 'store', listo);
ok('…un iframe oculto a https://claw.elffuss.com/memory/', await p.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => f.src === 'https://claw.elffuss.com/memory/' && f.getAttribute('aria-hidden') === 'true')));
ok('el prompt de Code nombra las tres herramientas de memoria', await p.evaluate(async () => /memory\.save \/ memory\.list \/ memory\.forget/.test((await import('/js/agent.js')).systemPrompt(''))));

// El cerebro guionado, dentro de la página. Apunta cada llamada.
await p.evaluate(() => {
  window.__llamadas = [];
  const llamada = (tool, args) => '```tool\n' + JSON.stringify({ tool, args }) + '\n```';
  window.elffussClaw.conv.setProvider({
    chat: async (history, system) => {
      window.__llamadas.push({ history: history.map((x) => ({ role: x.role, content: x.content, typed: !!x.typed, efimero: !!x.efimero })), system });
      let i = history.length - 1, r = 0;
      while (i >= 0 && (history[i].role !== 'user' || history[i].efimero || history[i].content.startsWith('[resultado'))) { if (history[i].role === 'user' && history[i].content.startsWith('[resultado')) r++; i--; }
      const u = history[i]?.content || '';
      if (/^\[contamina\]/.test(u)) return r === 0 ? llamada('code.tree', {}) : r === 1 ? llamada('memory.save', { fact: 'Su editor favorito es helix' }) : 'Vale.';
      if (r > 0) return 'Hecho.';
      let m = /recuerda que prefiero (.+)/iu.exec(u);
      if (m) return llamada('memory.save', { fact: 'Prefiere ' + m[1].trim() });
      m = /recuerda que (.+)/iu.exec(u);
      if (m) return llamada('memory.save', { fact: m[1].trim() });
      if (/olvida lo de (.+)/iu.test(u)) return llamada('memory.forget', { query: /olvida lo de (.+)/iu.exec(u)[1] });
      return 'Vale.';
    },
  });
});
const enviar = async (texto) => {
  const antes = await p.evaluate(() => window.__llamadas.length);
  await p.fill('#prompt', texto);
  await p.press('#prompt', 'Enter');
  await hasta(() => p.evaluate((n) => window.__llamadas.length > n && !window.elffussClaw.conv.getActive().pumping, antes));
  await espera(300);
};
const tarjetas = () => p.evaluate(() => [...document.querySelectorAll('#chat-log .msg.mem')].map((d) => d.innerText));
const pulsar = async (texto) => { const bt = p.locator('#chat-log .msg.mem button', { hasText: texto }).last(); await bt.click(); };

// a) Primer guardado: permiso, y luego guardado
await enviar('recuerda que prefiero respuestas cortas');
ok('el primer guardado pide permiso para Code', await hasta(async () => (await tarjetas()).some((x) => /Dejo que Code use la memoria/.test(x))), (await tarjetas()).join(' | '));
ok('el mensaje de la caja va marcado como escrito', await p.evaluate(() => window.__llamadas.at(-1).history.filter((x) => x.role === 'user' && !x.efimero)[0]?.typed === true));
await pulsar('Permitir');
// Hay un proyecto abierto: su árbol y su README entran en cada turno, y eso es
// texto de otros que contamina el turno (falla cerrado). Lo que pide el usuario
// queda como propuesta que confirma con un clic.
ok('con «Permitir», y un proyecto abierto, queda como propuesta que pide el clic', await hasta(async () => (await tarjetas()).some((x) => /¿Lo recuerdo\?[\s\S]*Prefiere respuestas cortas/.test(x))), (await tarjetas()).join(' | '));
ok('…y no queda activo antes del clic', !(await registros()).some((r) => r.fact === 'Prefiere respuestas cortas'));
await pulsar('Sí');
ok('con «Sí» se guarda: tarjeta «Recordado»', await hasta(async () => (await tarjetas()).some((x) => /Recordado: «Prefiere respuestas cortas»/.test(x))), (await tarjetas()).join(' | '));
let recs = await registros();
const corta = recs.find((r) => r.fact === 'Prefiere respuestas cortas');
ok('…en la base de datos de la página almacén, desde Code, confirmado por el usuario', corta?.status === 'active' && corta?.source?.app === 'code' && corta?.source?.how === 'user-confirmed', JSON.stringify(corta?.source));
ok('…con el id de la conversación de Code', /^c[a-z0-9]+$/.test(corta?.source?.conv || ''));
ok('ninguna base de datos de memoria en el origen de Code (solo su bandeja de salida)', await p.evaluate(async () => (await indexedDB.databases()).every((d) => d.name !== 'elffuss-memory')));

// b) Lo que guarda Claw entra en el bloque de Code
await gestor.evaluate(async () => {
  const { default: cfg } = await import('/memory/memory.config.js');
  const { openStore } = await import('/js/engine/memory-store.js');
  const s = await openStore(cfg);
  await s.call('grant', { state: 'granted' }, { app: 'claw', direct: true });
  const ev = { current: 'recuerda que vivo en Valencia', typedTexts: ['recuerda que vivo en Valencia'] };
  await s.call('save', { fact: 'Vive en Valencia', evidence: ev, tainted: false, lang: 'es' }, { app: 'claw', direct: true });
});
await enviar('¿dónde vivo?');
const estado = await p.evaluate(() => window.__llamadas.at(-1).history.find((x) => x.efimero)?.content || '');
ok('lo guardado en Claw está en el bloque <memoria> del turno de Code', /<memoria>[\s\S]*Valencia[\s\S]*<\/memoria>/.test(estado), estado.slice(0, 240));
ok('…en el mensaje de estado, junto al estado del IDE', /Proyecto abierto:/.test(estado));
ok('…y no en el prompt de sistema', await p.evaluate(() => !/Valencia/.test(window.__llamadas.at(-1).system)));
ok('«Tenía presentes N recuerdos» bajo la respuesta', await hasta(async () => (await tarjetas()).some((x) => /Tenía presentes \d+ recuerdos/.test(x))));

// c) Pegado: no es escrito, ni recuperado con ↑
await p.focus('#prompt');
await p.evaluate(() => { const i = document.getElementById('prompt'); i.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: false })); i.value = 'recuerda que uso yarn'; i.dispatchEvent(new Event('input', { bubbles: true })); });
const antesPegado = await p.evaluate(() => window.__llamadas.length);
await p.press('#prompt', 'Enter');
await hasta(() => p.evaluate((n) => window.__llamadas.length > n && !window.elffussClaw.conv.getActive().pumping, antesPegado));
await espera(400);
ok('un mensaje pegado no va marcado como escrito', await p.evaluate(() => window.__llamadas.at(-1).history.filter((x) => x.role === 'user' && !x.efimero && !x.content.startsWith('[resultado')).at(-1)?.typed === false));
ok('…y no guarda nada', !(await registros()).some((r) => /yarn/.test(r.fact)));
await p.focus('#prompt');
await p.press('#prompt', 'ArrowUp');
const antesFlecha = await p.evaluate(() => window.__llamadas.length);
await p.press('#prompt', 'Enter');
await hasta(() => p.evaluate((n) => window.__llamadas.length > n && !window.elffussClaw.conv.getActive().pumping, antesFlecha));
await espera(400);
ok('lo pegado recuperado con ↑ sigue sin ser escrito', await p.evaluate(() => window.__llamadas.at(-1).history.filter((x) => x.role === 'user' && !x.efimero && !x.content.startsWith('[resultado')).at(-1)?.typed === false));
ok('…y tampoco guarda', !(await registros()).some((r) => /yarn/.test(r.fact)));

// d) Turno contaminado
await enviar('[contamina] recuerda que mi editor favorito es helix');
ok('tras code.tree, guardar es una propuesta «No sale de tus palabras»', await hasta(async () => (await tarjetas()).some((x) => /¿Lo recuerdo\?[\s\S]*helix[\s\S]*No sale de tus palabras/.test(x))), (await tarjetas()).slice(-2).join(' | '));
ok('…y no queda activo', !(await registros()).some((r) => /helix/.test(r.fact)));

// e) Olvidar
await enviar('olvida lo de las respuestas cortas');
ok('olvidar: tarjeta que pregunta', await hasta(async () => (await tarjetas()).some((x) => /¿Olvido «Prefiere respuestas cortas»\?/.test(x))));
ok('…y nada borrado antes del clic', (await registros()).some((r) => r.fact === 'Prefiere respuestas cortas' && r.status === 'active'));
await pulsar('Olvidar');
ok('con el clic se olvida (sale de los recuerdos)', await hasta(async () => !(await registros()).some((r) => r.fact === 'Prefiere respuestas cortas')));
ok('…y se puede deshacer', await hasta(async () => (await tarjetas()).some((x) => /Olvidado/.test(x))));
await pulsar('Deshacer');
ok('«Deshacer» lo devuelve', await hasta(async () => (await registros()).some((r) => r.fact === 'Prefiere respuestas cortas' && r.status === 'active')));

// f) Hecho del proyecto
await enviar('recuerda que en este proyecto los tests van con vitest');
await hasta(async () => (await tarjetas()).some((x) => /¿Lo recuerdo\?[\s\S]*vitest/.test(x)));
await pulsar('Sí');
await hasta(async () => (await registros()).some((r) => /vitest/.test(r.fact)));
recs = await registros();
const vit = recs.find((r) => /vitest/.test(r.fact));
ok('un hecho de «este proyecto» va al ámbito del proyecto', /^project:p[a-z0-9]{12}$/.test(vit?.scope || ''), vit?.scope);

// g) Ajustes
await p.evaluate(() => { location.hash = '#/settings'; });
ok('Ajustes: sección «Memoria»', await hasta(() => p.evaluate(() => { const h = document.getElementById('set-memoria'); return h && !h.hidden && /Memoria/.test(h.textContent); })));
const marco = await p.evaluate(() => [...document.querySelectorAll('#settings-panel iframe, iframe.mem-panel-frame')].map((f) => f.src).find((s) => s.includes('view=panel')) || '');
ok('…con el panel compartido (la página almacén en un iframe visible)', marco === 'https://claw.elffuss.com/memory/?view=panel&lang=es&scheme=dark', marco);
const panel = () => p.frames().find((f) => f.url().startsWith('https://claw.elffuss.com/memory/?view=panel'));
ok('…que enseña lo recordado', await hasta(async () => /Valencia/.test(await panel()?.evaluate(() => document.body.innerText))));
ok('«Sin memoria» para este proyecto', await p.evaluate(() => /Sin memoria/.test(document.getElementById('set-memoria')?.nextElementSibling?.innerText || '')));
await p.locator('label', { hasText: 'Solo este proyecto' }).click();
ok('«Solo este proyecto» lista solo lo de este proyecto', await hasta(() => p.evaluate(() => {
  const t = document.getElementById('set-memoria')?.nextElementSibling?.innerText || '';
  return /vitest/.test(t) && !/Valencia/.test(t);
})));

// ── 3. Privacidad y errores ────────────────────────────────────────────────
const secretos = ['respuestas cortas', 'Valencia', 'helix', 'vitest', 'yarn', 'respuestas%20cortas'];
const fugas = urls.filter((u) => secretos.some((s) => decodeURIComponent(u).includes(s)));
ok('ningún texto de la memoria en ninguna URL pedida', !fugas.length, fugas.slice(0, 3).join(' '));
const aClaw = urls.filter((u) => u.startsWith(CLAW + '/')).map((u) => new URL(u).pathname);
ok('a claw.elffuss.com solo se le pide la página almacén y el motor (GET, sin datos)', aClaw.every((x) => x.startsWith('/memory/') || x.startsWith('/js/engine/')) &&
  srv.peticiones.filter((x) => x.host === 'claw.elffuss.com').every((x) => x.method === 'GET' && (x.query === '' || /^\?view=panel&lang=[a-z]{2}&scheme=(light|dark)$/.test(x.query))),
  aClaw.filter((x) => !x.startsWith('/memory/') && !x.startsWith('/js/engine/')).slice(0, 3).join(' '));
ok('ningún pageerror', !errores.length, errores.slice(0, 3).join(' | '));

await b.close();
await srv.cerrar();
console.log(fallos ? `\n❌ ${fallos} fallos` : '\n✅ todo bien');
process.exit(fallos ? 1 : 0);
