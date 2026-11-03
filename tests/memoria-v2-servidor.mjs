// Servidor HTTPS local para la prueba de la memoria compartida en Code
// (memoria-v2.mjs). Contesta como los hosts DE VERDAD, elegidos por la cabecera
// Host, para que las páginas corran con sus orígenes de producción: el
// navegador se apunta aquí con --host-resolver-rules y acepta el certificado de
// prueba solo para estos hosts.
//
//   code.elffuss.com   este repo (web/), con su copia del motor (web/js/engine/)
//   claw.elffuss.com   la página almacén (/memory/) con sus cabeceras de
//                      despliegue, y el motor (/js/engine/, la misma copia)
//   elffuss.com        nada (404): que ningún enlace salga a producción
//   code-copia.test    Code servido en OTRO origen: ahí no debe haber memoria
//
// La página almacén es la de Claw (web/memory/ y server/memory/headers.conf),
// buscada en CLAW=<checkout de Claw> o al lado de este repo. Si no está, se
// sirve la equivalente que describe la especificación (las diez líneas de
// index.html y page.js, con la config de Code, que es copia byte a byte de la
// de Claw) y las cabeceras se generan de esa misma config.
import https from 'node:https';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const WEB = join(AQUI, '..', 'web');
export const HOSTS = ['code.elffuss.com', 'claw.elffuss.com', 'elffuss.com', 'code-copia.test'];
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

export function buscarClaw() {
  const candidatos = [process.env.CLAW, join(AQUI, '..', '..', 'elffuss-claw-memory'), join(AQUI, '..', '..', 'elffuss-claw')].filter(Boolean);
  return candidatos.find((d) => existsSync(join(d, 'web', 'memory', 'index.html')) && existsSync(join(d, 'server', 'memory', 'headers.conf'))) || null;
}

// La página almacén: { index, page, config, cabeceras, origen }.
async function paginaAlmacen() {
  const claw = buscarClaw();
  if (claw) {
    const conf = readFileSync(join(claw, 'server', 'memory', 'headers.conf'), 'utf8');
    const cabeceras = {};
    for (const m of conf.matchAll(/add_header\s+([\w-]+)\s+"([^"]*)"\s+always;/g)) cabeceras[m[1]] = m[2];
    return { dir: join(claw, 'web', 'memory'), cabeceras, origen: 'claw' };
  }
  const { default: cfg } = await import(pathToFileURL(join(WEB, 'memory', 'memory.config.js')).href);
  const fa = cfg.apps.map((a) => a.origin).join(' ');
  return {
    dir: null, origen: 'especificación',
    index: '<!doctype html><meta charset="utf-8"><title>Memory</title>\n<div id="root"></div>\n<script type="module" src="./page.js"></script>\n',
    page: "import { mountStorePage } from '../js/engine/memory-ui.js';\nimport cfg from './memory.config.js';\nmountStorePage(cfg);\n",
    cabeceras: {
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${fa}`,
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-site', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
    },
  };
}

export function certificado(dir = mkdtempSync(join(tmpdir(), 'code-memoria-'))) {
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem'), conf = join(dir, 'san.cnf');
  writeFileSync(conf, ['[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no', '[dn]', 'CN=code-memoria.test',
    '[ext]', `subjectAltName=${HOSTS.map((x) => 'DNS:' + x).join(',')}`, 'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth'].join('\n'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-config', conf], { stdio: 'ignore' });
  const pub = execFileSync('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}

export async function arrancar({ puerto = 0, cert = certificado() } = {}) {
  const almacen = await paginaAlmacen();
  const peticiones = [];       // { host, method, path, query }
  const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, 'https://local.test');
    peticiones.push({ host, method: req.method, path: url.pathname, query: url.search });
    if (!HOSTS.includes(host) || host === 'elffuss.com') { res.writeHead(host === 'elffuss.com' ? 404 : 421).end(); return; }
    let ruta = decodeURIComponent(url.pathname);
    let raiz = WEB;
    const h = { 'Cache-Control': 'no-cache' };
    if (host === 'claw.elffuss.com') {
      if (ruta === '/memory' ) { res.writeHead(301, { Location: '/memory/' }).end(); return; }
      if (ruta.startsWith('/memory/')) {
        Object.assign(h, almacen.cabeceras);
        if (!almacen.dir) {
          const cuerpo = ruta === '/memory/' || ruta === '/memory/index.html' ? almacen.index : ruta === '/memory/page.js' ? almacen.page : null;
          if (cuerpo !== null) { res.writeHead(200, { ...h, 'Content-Type': TIPOS[ruta.endsWith('.js') ? '.js' : '.html'] }).end(cuerpo); return; }
          // memory.config.js: la copia de Code (byte a byte la de Claw)
        } else {
          raiz = almacen.dir; ruta = ruta.slice('/memory'.length) || '/';
        }
      } else if (!ruta.startsWith('/js/engine/')) { res.writeHead(404).end(); return; }
    }
    let file = normalize(join(raiz, ruta));
    if (!file.startsWith(raiz)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { ...h, 'Content-Type': TIPOS[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(puerto, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port, spki: cert.spki, peticiones, almacen: almacen.origen,
    // Solo estos hosts vienen aquí; el resto (el CDN del editor) va a la red,
    // como en las demás pruebas de Code.
    args: [`--host-resolver-rules=${HOSTS.map((x) => `MAP ${x} 127.0.0.1:${port}`).join(', ')}`,
      `--ignore-certificate-errors-spki-list=${cert.spki}`],
    cerrar: () => new Promise((r) => server.close(r)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await arrancar({ puerto: +process.argv[2] || 8446 });
  console.log(`https://127.0.0.1:${s.port} como ${HOSTS.join(', ')} · página almacén: ${s.almacen}`);
  console.log(s.args.join(' '));
}
