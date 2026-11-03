// Herramientas de memoria de Code: las tres del motor (memory.save, memory.list,
// memory.forget), con su descripción del motor, en la forma del catálogo de
// Code ({ desc, params, run }).
//
// No hacen nada por su cuenta: cada llamada la corre el turno de memoria del
// agente (memory-wire.js `empezarTurno`), que es quien sabe qué escribió el
// usuario, si el turno está contaminado y en qué proyecto se está. Sin turno
// de memoria (memoria apagada o no disponible) contestan eso, sin escribir nada.
const NO_DISPONIBLE = 'La memoria no está disponible ahora';

export function entradas(defs) {
  const out = {};
  for (const [nombre, d] of Object.entries(defs || {})) {
    out[nombre] = {
      desc: d.desc,
      params: { ...(d.params || {}) },
      memoria: true,
      run: async (args, ctx = {}) => (ctx.memoria ? ctx.memoria.correr(nombre, args || {}) : NO_DISPONIBLE),
    };
  }
  return out;
}
