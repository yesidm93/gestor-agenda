// Utilidades generales

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

const pad = n => String(n).padStart(2, '0');

/** Fecha local en formato YYYY-MM-DD */
export function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export const hoy = () => ymd();

const fmtLargo = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtCorto = new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });

/** Texto amigable para una fecha YYYY-MM-DD */
export function fechaAmigable(s) {
  if (!s) return 'Sin fecha';
  const h = hoy();
  if (s === h) return 'Hoy';
  if (s === addDays(h, 1)) return 'Mañana';
  if (s === addDays(h, -1)) return 'Ayer';
  return fmtCorto.format(parseYmd(s)).replace(/\./g, '');
}

export function fechaLarga(s) {
  return fmtLargo.format(parseYmd(s));
}

export function horaAmigable(h) {
  if (!h) return '';
  const [H, M] = h.split(':').map(Number);
  const suf = H >= 12 ? 'p. m.' : 'a. m.';
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return `${h12}:${pad(M)} ${suf}`;
}

export function haceCuanto(ms) {
  if (!ms) return 'nunca';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'hace un momento';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} día${d === 1 ? '' : 's'}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Quita tildes y pasa a minúsculas, para comparar textos */
export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Hash corto y estable de un texto (para detectar duplicados) */
export function hashTexto(s) {
  const t = norm(s).replace(/\s+/g, ' ');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Etiquetas #así dentro de un texto Markdown (ignora los títulos "# ") */
export function extraerEtiquetas(md) {
  const set = new Set();
  const sinCodigo = String(md || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const m of sinCodigo.matchAll(/(^|[\s(])#([\p{L}\p{N}_-]{2,})/gu)) set.add(m[2].toLowerCase());
  return [...set];
}

let toastTimer;
export function toast(msg, accion) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (accion) {
    const b = document.createElement('button');
    b.textContent = accion.texto;
    b.onclick = () => { accion.fn(); el.classList.remove('visible'); };
    el.appendChild(b);
  }
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), accion ? 6000 : 3000);
}

export function descargar(nombre, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function nombreArchivo(s) {
  return (String(s || 'nota').normalize('NFC').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'nota');
}

export const DIAS_CORTOS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
export const DIAS_NOMBRE = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
