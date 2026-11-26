// Reglas de negocio: fechas de tareas, recurrencias, hábitos y captura rápida

import { hoy, addDays, parseYmd, ymd, norm } from './util.js';

export const PRIORIDADES = { alta: 0, media: 1, baja: 2 };
export const RECURRENCIAS = {
  '': 'No se repite',
  diaria: 'Cada día',
  laborables: 'Lunes a viernes',
  semanal: 'Cada semana',
  mensual: 'Cada mes',
};
export const COLORES = ['#3B6FD8', '#2E8B6A', '#C8463D', '#8A5CD0', '#D9822B', '#1E9BB0', '#B5487E', '#6B7A8F'];

function siguiente(fecha, rec) {
  const d = parseYmd(fecha);
  switch (rec) {
    case 'diaria': d.setDate(d.getDate() + 1); break;
    case 'laborables':
      do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      break;
    case 'semanal': d.setDate(d.getDate() + 7); break;
    case 'mensual': {
      const dia = parseYmd(fecha).getDate();
      d.setDate(1); d.setMonth(d.getMonth() + 1);
      const ult = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(dia, ult));
      break;
    }
    default: return null;
  }
  return ymd(d);
}

/** Próxima fecha de una tarea repetitiva, siempre posterior a hoy */
export function proximaFecha(fecha, rec) {
  let f = siguiente(fecha || hoy(), rec);
  let guard = 0;
  while (f && f <= hoy() && guard++ < 1000) f = siguiente(f, rec);
  return f;
}

export function ordenarTareas(a, b) {
  return (a.fecha || '9999').localeCompare(b.fecha || '9999')
    || (a.hora || '99').localeCompare(b.hora || '99')
    || (PRIORIDADES[a.prioridad] ?? 1) - (PRIORIDADES[b.prioridad] ?? 1)
    || (a.creadoEn || 0) - (b.creadoEn || 0);
}

export const esVencida = t => !t.completada && t.fecha && t.fecha < hoy();

// ---------------- Hábitos ----------------
export const tocaHoy = (h, fecha = hoy()) => !h.dias?.length || h.dias.includes(parseYmd(fecha).getDay());
export const hecho = (h, fecha) => !!h.registro?.[fecha];

export function racha(h) {
  let n = 0;
  let f = hoy();
  if (tocaHoy(h, f) && !hecho(h, f)) f = addDays(f, -1); // hoy todavía no rompe la racha
  for (let i = 0; i < 400; i++) {
    if (tocaHoy(h, f)) {
      if (hecho(h, f)) n++;
      else break;
    }
    f = addDays(f, -1);
  }
  return n;
}

export function cumplimiento(h, dias = 30) {
  let toca = 0, hechos = 0;
  for (let i = 0; i < dias; i++) {
    const f = addDays(hoy(), -i);
    if (tocaHoy(h, f)) { toca++; if (hecho(h, f)) hechos++; }
  }
  return toca ? Math.round((hechos / toca) * 100) : 0;
}

/** Fechas de lunes a domingo de la semana actual */
export function semanaActual() {
  const d = parseYmd(hoy());
  const lunes = addDays(hoy(), -((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(lunes, i));
}

// ---------------- Captura rápida ----------------
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/**
 * Interpreta textos como:
 *   "Calificar parcial mañana 3pm #docencia !alta"
 *   "Reunión el viernes 10:30"   "Entregar informe 28/11"
 */
export function parsearRapido(texto, areas) {
  let t = ` ${texto} `;
  let fecha = null, hora = null, prioridad = 'media', areaId = null;

  t = t.replace(/\s#([\p{L}\p{N}_-]+)/gu, (m, n) => {
    const clave = norm(n);
    const a = areas.find(a => norm(a.nombre).replace(/\s+/g, '') === clave)
      || areas.find(a => norm(a.nombre).replace(/\s+/g, '').startsWith(clave));
    if (a) { areaId = a.id; return ' '; }
    return m;
  });

  t = t.replace(/\s!(alta|media|baja|!!|!)(?=\s)/gi, (m, p) => {
    p = p.toLowerCase();
    prioridad = p === '!!' || p === 'alta' ? 'alta' : p === '!' ? 'alta' : p;
    return ' ';
  });
  t = t.replace(/\s!(?=\s)/g, () => { prioridad = 'alta'; return ' '; });

  const h = hoy();
  t = t.replace(/\s(para\s+)?pasado\s+ma[ñn]ana(?=\s)/i, () => { fecha = addDays(h, 2); return ' '; });
  t = t.replace(/\s(para\s+)?hoy(?=\s)/i, () => { fecha = h; return ' '; });
  t = t.replace(/\s(para\s+)?ma[ñn]ana(?=\s)/i, () => { fecha = addDays(h, 1); return ' '; });
  t = t.replace(/\s(el\s+|este\s+|para\s+el\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)(?=\s)/i, (m, _p, dia) => {
    const objetivo = DIAS.indexOf(norm(dia));
    const actual = parseYmd(h).getDay();
    let dif = (objetivo - actual + 7) % 7;
    if (dif === 0) dif = 7;
    fecha = addDays(h, dif);
    return ' ';
  });
  t = t.replace(/\s(el\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/, (m, _e, d, mes, y) => {
    const hoyD = parseYmd(h);
    let anio = y ? Number(y.length === 2 ? '20' + y : y) : hoyD.getFullYear();
    let cand = new Date(anio, Number(mes) - 1, Number(d));
    if (!y && ymd(cand) < h) cand = new Date(anio + 1, Number(mes) - 1, Number(d));
    if (isNaN(cand)) return m;
    fecha = ymd(cand);
    return ' ';
  });

  const ponerHora = (H, M, suf) => {
    H = Number(H); M = Number(M || 0);
    if (suf) {
      const pm = /^p/i.test(suf);
      if (pm && H < 12) H += 12;
      if (!pm && H === 12) H = 0;
    }
    if (H > 23 || M > 59) return false;
    hora = `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
    return true;
  };
  t = t.replace(/\s(a\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.\s?m\.|p\.\s?m\.)(?=\s)/i, (m, _a, H, M, suf) => ponerHora(H, M, suf) ? ' ' : m);
  if (!hora) t = t.replace(/\s(a\s+las?\s+)?(\d{1,2}):(\d{2})(?=\s)/, (m, _a, H, M) => ponerHora(H, M) ? ' ' : m);

  return { titulo: t.replace(/\s+/g, ' ').trim(), fecha, hora, prioridad, areaId };
}

// ---------------- Recordatorios ----------------
export const REPETIR_AVISO = { 30: 'Cada 30 minutos', 60: 'Cada hora', 180: 'Cada 3 horas', 1440: 'Una vez al día' };
export const DIAS_ANTES = { 0: 'El mismo día', 1: '1 día antes', 2: '2 días antes', 3: '3 días antes', 7: '1 semana antes' };

/** Momento (ms) del primer aviso según la fecha de la tarea y la configuración */
export function calcularAvisarEn(t) {
  if (!t.aviso?.activo || !t.fecha || t.completada) return null;
  const d = parseYmd(addDays(t.fecha, -(Number(t.aviso.diasAntes) || 0)));
  const [H, M] = (t.aviso.hora || t.hora || '08:00').split(':').map(Number);
  d.setHours(H, M, 0, 0);
  return d.getTime();
}

/** Tareas cuyo aviso ya llegó y siguen pendientes */
export const avisoActivo = (t, ahora = Date.now()) => !t.completada && !t.pausada && !t.eliminado && t.avisarEn && t.avisarEn <= ahora;

// ---------------- Pegar tareas desde texto ----------------
// Marcas que usan las apps de notas y listas al copiar como texto
const MARCA_HECHA = /^(?:\[[xX✓✔]\]|\([xX✓✔]\)|[☑☒✓✔✅■◼●√✗✘])\s*/u;
const MARCA_PENDIENTE = /^(?:\[\s?\]|\(\s?\)|[☐□◻○◯▢⬜]|[-*+•·▪▫►▶>–—]|\d{1,3}[.)-])\s*/u;

/**
 * Convierte texto copiado en tareas: una por línea.
 * Entiende casillas (☐ ☑ [ ] [x]), viñetas, números, fechas y horas
 * ("mañana 3pm", "viernes", "28/11"), #área, "!" para prioridad alta,
 * líneas "Área:" como encabezado; con sangría: subtarea (si tiene casilla o viñeta) o nota.
 */
export function parsearListaTareas(texto, areas) {
  const out = [];
  let areaActual = null;
  for (const bruta of String(texto || '').replace(/\r\n?/g, '\n').split('\n')) {
    let l = bruta.trim();
    if (!l) continue;
    let hecha = false, marcada = false;
    l = l.replace(/^[-*+]\s+(?=[[(])/, '');
    if (MARCA_HECHA.test(l)) { hecha = true; marcada = true; l = l.replace(MARCA_HECHA, ''); }
    else if (MARCA_PENDIENTE.test(l)) { marcada = true; l = l.replace(MARCA_PENDIENTE, ''); }
    l = l.trim();
    if (!l) continue;
    // Encabezado del tipo "Docencia:" → área para las siguientes líneas
    if (!marcada && /:$/.test(l) && l.length <= 40) {
      const nombre = norm(l.slice(0, -1));
      const a = areas.find(a => norm(a.nombre) === nombre);
      areaActual = a ? a.id : null;
      continue;
    }
    // Línea con sangría y con marca → subtarea de la anterior
    if (marcada && /^(\s{2,}|\t)/.test(bruta) && out.length) {
      (out[out.length - 1].subtareas ||= []).push({ titulo: l, hecha });
      continue;
    }
    // Línea con sangría y sin marca → detalle de la tarea anterior
    if (!marcada && /^(\s{2,}|\t)/.test(bruta) && out.length) {
      const prev = out[out.length - 1];
      prev.notas = prev.notas ? `${prev.notas}\n${l}` : l;
      continue;
    }
    const p = parsearRapido(l, areas);
    out.push({ titulo: p.titulo || l, hecha, fecha: p.fecha, hora: p.hora, prioridad: p.prioridad, areaId: p.areaId || areaActual, notas: '' });
  }
  return out;
}
