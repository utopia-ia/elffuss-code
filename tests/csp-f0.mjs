// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Code under its production security headers (Elffuss Link F0, deploy/headers.json): the main flows run with the
// strict policy ENFORCED and Trusted Types report-only, with the production origins (tests/csp-f0-servidor.mjs), and
// the test counts every policy violation and every host the browser asked for.
//
//   node tests/csp-f0.mjs            phase 2 (enforced)          CSP_PHASE=1 node tests/csp-f0.mjs   phase 1
//
// Needs web/vendor/third-party/ (node third-party.mjs --ensure), the media SDK runtimes (node ai-sync.mjs), the
// engine in web/js/engine/ and a Claw checkout for the memory store and the model store ($ELFFUSS_CLAW_REPO).
// No GPU and no weights: the model is a scripted one; every host but the four of the server fails to resolve.
//
// Flows: load a project; Monaco (vendored) with its workers; a chat turn that runs code (code.run in
// tools/eval-worker.js, a worker with its own policy) and one whose edit would break the syntax (the guard parses in
// that worker and refuses); the HTML preview (an inline script in /sandbox/run.html, opaque origin); the terminal
// (xterm, vendored); the 3D city (three.js) and the architecture graph (3d-force-graph), vendored; attaching a PDF;
// a voice note from a fake microphone; the shared memory store (claw.elffuss.com/memory/ framed); Settings with the
// local bridge (its downloads' sums, and a request to 127.0.0.1); the vendored libraries (LiteRT-LM and its
// WebAssembly, Transformers.js + ONNX Runtime, Oniguruma's WebAssembly); the lab page; other sites refused by
// frame-ancestors; the sandbox page opaque on its own. An ENFORCED violation anywhere is a failure; Trusted Types
// reports are listed (the work left before enforcing them).
import { chromium } from 'playwright';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arrancar } from './csp-f0-servidor.mjs';
import { CHROME_ARGS } from './chrome-args.mjs';

const PHASE = Number(process.env.CSP_PHASE || 2);
const srv = await arrancar({ phase: PHASE });
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, { veces = 150, cada = 100 } = {}) {
  for (let i = 0; i < veces; i++) { try { if (await cond()) return true; } catch { /* aún no */ } await espera(cada); }
  return false;
}
const CODE = 'https://code.elffuss.com';
const CDN = /(^|\.)(jsdelivr\.net|unpkg\.com|esm\.sh|cdnjs\.cloudflare\.com|googleapis\.com|gstatic\.com|sheetjs\.com|skypack\.dev|jspm\.io)$/;

// A stand-in for the local bridge's /ping on a free port of 127.0.0.1 (connect-src allows http://127.0.0.1:*).
const puente = http.createServer((req, res) => res.writeHead(200, { 'Access-Control-Allow-Origin': CODE, 'Content-Type': 'application/json' }).end('{"ok":true}'));
await new Promise((r) => puente.listen(0, '127.0.0.1', r));

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  args: [...srv.args.map((a) => a.startsWith('--host-resolver-rules=') ? a.replace(', MAP * ~NOTFOUND', ', EXCLUDE 127.0.0.1, MAP * ~NOTFOUND') : a),
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...CHROME_ARGS],
});
const ctx = await b.newContext({ locale: 'es-ES', viewport: { width: 1400, height: 900 }, permissions: ['microphone'] });
const violaciones = [], consola = [], errores = [];
const pedidos = new Map();
ctx.on('request', (r) => { try { const h = new URL(r.url()).host; if (h) pedidos.set(h, (pedidos.get(h) || 0) + 1); } catch { /* — */ } });
await ctx.addInitScript(() => {
  addEventListener('securitypolicyviolation', (e) => {
    console.log('CSPV ' + JSON.stringify({ disp: e.disposition, dir: e.effectiveDirective, blocked: String(e.blockedURI || '').slice(0, 140),
      doc: String(e.documentURI || '').slice(0, 100), src: String(e.sourceFile || '').slice(0, 120) + ':' + e.lineNumber, sample: String(e.sample || '').slice(0, 60) }));
  }, true);
});
const vigila = (p) => {
  p.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('CSPV ')) { try { violaciones.push(JSON.parse(t.slice(5))); } catch { /* — */ } return; }
    if (m.type() === 'error' || /Content Security Policy|Trusted Type|Refused to/i.test(t)) consola.push(`${p.url().slice(0, 60)} ${m.type()}: ${t.slice(0, 220)}`);
  });
  p.on('pageerror', (e) => errores.push(`${p.url().slice(0, 60)}: ${e.message.slice(0, 200)}`));
  p.on('worker', (w) => w.on('console', (m) => { if (/Content Security Policy|Refused to|Trusted Type|EvalError/i.test(m.text())) consola.push(`worker ${w.url().slice(0, 80)}: ${m.text().slice(0, 200)}`); }));
};
ctx.on('page', vigila);
await ctx.addInitScript(() => {
  try {
    if (location.hostname !== 'code.elffuss.com') return;
    localStorage.setItem('elffusscode.model', 'ext:ollama');
    localStorage.setItem('elffusscode.providers', JSON.stringify({ ollama: { enabled: true, baseURL: 'https://code.elffuss.com/fake-llm/v1', model: 'guion', apiKey: 'x' } }));
  } catch { /* — */ }
});

// ── 1. Un proyecto y la carga ───────────────────────────────────────────────
const p = await ctx.newPage();
await p.goto(CODE + '/manifest.json');
await p.evaluate(async () => {
  const o = await navigator.storage.getDirectory();
  const w = async (path, txt) => { const parts = path.split('/'); const name = parts.pop(); let d = o; for (const x of parts) d = await d.getDirectoryHandle(x, { create: true });
    const f = await d.getFileHandle(name, { create: true }); const s = await f.createWritable(); await s.write(txt); await s.close(); };
  await w('README.md', '# demo');
  await w('src/util.js', 'export function suma(a, b) {\n  return a + b;\n}\n');
  await w('src/main.js', "import { suma } from './util.js';\nexport const total = suma(1, 2);\n");
  await w('page.html', '<!doctype html><html><head><style>h1{color:teal}</style></head><body><h1 id="marca">sin script</h1>' +
    '<script>document.getElementById("marca").textContent = "script en línea " + (6 * 7);</script></body></html>');
});
const resp = await p.goto(CODE + '/?test-opfs', { waitUntil: 'domcontentloaded' });
const h = resp.headers();
ok(`fase ${PHASE}: la página llega con la política ${PHASE === 2 ? 'aplicada' : 'en informe (aplicados solo frame-ancestors, object-src y base-uri)'}`,
  PHASE === 2 ? /script-src 'self' 'wasm-unsafe-eval' 'sha256-/.test(h['content-security-policy'] || '')
    : h['content-security-policy'] === "object-src 'none'; base-uri 'none'; frame-ancestors 'none'" && /script-src/.test(h['content-security-policy-report-only'] || ''), h['content-security-policy']);
ok('COOP same-origin-allow-popups (nunca same-origin), HSTS, nosniff, sin referrer',
  h['cross-origin-opener-policy'] === 'same-origin-allow-popups' && /max-age=/.test(h['strict-transport-security'] || '') && h['x-content-type-options'] === 'nosniff' && h['referrer-policy'] === 'no-referrer');
ok('Code abre el proyecto', await hasta(() => p.evaluate(() => !!window.elffussClaw?.conv?.getActive?.()), { veces: 200 }));
ok('Monaco (vendorizado) arranca', await hasta(() => p.evaluate(() => !!window.monaco && !!document.querySelector('#editor .monaco-editor')), { veces: 200 }));
await p.evaluate(() => window.elffussClaw.openFile('src/util.js'));
ok('…abre un fichero con resaltado', await hasta(() => p.evaluate(() => document.querySelectorAll('#editor .view-line span span').length > 2), { veces: 100 }));
ok('…y sus workers arrancan de este origen (no de blob:)', await hasta(() => p.evaluate(() => performance.getEntriesByType('resource').some((e) => /monaco-editor@0\.52\.2\/min\/vs\/base\/worker\/workerMain\.js/.test(e.name))), { veces: 100 }));

// ── 2. Un turno que ejecuta código y otro que rompería la sintaxis ──────────
async function turno(texto) {
  const antes = srv.llm.length;
  await p.fill('#prompt', texto);
  await p.press('#prompt', 'Enter');
  await hasta(() => srv.llm.length >= antes + 2, { veces: 200 });
  return srv.llm.slice(antes);
}
let pet = await turno('ejecuta suma');
const resultado = JSON.stringify(pet.at(-1)?.messages?.slice(-2) || []);
ok('code.run corre en tools/eval-worker.js (política propia): suma(2, 3) → 5', /suma\(2, 3\) → 5/.test(resultado), resultado.slice(0, 200));
await hasta(() => p.evaluate(() => !document.getElementById('btn-send')?.classList.contains('is-stop')), { veces: 100 });
pet = await turno('rompe util');
const rechazo = JSON.stringify(pet.at(-1)?.messages?.slice(-2) || []);
ok('la guarda de sintaxis parsea en el worker y rechaza la edición que rompe el fichero', /sin poder cargarse/.test(rechazo), rechazo.slice(0, 220));
const util = await p.evaluate(async () => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('src')).getFileHandle('util.js')).getFile()).text());
ok('…y el fichero sigue intacto', /return a \+ b;\n\}/.test(util));
await hasta(() => p.evaluate(() => !document.getElementById('btn-send')?.classList.contains('is-stop')), { veces: 100 });

// ── 3. Vista previa HTML (script en línea, en /sandbox/run.html) ────────────
await p.locator('#tree .file', { hasText: 'page.html' }).first().click({ button: 'right' });
await p.click('#tree-menu .tm-item:has-text("Vista previa")').catch(() => {});
ok('vista previa: el script EN LÍNEA de la página corre', await hasta(async () => {
  const f = p.frames().find((x) => x.url().startsWith(CODE + '/sandbox/run.html'));
  return f && (await f.evaluate(() => document.getElementById('marca')?.textContent)) === 'script en línea 42';
}, { veces: 100 }));
const opaco = await p.frames().find((x) => x.url().startsWith(CODE + '/sandbox/run.html'))?.evaluate(() => window.origin);
ok('…con origen opaco (no toca el proyecto ni el almacenamiento de Code)', opaco === 'null', opaco);

// ── 4. Terminal (xterm vendorizado, envuelto como módulo) ───────────────────
await p.click('#act-term');
ok('el terminal arranca (xterm de este origen)', await hasta(() => p.evaluate(() => !!document.querySelector('#terminal-host .xterm')), { veces: 100 }));
ok('…con su hoja de estilos de este origen', await p.evaluate(() => /\/vendor\/third-party\/@xterm\/xterm@5\.5\.0\/css\/xterm\.css$/.test(document.getElementById('xterm-css')?.href || '')));

// ── 5. Ciudad 3D y grafo de arquitectura ────────────────────────────────────
await p.click('#act-city');
ok('la ciudad 3D (three.js por el import map) pinta', await hasta(() => p.evaluate(() => !!document.getElementById('city-canvas')), { veces: 100 }));
await p.click('#act-arch');
ok('el grafo de arquitectura (3d-force-graph, con integridad) pinta', await hasta(() => p.evaluate(() => typeof window.ForceGraph3D === 'function' && !!document.querySelector('#arch-graph canvas')), { veces: 150 }));
await p.click('#act-files');

// ── 6. Adjuntar un PDF y una nota de voz ────────────────────────────────────
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj ' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (hola csp) Tj ET\nendstream endobj ' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const input = await p.$('input.att-input[accept*="pdf"], input.att-input');
if (input) {
  await input.setInputFiles({ name: 'prueba.pdf', mimeType: 'application/pdf', buffer: pdf });
  ok('adjuntar un PDF: se lee en el navegador (PDF.js de la copia del SDK)', await hasta(() => p.evaluate(() =>
    [...document.querySelectorAll('.att-chip-state')].some((s) => !/leyendo|reading/i.test(s.textContent || ''))), { veces: 150 }));
} else ok('adjuntar: hay un campo de fichero', false);
if (await p.evaluate(() => !!document.getElementById('mic-btn'))) {
  await p.evaluate(() => document.getElementById('mic-btn').click());
  ok('nota de voz: graba (microphone=(self))', await hasta(() => p.evaluate(() => document.getElementById('mic-btn')?.getAttribute('aria-pressed') === 'true'), { veces: 60 }));
  await espera(1500);
  await p.evaluate(() => document.querySelector('.rec-send')?.click());
  await espera(1500);
  await p.evaluate(() => document.querySelector('#perm-deny, .perm-deny, [data-perm="deny"]')?.click()).catch(() => {});
  ok('nota de voz: termina', await hasta(() => p.evaluate(() => document.getElementById('mic-btn')?.getAttribute('aria-pressed') === 'false'), { veces: 80 }));
} else ok('nota de voz: hay botón de micrófono', false);

// ── 7. La memoria compartida (claw.elffuss.com/memory/ enmarcada) ───────────
ok('la página almacén de la memoria (Claw) se enmarca en Code', await hasta(() => p.frames().some((f) => f.url().startsWith('https://claw.elffuss.com/memory/')), { veces: 100 }),
  p.frames().map((f) => f.url().slice(0, 60)).join(' | '));

// ── 8. Ajustes y el puente local ────────────────────────────────────────────
await p.goto(CODE + '/?test-opfs#/settings', { waitUntil: 'domcontentloaded' });
ok('Ajustes: la sección del puente enseña sus descargas y sus sumas', await hasta(() => p.evaluate(() => /SHA256SUMS/.test(document.body.innerText) || !!document.querySelector('a[href*="bridge-dl/"]')), { veces: 150 }));
const ping = await p.evaluate(async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/ping`, { mode: 'cors' })).status; } catch (e) { return 'ERR ' + e.message; } }, puente.address().port);
ok('una petición al puente local (http://127.0.0.1) no la bloquea la política', ping === 200, String(ping));

// ── 9. Librerías vendorizadas ───────────────────────────────────────────────
const libs = await p.evaluate(async () => {
  const out = {};
  try {
    const l = await import('/vendor/third-party/@litert-lm/core@0.15.0/dist/index.js');
    out.litert = (await l.loadLiteRtLm(location.origin + '/vendor/third-party/@litert-lm/core@0.15.0/wasm/')) ? 'loaded' : 'nada';
  } catch (e) { out.litert = 'ERR ' + e.message; }
  try { const tf = await (await import('/js/tf-runtime.js')).loadTransformers(); out.tf = tf.env.version + ' ' + tf.env.backends.onnx.versions?.web; } catch (e) { out.tf = 'ERR ' + e.message; }
  try { const g = await import('/js/ext/grammars.js'); const m = await g.loadEngine(); out.onig = typeof m.onig.OnigScanner; } catch (e) { out.onig = 'ERR ' + e.message; }
  return out;
});
ok('LiteRT-LM (vendorizado) carga su WebAssembly de este origen', libs.litert === 'loaded', libs.litert);
ok('Transformers.js 4.3.2 (lo que servía el CDN) con el ONNX Runtime que nombra, de este origen', libs.tf === '4.3.2 1.31.0-dev.20260914-8d85527a0', libs.tf);
ok('Oniguruma: su WebAssembly de este origen, con integridad', libs.onig === 'function', libs.onig);

// ── 10. El banco de pruebas ─────────────────────────────────────────────────
const lab = await ctx.newPage();
const rl = await lab.goto(CODE + '/lab.html', { waitUntil: 'domcontentloaded' });
ok('lab.html abre con su política (blob: solo ahí)', /script-src 'self' 'wasm-unsafe-eval' blob:/.test((PHASE === 2 ? rl.headers()['content-security-policy'] : rl.headers()['content-security-policy-report-only']) || ''));
await espera(1500);
const blobMod = await lab.evaluate(async () => { const u = URL.createObjectURL(new Blob(['export const x = 7;'], { type: 'text/javascript' })); try { return (await import(u)).x; } finally { URL.revokeObjectURL(u); } }).catch((e) => 'ERR ' + e.message);
ok('…e importa un módulo blob: (el test de la tarea SWE)', blobMod === 7, String(blobMod));
await lab.close();

// ── 11. Otros sitios no pueden enmarcar; la caja sola es opaca ──────────────
const evil = await ctx.newPage();
await evil.goto('https://evil.test/');
await espera(2500);
const bloqueos = consola.filter((c) => c.startsWith('https://evil.test/') && /frame-ancestors/.test(c) && !/report-only/.test(c));
ok('evil.test no puede enmarcar Code ni su caja (frame-ancestors)', bloqueos.length >= 2, bloqueos.length + '');
await evil.close();
const sola = await ctx.newPage();
await sola.goto(CODE + '/sandbox/run.html?n=1');
ok('la caja abierta sola: origen opaco (directiva sandbox)', await sola.evaluate(() => window.origin) === 'null');
await sola.close();

// ── Balance ─────────────────────────────────────────────────────────────────
await espera(500);
const aplicadas = violaciones.filter((v) => v.disp === 'enforce');
const tt = violaciones.filter((v) => v.disp === 'report' && /trusted-types/.test(v.dir));
const informe = violaciones.filter((v) => v.disp === 'report' && !/trusted-types/.test(v.dir));
const resumen = (vs) => [...new Map(vs.map((v) => [`${v.dir} ${v.blocked} @ ${v.src}`, v])).keys()];
ok(`ninguna violación de la política aplicada (${aplicadas.length})`, aplicadas.length === 0, resumen(aplicadas).slice(0, 12).join(' | '));
ok(`ninguna violación en informe fuera de Trusted Types (${informe.length})`, informe.length === 0, resumen(informe).slice(0, 12).join(' | '));
console.log(`ℹ️  Trusted Types (solo informe): ${tt.length} avisos, ${resumen(tt).length} sitios distintos`);
for (const s of resumen(tt).slice(0, 15)) console.log('     · ' + s);
const hosts = [...pedidos.keys()].sort();
ok('ningún CDN pedido', !hosts.some((x) => CDN.test(x.replace(/:\d+$/, ''))), hosts.join(', '));
console.log('ℹ️  hosts pedidos: ' + hosts.map((x) => `${x}×${pedidos.get(x)}`).join(', '));
ok('ningún error de página', errores.length === 0, errores.slice(0, 5).join(' | '));
const cspConsola = consola.filter((c) => /Content Security Policy|Refused to|EvalError/i.test(c) && !/Report Only|report-only|Trusted Type/i.test(c) && !c.startsWith('https://evil.test/'));
ok('la consola no muestra bloqueos de CSP', cspConsola.length === 0, cspConsola.slice(0, 6).join(' | '));
if (process.env.CSP_F0_OUT) writeFileSync(join(process.env.CSP_F0_OUT, `code-fase${PHASE}.json`), JSON.stringify({ violaciones, consola, hosts: Object.fromEntries(pedidos), errores }, null, 2));
await b.close();
await srv.cerrar();
puente.close();
console.log(fallos ? `\n❌ ${fallos} FALLO(S)` : `\n✅ Code bajo sus cabeceras de producción (fase ${PHASE})`);
process.exit(fallos ? 1 : 0);
