// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// HTTPS server for tests/csp-f0.mjs: answers as the REAL hosts, chosen by the Host header, with the headers the
// deploy sends (deploy/headers.json through deploy/headers.mjs, the same values as the nginx snippets), so Code runs
// under its production policy with its production origin. Chrome is pointed here with --host-resolver-rules and
// accepts the test certificate only for these hosts; every other host fails to resolve, and the test records each
// request so a call to a CDN would show.
//
//   code.elffuss.com    this repository's web/, a scripted model compatible with OpenAI at /fake-llm/v1, and /proxy
//                       and /websearch that answer 503
//   claw.elffuss.com    Claw's memory store (/memory/ and the engine it runs), from $ELFFUSS_CLAW_REPO (default
//                       ../elffuss-claw-sec-f0, else ../elffuss-claw), with Claw's server/memory/headers.conf
//   models.elffuss.com  the model store from the same Claw checkout, with its policy from Claw's deploy/headers.json
//   evil.test           a page of another site that tries to frame Code and its sandbox page
import https from 'node:https';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersFor } from '../deploy/headers.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const WEB = join(RAIZ, 'web');
export const HOSTS = ['code.elffuss.com', 'claw.elffuss.com', 'models.elffuss.com', 'evil.test'];
const CLAW = [process.env.ELFFUSS_CLAW_REPO, join(RAIZ, '..', 'elffuss-claw-sec-f0'), join(RAIZ, '..', 'elffuss-claw')]
  .find((d) => d && existsSync(join(d, 'server', 'memory', 'headers.conf')));
if (!CLAW) throw new Error('no Claw checkout for the memory store and the model store (ELFFUSS_CLAW_REPO)');
const clawHeaders = await import(join(CLAW, 'deploy', 'headers.mjs')).catch(() => null);
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.webp': 'image/webp' };

// A test certificate for exactly these hosts (as tests/memoria-v2-servidor.mjs does for its own).
function certificadoDe(dir = mkdtempSync(join(tmpdir(), 'csp-f0-'))) {
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem'), conf = join(dir, 'san.cnf');
  writeFileSync(conf, ['[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no', '[dn]', 'CN=csp-f0.test',
    '[ext]', `subjectAltName=${HOSTS.map((x) => 'DNS:' + x).join(',')}`, 'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth'].join('\n'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-config', conf], { stdio: 'ignore' });
  const pub = execFileSync('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}

// The memory store's headers, read from the nginx snippet that is deployed.
function cabecerasAlmacen() {
  const conf = readFileSync(join(CLAW, 'server', 'memory', 'headers.conf'), 'utf8');
  const h = {};
  for (const m of conf.matchAll(/add_header\s+([\w-]+)\s+"([^"]*)"\s+always;/g)) h[m[1]] = m[2];
  return h;
}

// The scripted model: «ejecuta suma» → code.run on src/util.js; «rompe util» → a code.edit that would break the
// file's syntax (the guard must refuse it); after a tool result, «Hecho.».
function guion(messages) {
  const sin = messages.filter((m) => !(m.role === 'user' && /^CONTEXTO AHORA/.test(m.content)));
  let i = sin.length - 1, resultados = 0;
  while (i >= 0 && (sin[i].role !== 'user' || String(sin[i].content).startsWith('[resultado'))) { if (sin[i].role === 'user') resultados++; i--; }
  const u = i >= 0 ? String(sin[i].content) : '';
  const llamada = (tool, args) => '```tool\n' + JSON.stringify({ tool, args }) + '\n```';
  if (resultados > 0) return 'Hecho.';
  if (/ejecuta suma/i.test(u)) return llamada('code.run', { path: 'src/util.js', expr: 'suma(2, 3)' });
  if (/rompe util/i.test(u)) return llamada('code.edit', { path: 'src/util.js', search: 'return a + b;', replace: 'return a + b; } }' });
  return 'Vale, sin herramientas: esto es una respuesta guionada.';
}

const PAGINAS = {
  'evil.test': `<!doctype html><meta charset="utf-8"><title>otro sitio</title><body>
<iframe id="code" src="https://code.elffuss.com/"></iframe>
<iframe id="sbx" src="https://code.elffuss.com/sandbox/run.html?n=1"></iframe>`,
};

export async function arrancar({ puerto = 0, cert = certificadoDe(), phase = 2 } = {}) {
  const almacen = cabecerasAlmacen();
  const peticiones = [];
  const llm = [];
  const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, 'https://local.test');
    peticiones.push({ host, method: req.method, path: url.pathname });
    if (!HOSTS.includes(host)) { res.writeHead(421).end(); return; }
    if (PAGINAS[host]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGINAS[host]); return; }
    if (host === 'code.elffuss.com' && url.pathname === '/fake-llm/v1/chat/completions') {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(cuerpo); } catch { /* — */ }
        llm.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: guion(body.messages || []) } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    if (host === 'code.elffuss.com' && (url.pathname === '/proxy' || url.pathname.startsWith('/websearch'))) {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('no backend in this test'); return;
    }
    let raiz = WEB, ruta = decodeURIComponent(url.pathname);
    if (host === 'models.elffuss.com') raiz = join(CLAW, 'server', 'broker');
    if (host === 'claw.elffuss.com') {
      if (!(ruta.startsWith('/memory/') || ruta.startsWith('/js/engine/'))) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here'); return; }
      raiz = join(CLAW, 'web');
    }
    let file = normalize(join(raiz, ruta));
    if (!file.startsWith(raiz)) { res.writeHead(403).end(); return; }
    // nginx's `index`: a directory is answered by its index.html, and the map sees that path ($uri).
    let uri = ruta;
    if (existsSync(file) && statSync(file).isDirectory()) { file = join(file, 'index.html'); uri = ruta.replace(/\/?$/, '/') + 'index.html'; }
    let h;
    if (host === 'code.elffuss.com') h = headersFor('code.elffuss.com', uri, { phase });
    else if (host === 'models.elffuss.com') h = clawHeaders ? clawHeaders.headersFor('models.elffuss.com', uri, { phase, root: CLAW }) : {};
    else h = uri.startsWith('/memory/') ? { ...almacen } : (clawHeaders ? clawHeaders.headersFor('claw.elffuss.com', uri, { phase, root: CLAW }) : {});
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain', ...h }).end('not found'); return; }
    h = { 'Content-Type': TIPOS[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...h };
    res.writeHead(200, h);
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(puerto, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port, spki: cert.spki, peticiones, llm,
    args: [`--host-resolver-rules=${HOSTS.map((x) => `MAP ${x} 127.0.0.1:${port}`).join(', ')}, MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${cert.spki}`],
    cerrar: () => new Promise((r) => server.close(r)),
  };
}
