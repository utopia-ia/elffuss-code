// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Las herramientas de imagen, audio y vídeo en Code: el módulo común (media-tools.js, el mismo fichero que el chat de
// elffuss.com y Claw) con lo que pone Code alrededor. El SDK de elffuss-ai está copiado por pin en
// web/vendor/elffuss-ai/ (ai-sync.mjs); va bajo /vendor/ porque el SDK solo arranca Workers desde ahí.
//
// Lo que pone main.js (configureMedia): soltar el cerebro de la gráfica mientras corre la tarea y volver a cargarlo
// después (el turno espera a que vuelva: el cerrojo de inferencia es de todas las conversaciones), la pregunta de la
// descarga y la tarjeta del chat (media-ui.js), con su progreso por etapas y su botón Parar, que aborta el turno.
// Y lo propio de Code: `path` guarda el fichero hecho dentro del proyecto (code.writeBlob, con su aprobación).
import { createMediaTools, isMediaTool, MEDIA_TOOL_NAMES, MEDIA_ALIASES, mediaToolLines, getMedia } from './media-tools.js';
import { writeBlob } from './code.js';

export { isMediaTool, MEDIA_TOOL_NAMES, MEDIA_ALIASES };

let hooks = {
  lang: () => ((typeof navigator !== 'undefined' && navigator.language) || 'es').slice(0, 2) === 'es' ? 'es' : 'en',
  unloadLlm: async () => {},
  reloadLlm: async () => {},
  consent: async () => false,
  card: () => ({ progress() {}, done() {} }),
};
export function configureMedia(h) { hooks = { ...hooks, ...h }; }

/** Con qué «conversación» se guardan los medios de esta app (todas las de Code comparten la suya). */
export const CHAT = 'code';

/** La URL de vendor/elffuss-ai/ de esta web. */
export const AI_BASE = new URL('../../vendor/elffuss-ai/', import.meta.url);

const media = createMediaTools({
  base: AI_BASE,
  lang: () => hooks.lang(),
  unloadLlm: () => hooks.unloadLlm(),
  reloadLlm: () => hooks.reloadLlm(),
  consent: (q) => hooks.consent(q),
});
export const transcribe = (samples, opts) => media.transcribe(samples, opts);

// El catálogo de Claw en su forma (TOOLS: desc + params), sacado de las mismas líneas que lee el chat.
export function mediaToolEntries(lang = 'es') {
  const out = {};
  for (const line of mediaToolLines(lang)) {
    const m = /^- ([\w.]+)\(([^)]*)\): (.*)$/.exec(line);
    if (!m) continue;
    const params = Object.fromEntries(m[2].split(',').map((p) => p.trim().replace(/\?$/, '')).filter(Boolean).map((p) => [p, '']));
    // En Code, además: dónde guardarlo dentro del proyecto.
    params.path = lang === 'es' ? 'opcional: ruta del proyecto donde guardar el fichero (p. ej. assets/zorro.png)' : 'optional: project path to save the file to (e.g. assets/fox.png)';
    out[m[1]] = { desc: m[3] + (lang === 'es' ? '. Con path, lo guarda también en el proyecto' : '. With path, it is also saved in the project'), params, run: (a, ctx) => runMedia(m[1], a, ctx) };
  }
  return out;
}

/**
 * Una llamada: la tarjeta en el chat, el progreso por etapas, y lo que lee el modelo (texto; «ERROR: …» si falta algo
 * que el modelo puede arreglar). Parar el turno (ctx.signal) aborta la tarea.
 */
export async function runMedia(tool, args = {}, ctx = {}) {
  const card = hooks.card({ tool, args });
  try {
    const r = await media.run({ tool, args }, { signal: ctx.signal, chat: CHAT, lang: hooks.lang(), onProgress: (p) => card.progress(p) });
    card.done(r.result);
    // El cerebro vuelve a cargarse por detrás (media-tools.js no lo espera): aquí sí, antes de soltar el turno.
    await new Promise((res) => setTimeout(res, 0));
    await hooks.waitLlm?.();
    if (r.result?.error && !r.end) return 'ERROR: ' + r.result.error;
    let text = r.text;
    const path = String(args?.path || '').trim().replace(/^\/+/, '');
    if (path && r.result?.media) {
      try {
        const rec = await getMedia(r.result.media.id);
        text += '\n' + await writeBlob({ path, blob: rec.blob });
      } catch (e) { text += '\nERROR al guardarlo en ' + path + ': ' + (e?.message || e); }
    }
    return text;
  } catch (e) {
    card.done({ ...(args || {}), tool, error: e?.name === 'AbortError' ? 'stopped' : (e?.message || String(e)), stopped: e?.name === 'AbortError' });
    throw e;
  }
}

/** El id de medio que nombra un resultado («Imagen img-k3x9 hecha…»), para repintar su tarjeta al restaurar. */
export const mediaIdIn = (text) => /\b(?:img|aud|vid)-[a-z2-9]{4}\b/.exec(String(text || ''))?.[0] || null;
