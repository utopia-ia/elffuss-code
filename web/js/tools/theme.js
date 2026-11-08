// «Tu versión» de Elffuss (Opción A) desde Code: el tema se valida aquí (elffuss-theme.js) y se entrega como un
// enlace a elffuss.com con el tema en el hash (#theme=…). El chat lo vuelve a validar, enseña cómo queda y solo lo
// aplica si el usuario lo confirma allí. En Claw el tema se guarda en su almacén y el chat lo lee por el puente; Code
// vive en otro origen y su almacén no lo ve elffuss.com, por eso aquí es un enlace.
import { validateTheme, SCHEMA, COLORS, RADIUS, DENSITY, FONTS } from '../elffuss-theme.js';

const CHAT = 'https://elffuss.com/';

function base64url(texto) {
  const b = new TextEncoder().encode(texto);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function get() {
  return `The theme is built here and applied on elffuss.com after the user confirms it. Allowed: colors {${Object.keys(COLORS).join(', ')}} as #rrggbb, radius ${Object.keys(RADIUS).join('|')}, density ${Object.keys(DENSITY).join('|')}, font ${Object.keys(FONTS).join('|')}, texts {es|en: {key: text}}.`;
}

export async function set({ theme }) {
  const v = validateTheme(theme);
  if (!v.ok) throw new Error('Theme not valid: ' + v.errors.join('; '));
  const link = `${CHAT}#theme=${base64url(JSON.stringify(v.theme))}`;
  return `Theme valid (${SCHEMA}). Give the user this link: opening it on elffuss.com shows a preview and asks before applying it.\n${link}`;
}

export async function reset() {
  return `To go back to the official look, open ${CHAT}?official=1 or use «Volver a la oficial» on elffuss.com.`;
}
