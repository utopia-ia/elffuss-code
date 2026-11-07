// Búsqueda y lectura web para la elfa de Code (docs, errores, APIs), sobre el módulo compartido de Elffuss
// (web-research.js, copia exacta del de elffuss.com: no editarlo aquí, sino allí y volver a copiarlo).
//
//   web.search({ query })   el buscador propio de Elffuss (/websearch, SearXNG en este mismo origen; site: pasa tal
//                           cual), DuckDuckGo lite por el proxy si falla, responde 429 o no encuentra nada; y las dos
//                           primeras páginas leídas por su cuenta, con sus párrafos para la pregunta. Una búsqueda
//                           site: vacía sigue: las palabras del usuario, la búsqueda dentro del sitio, una vez sin
//                           site:. Un modelo que llame a web.site({ url, query }) acaba aquí, como site:.
//   web.fetchUrl({ url })   una página, como sus párrafos más relevantes para lo que pidió el usuario; las páginas
//                           hechas con JavaScript se leen por sus datos (JSON-LD, noscript, feed, AMP…).
//
// Las peticiones van por el proxy del servidor (/proxy?url=…); sin proxy (desarrollo sin servidor) se intenta
// directo, por si el sitio permite CORS. La pregunta del usuario NO sale: solo ordena párrafos aquí.
import { terms, buildBM25 } from '../acer-core.js';
import { createResearch, decodeBody, parseSearx, WORDS, renderSearch, renderPage } from './web-research.js';
import { uiLang } from '../i18n.js';

const TIMEOUT_MS = 25000;
const lang = () => (uiLang() === 'es' ? 'es' : 'en');
const words = () => WORDS[lang()];

function parseWithBase(html, url) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  if (!doc.querySelector('base[href]') && doc.head) {
    const b = doc.createElement('base');
    b.setAttribute('href', url);
    doc.head.prepend(b);
  }
  return doc;
}

async function withTimeout(signal, fn) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, TIMEOUT_MS);
  try { return await fn(ctl.signal); } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

async function get(url, { signal } = {}) {
  return withTimeout(signal, async (sig) => {
    const r = await fetch('/proxy?url=' + encodeURIComponent(url), { signal: sig });
    const code = r.headers.get('X-Proxy-Error') || '';
    const upstream = Number(r.headers.get('X-Proxy-Upstream-Status')) || 0;
    // Sin el proxy en este servidor (404/405/501 sin cabeceras del proxy): directo, si el sitio deja (CORS).
    if (!code && !upstream && [404, 405, 501].includes(r.status)) {
      const d = await fetch(url, { signal: sig });
      const type = d.headers.get('Content-Type') || '';
      return { ok: d.ok, status: d.status, code: '', type, url: d.url || url, text: decodeBody(await d.arrayBuffer(), type), truncated: false };
    }
    const type = r.headers.get('Content-Type') || '';
    const bytes = await r.arrayBuffer();
    return {
      ok: r.ok && !code, status: code ? r.status : (upstream || r.status), code, type,
      url: r.headers.get('X-Proxy-Final-Url') || url,
      text: code ? '' : decodeBody(bytes, type),
      truncated: r.headers.get('X-Proxy-Truncated') === '1',
    };
  });
}

const websearchUrl = (q) => `/websearch?q=${encodeURIComponent(q)}&format=json&language=${lang()}`;
const searchEngine = {
  url: (q) => new URL(websearchUrl(q), location.origin).href,
  run: (q, { signal } = {}) => withTimeout(signal, async (sig) => {
    const r = await fetch(websearchUrl(q), { signal: sig, headers: { Accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error('websearch ' + r.status), { code: r.status === 429 ? 'rate-limited' : 'down' });
    if (!/json/i.test(r.headers.get('Content-Type') || '')) throw Object.assign(new Error('websearch not json'), { code: 'down' });
    return parseSearx(await r.text());
  }),
};

let research = null;
async function lab() {
  if (research) return research;
  const Readability = await import('../../vendor/readability/readability.js').then((m) => m.default, () => null);
  research = createResearch({ get, parseHTML: parseWithBase, terms, buildBM25, Readability, searchEngine });
  return research;
}

const cap = (text, n) => (text.length > n ? text.slice(0, n) + '\n' + words().cut : text);
const hostPath = (u) => { try { const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, ''); } catch { return String(u || '').trim(); } };

export async function fetchUrl({ url } = {}, ctx = {}) {
  if (!/^https?:\/\//.test(url || '')) throw new Error(lang() === 'es' ? 'URL inválida (usa https://…)' : 'Invalid URL (use https://…)');
  const R = await lab();
  const r = await R.fetch(url, { question: ctx.question || '', signal: ctx.signal });
  if (r.error) throw new Error(renderPage(r, words(), ''));
  return cap(renderPage(r, words(), ctx.question || ''), R.limits.fetchChars + 600);
}

export async function search({ query, url, site } = {}, ctx = {}) {
  let q = String(query || '').trim();
  const where = String(url || site || '').trim();
  if (where && !/(^|\s)site:/i.test(q)) q = `site:${hostPath(where)} ${q}`.trim();
  if (!q) throw new Error(lang() === 'es' ? 'Falta query' : 'Missing query');
  const R = await lab();
  const r = await R.search(q, { question: ctx.question || '', read: 2, signal: ctx.signal });
  if (!r.items.length && r.blocked) throw new Error(words().blocked(q));
  return cap(renderSearch(r, words()), R.limits.searchChars + 1200);
}
