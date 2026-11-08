// Vista «Arquitectura» — grafo 3D de dependencias del proyecto, FIEL a CodeFlow
// (braedonsaunders/codeflow, MIT): usa la MISMA librería `3d-force-graph`, con
// nodos coloreados por capa (carpeta de primer nivel), tamaño por número de
// conexiones y partículas de flujo viajando por los enlaces (la firma de
// CodeFlow). Lee los ficheros reales, extrae los imports y resuelve las aristas.
// Clic en un nodo → abre el fichero en Monaco.
import * as code from './tools/code.js';

const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|c|h|cpp|hpp|vue|svelte)$/i;
// 3d-force-graph fijado y servido desde este origen (web/vendor/third-party/, PIN.json); se comprueba su sha384.
const FG_URL = new URL('../vendor/third-party/3d-force-graph@1.80.2/dist/3d-force-graph.min.js', import.meta.url).href;
const FG_SRI = 'sha384-GBG/VW3/k9nOKHgDlgS2DFk3HDPeNndiVa5280Guy62u3QEpZQPuAuB4POI5giZN';
// paleta por capa (carpeta de primer nivel), estilo CodeFlow
const LAYER_COLORS = ['#7c5cff', '#49e8ff', '#ff4d8d', '#3fb970', '#ffd479', '#ff9f45', '#a86cff', '#42b883', '#e34c26', '#00add8'];

// Extrae destinos de import de un fichero (JS/TS/Py, tolerante).
function importsOf(path, src) {
  const t = [];
  const re = /(?:import\s+[^'"]*from\s+|import\s+|require\(\s*|export\s+[^'"]*from\s+)['"]([^'"]+)['"]/g;
  let m; while ((m = re.exec(src))) t.push(m[1]);
  const py = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
  while ((m = py.exec(src))) t.push((m[1] || m[2]).replace(/\./g, '/'));
  return t;
}

// Resuelve un import relativo a un fichero real del proyecto.
function resolve(from, spec, files) {
  if (!/^[./]/.test(spec)) {
    const hit = files.find(f => f.endsWith('/' + spec) || f.includes('/' + spec + '.') || f.includes('/' + spec + '/'));
    return hit || null;
  }
  const base = from.split('/').slice(0, -1);
  for (const part of spec.split('/')) { if (part === '..') base.pop(); else if (part !== '.') base.push(part); }
  const cand = base.join('/');
  return files.find(f => f === cand) ||
    files.find(f => f.replace(CODE_EXT, '') === cand) ||
    files.find(f => f === cand + '/index.js' || f === cand + '/__init__.py') || null;
}

// Monaco carga un loader AMD (define.amd); el UMD de 3d-force-graph se
// registraría por AMD y NO crearía window.ForceGraph3D. Anulamos `define`
// mientras carga el bundle para forzar la rama global (igual que con xterm).
const loadFG = () => window.ForceGraph3D ? Promise.resolve() : new Promise((res, rej) => {
  const savedDefine = window.define;
  window.define = undefined;
  const restore = () => { window.define = savedDefine; };
  const s = document.createElement('script');
  s.src = FG_URL; s.integrity = FG_SRI;
  s.onload = () => { restore(); window.ForceGraph3D ? res() : rej(new Error('3d-force-graph cargó pero no expuso ForceGraph3D')); };
  s.onerror = () => { restore(); rej(new Error('no cargó 3d-force-graph')); };
  document.head.appendChild(s);
});

let graph = null;

export async function renderArchitecture(container, onOpenFile) {
  disposeArch();
  container.innerHTML = '<div class="view-loading">Analizando la arquitectura del proyecto…</div>';
  const files = (await code.fileList()).filter(f => CODE_EXT.test(f)).slice(0, 400);
  if (!files.length) { container.innerHTML = '<div class="view-loading">Sin ficheros de código para analizar.</div>'; return; }

  const topOf = p => p.includes('/') ? p.split('/')[0] : '(raíz)';
  const layers = [...new Set(files.map(topOf))];
  const layerColor = new Map(layers.map((l, i) => [l, LAYER_COLORS[i % LAYER_COLORS.length]]));
  const deg = new Map(files.map(f => [f, 0]));
  const links = [];
  const seen = new Set();
  for (const p of files) {
    let src = ''; try { src = await code.read({ path: p }); } catch { continue; }
    for (const spec of importsOf(p, src)) {
      const target = resolve(p, spec, files);
      if (target && target !== p) {
        const key = p + '\u0000' + target;
        if (seen.has(key)) continue; seen.add(key);
        links.push({ source: p, target });
        deg.set(p, deg.get(p) + 1); deg.set(target, deg.get(target) + 1);
      }
    }
  }
  const nodes = files.map(p => ({ id: p, name: p.split('/').pop(), layer: topOf(p), val: 1 + deg.get(p) * 2, color: layerColor.get(topOf(p)) }));

  container.innerHTML =
    '<div id="arch-graph"></div>' +
    '<div class="view-head">Arquitectura · ' + nodes.length + ' ficheros, ' + links.length + ' dependencias' +
    '<span class="view-hint">arrastra para orbitar · las partículas fluyen del importado al importador · clic en un nodo → abrir</span></div>';
  const el = container.querySelector('#arch-graph');

  await loadFG();
  graph = window.ForceGraph3D({ controlType: 'orbit' })(el)
    .backgroundColor('#0b0d12')
    .width(el.clientWidth || 800).height(el.clientHeight || 600)
    .graphData({ nodes, links })
    .nodeVal('val')
    .nodeColor('color')
    .nodeOpacity(0.92)
    .nodeLabel(n => `${n.id} · ${deg.get(n.id)} conexiones`)
    .nodeResolution(12)
    .linkColor(() => 'rgba(140,150,180,0.28)')
    .linkWidth(0.6)
    .linkDirectionalParticles(2)
    .linkDirectionalParticleSpeed(0.006)
    .linkDirectionalParticleWidth(1.8)
    .linkDirectionalParticleColor(() => '#49e8ff')
    .onNodeClick(n => onOpenFile(n.id))
    .onBackgroundClick(() => {})
    .cooldownTicks(120)
    .onEngineStop(() => graph && graph.zoomToFit(500, 40));
  // separación por capas: espaciar un poco las cargas de nodos
  graph.d3Force('charge').strength(-120);
  graph.nodeThreeObjectExtend?.(false);
  const onResize = () => graph && graph.width(el.clientWidth).height(el.clientHeight);
  window.addEventListener('resize', onResize);
  graph.__onResize = onResize;
  // para pruebas: nº de nodos accesible en el DOM
  el.dataset.nodes = String(nodes.length);
  el.dataset.links = String(links.length);
  // Lo mismo que el lienzo, como lista (la monta main.js al lado): con teclado
  // o lector de pantalla un grafo 3D no se puede recorrer. `locate` lleva la
  // cámara hasta un fichero, como cuando se busca en el grafo de CodeFlow.
  return {
    items: nodes.map(n => ({ path: n.id, conexiones: deg.get(n.id) })),
    locate(path) {
      const n = nodes.find(x => x.id === path);
      if (!graph || !n || n.x == null) return false;
      const lejos = 70, r = 1 + lejos / (Math.hypot(n.x, n.y, n.z) || 1);
      graph.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 800);
      return true;
    },
  };
}

export function disposeArch() {
  if (!graph) return;
  try { if (graph.__onResize) window.removeEventListener('resize', graph.__onResize); graph._destructor?.(); } catch { /* mejor esfuerzo */ }
  graph = null;
}
