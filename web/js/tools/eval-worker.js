// El worker donde Code ejecuta JavaScript del proyecto (code.run) y comprueba si se parsea (la guarda de sintaxis de
// code.edit y code.write). Se sirve con una política propia (deploy/headers.json, «eval-worker»): puede evaluar código
// ('unsafe-eval') e importar los módulos blob: que la página hace con los ficheros del proyecto, cosas que la política
// de la página de Code no permite. Un worker no tiene DOM ni acceso a la página, y la página lo corta por tiempo.
//
//   { op: 'parse', id, code }   → { id, r: true | 'mensaje del SyntaxError' }   (new Function solo PARSEA)
//   { op: 'run', url, expr }    → { ok: true, tipo, texto } | { ok: false, error, exporta }
self.onmessage = async ({ data }) => {
  if (data && data.op === 'parse') {
    let r = true;
    try { new Function(String(data.code)); } catch (e) { r = e instanceof SyntaxError ? String(e.message) : true; }
    self.postMessage({ id: data.id, r });
    return;
  }
  if (!data || data.op !== 'run') return;
  // Los nombres exportados se ATAN como variables sueltas, además de en «m» (ver code.run en code.js).
  try {
    const m = await import(data.url);
    const nombres = Object.keys(m).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    const fn = new Function('m', ...nombres, 'return (' + data.expr + ')');
    const valor = await fn(m, ...nombres.map((n) => m[n]));
    let texto;
    try { texto = JSON.stringify(valor); } catch { texto = String(valor); }
    if (texto === undefined) texto = String(valor);
    self.postMessage({ ok: true, tipo: typeof valor, texto });
  } catch (e) {
    let exporta = [];
    try { exporta = Object.keys(await import(data.url)); } catch { /* ni carga */ }
    self.postMessage({ ok: false, error: e.message, exporta });
  }
};
