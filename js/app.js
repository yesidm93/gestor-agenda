// Gestor agenda · aplicación principal
import * as db from './db.js';
import * as sync from './sync.js';
import * as imp from './importer.js';
import * as fin from './finanzas.js';
import * as avisos from './avisos.js';
import * as imgs from './imagenes.js';
import { I } from './icons.js';
import {
  uid, hoy, addDays, fechaAmigable, fechaLarga, horaAmigable, haceCuanto, esc, debounce, norm,
  extraerEtiquetas, toast, descargar, nombreArchivo, DIAS_CORTOS, DIAS_NOMBRE, parseYmd,
} from './util.js';
import {
  PRIORIDADES, RECURRENCIAS, COLORES, proximaFecha, ordenarTareas, esVencida,
  tocaHoy, hecho, racha, cumplimiento, semanaActual, parsearRapido,
  calcularAvisarEn, avisoActivo, REPETIR_AVISO, DIAS_ANTES, parsearListaTareas,
} from './logic.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const escritorio = () => matchMedia('(min-width: 900px)').matches;

const VISTAS = {
  hoy: { titulo: 'Hoy', icono: I.hoy },
  tareas: { titulo: 'Tareas', icono: I.tareas },
  habitos: { titulo: 'Hábitos', icono: I.habitos },
  notas: { titulo: 'Notas', icono: I.notas },
  finanzas: { titulo: 'Finanzas', icono: I.finanzas },
  ajustes: { titulo: 'Ajustes', icono: I.ajustes },
};

const ui = {
  vista: 'hoy',
  filtro: 'proximas',
  areaId: null,
  notaId: null,
  busqueda: '',
  cuaderno: 'todos',
  etiqueta: null,
  verHechasHoy: false,
  vistaPrevia: false,
  fmes: fin.mesActual(),
  fpestana: 'mes',
  verSaldadas: false,
  desplegadas: new Set(),
};

let eventoInstalar = null;
let clavesGeneradas = null;

// =====================================================================
//  Arranque
// =====================================================================
async function iniciar() {
  aplicarTema(localStorage.getItem('ga-tema') || 'sistema');
  await db.cargar();
  if (!db.lista('areas', { incluirEliminados: true }).length && !localStorage.getItem('ga-iniciada')) {
    await agregarCategorias(['Pagos', 'Personal', 'Universidad', 'Maestría', 'Casa']);
  }
  localStorage.setItem('ga-iniciada', '1');
  if (!localStorage.getItem('ga-categorias-v1')) {
    const faltan = sugeridasFaltantes().filter(n => ['Pagos', 'Personal', 'Universidad', 'Maestría', 'Casa'].includes(n));
    await agregarCategorias(faltan);
    localStorage.setItem('ga-categorias-v1', '1');
  }

  pintarMarco();
  leerRuta();
  window.addEventListener('hashchange', leerRuta);
  document.addEventListener('click', alHacerClic);
  document.addEventListener('keydown', atajos);
  matchMedia('(min-width: 900px)').addEventListener('change', () => render());

  db.onChange(d => {
    if (d.silencioso && ui.vista === 'notas') { pintarListaNotas(); pintarLateral(); return; }
    if (ui.vista === 'notas') {
      pintarListaNotas();
      const ta = $('#nota-contenido');
      if (d.origen === 'remoto' && ui.notaId && document.activeElement !== ta && document.activeElement !== $('#nota-titulo')) pintarEditorNota();
      if (ui.notaId && !db.obtener('notas', ui.notaId)) { ui.notaId = null; pintarEditorNota(); }
    } else if (!$('dialog[open]')) {
      render();
    }
    pintarLateral();
  });

  sync.onEstado(pintarEstadoSync);
  sync.iniciarAutoSync();
  registrarSW();
  await procesarCompartido();

  // Acciones que llegan desde una notificación
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.tipo === 'aviso') manejarAccionAviso(e.data.tareaId, e.data.accion);
    if (e.data?.tipo === 'sincronizar') sync.sincronizar();
  });
  const qs = new URLSearchParams(location.search);
  if (qs.get('aviso')) {
    history.replaceState(null, '', location.pathname + '#/hoy');
    setTimeout(() => manejarAccionAviso(qs.get('aviso'), qs.get('accion') || 'abrir'), 300);
  }
  revisarAvisos();
  setInterval(revisarAvisos, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') revisarAvisos(); });

  // Volver a pintar al cambiar de día (la vista "Hoy" depende de la fecha)
  let diaActual = hoy();
  setInterval(() => { if (hoy() !== diaActual) { diaActual = hoy(); render(); } }, 60000);
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); eventoInstalar = e; if (ui.vista === 'ajustes') render(); });
}

function leerRuta() {
  const [, vista, id] = (location.hash || '#/hoy').split('/');
  const nueva = VISTAS[vista] ? vista : 'hoy';
  // Antes de salir de una nota: guardar lo escrito y descartar notas vacías
  if (ui.vista === 'notas' && ui.notaId && ui.notaId !== id) {
    const anterior = ui.notaId;
    guardarNotaYa(anterior).then(() => {
      const n = db.obtener('notas', anterior);
      if (n && !n.titulo.trim() && !(n.contenido || '').trim()) db.eliminar('notas', anterior);
    });
  }
  const seguirEnNotas = ui.vista === 'notas' && nueva === 'notas' && $('#editor-nota');
  ui.vista = nueva;
  if (ui.vista === 'notas') ui.notaId = id || null;
  if (seguirEnNotas) { pintarListaNotas(); pintarEditorNota(); actualizarFab(); return; }
  render();
  window.scrollTo(0, 0);
}

function actualizarFab() {
  const fab = $('#fab');
  fab.hidden = ui.vista === 'ajustes' || (ui.vista === 'notas' && !!ui.notaId && !escritorio());
  fab.setAttribute('aria-label', { hoy: 'Nueva tarea', tareas: 'Nueva tarea', habitos: 'Nuevo hábito', notas: 'Nueva nota', finanzas: ui.fpestana === 'deudas' ? 'Nueva deuda' : ui.fpestana === 'ahorros' ? 'Nuevo ahorro' : 'Registrar gasto o ingreso' }[ui.vista] || 'Agregar');
}

function ir(vista, id) {
  const destino = `#/${vista}${id ? '/' + id : ''}`;
  if (location.hash === destino) leerRuta();
  else location.hash = destino;
}

// =====================================================================
//  Marco: barra lateral (escritorio), cabecera y barra inferior (móvil)
// =====================================================================
function pintarMarco() {
  $('#nav-inferior').innerHTML = Object.entries(VISTAS).filter(([k]) => k !== 'ajustes').map(([k, v]) =>
    `<a href="#/${k}" data-vista="${k}">${v.icono}<span>${v.titulo}</span></a>`).join('');
  $('#nav-lateral').innerHTML = Object.entries(VISTAS).map(([k, v], i) =>
    `<a href="#/${k}" data-vista="${k}">${v.icono}<span>${v.titulo}</span><kbd>${i + 1}</kbd></a>`).join('');
}

function pintarLateral() {
  $$('[data-vista]').forEach(a => a.setAttribute('aria-current', a.dataset.vista === ui.vista ? 'page' : 'false'));
  const areas = areasOrdenadas();
  const pendientes = db.lista('tareas').filter(t => !t.completada);
  $('#lateral-areas').innerHTML = areas.map(a => {
    const n = pendientes.filter(t => t.areaId === a.id).length;
    const activa = ui.vista === 'tareas' && ui.areaId === a.id;
    return `<button class="area-link" data-accion="filtrar-area" data-id="${a.id}" aria-pressed="${activa}">
      <i class="punto" style="--c:${a.color}"></i><span>${esc(a.nombre)}</span><b>${n || ''}</b></button>`;
  }).join('') + `<button class="area-link tenue" data-accion="nueva-area">${I.mas}<span>Nueva categoría</span></button>`;
}

function pintarEstadoSync(e) {
  pintarIndicadores(e);
  const cambiaSesion = ['apagado', 'sin-sesion'].includes(e.fase) !== ['apagado', 'sin-sesion'].includes(pintarEstadoSync.ultimaFase);
  if (ui.vista === 'ajustes' && cambiaSesion && !$('dialog[open]') && !document.activeElement?.closest?.('#form-supabase, #form-login')) {
    pintarEstadoSync.ultimaFase = e.fase;
    render();
  }
  pintarEstadoSync.ultimaFase = e.fase;
}

function pintarIndicadores(e) {
  const textos = {
    apagado: ['Sin respaldo', 'Configura Supabase en Ajustes para respaldar tus datos', I.nubeOff],
    'sin-sesion': ['Inicia sesión', 'Entra con tu cuenta para respaldar', I.nubeOff],
    'sin-conexion': ['Sin conexión', e.mensaje, I.nubeOff],
    sincronizando: ['Sincronizando…', '', I.girar],
    listo: ['Respaldado', `Última vez ${haceCuanto(e.ultima)}`, I.nubeOk],
    error: ['Error al sincronizar', e.mensaje, I.nube],
  };
  const [titulo, detalle, icono] = textos[e.fase] || textos.apagado;
  for (const el of $$('.estado-sync')) {
    el.dataset.fase = e.fase;
    el.title = `${titulo}${detalle ? ': ' + detalle : ''}`;
    el.innerHTML = `${icono}<span class="estado-texto"><b>${titulo}</b>${detalle ? `<small>${esc(detalle)}</small>` : ''}</span>`;
  }
}

// =====================================================================
//  Render general
// =====================================================================
function render() {
  document.body.dataset.vista = ui.vista;
  $('#titulo-movil').textContent = ui.vista === 'hoy' ? fechaLarga(hoy()) : VISTAS[ui.vista].titulo;
  actualizarFab();
  ({ hoy: vistaHoy, tareas: vistaTareas, habitos: vistaHabitos, notas: vistaNotas, finanzas: vistaFinanzas, ajustes: vistaAjustes })[ui.vista]();
  pintarLateral();
}

const CATEGORIAS_SUGERIDAS = ['Pagos', 'Personal', 'Universidad', 'Maestría', 'Casa', 'Trabajo', 'Salud'];
const sugeridasFaltantes = () => { const ya = new Set(db.lista('areas').map(a => norm(a.nombre))); return CATEGORIAS_SUGERIDAS.filter(n => !ya.has(norm(n))); };

async function agregarCategorias(nombres) {
  const base = db.lista('areas').length;
  const usados = new Set(db.lista('areas').map(a => a.color));
  const libres = [...COLORES.filter(c => !usados.has(c)), ...COLORES];
  const nuevas = nombres.map((nombre, i) => ({ id: uid(), nombre, color: libres[i % libres.length], orden: base + i }));
  if (nuevas.length) await db.guardarVarios('areas', nuevas);
  return nuevas.length;
}

const areasOrdenadas = () => db.lista('areas').sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.nombre.localeCompare(b.nombre));
const area = id => (id ? db.obtener('areas', id) : null);

// ---------------------------------------------------------------------
//  Elementos de tarea
// ---------------------------------------------------------------------
function htmlTarea(t, { mostrarFecha = true } = {}) {
  const a = area(t.areaId);
  const meta = [];
  if (a) meta.push(`<span class="meta-area"><i class="punto" style="--c:${a.color}"></i>${esc(a.nombre)}</span>`);
  if (mostrarFecha && t.fecha) meta.push(`<span class="${esVencida(t) ? 'meta-vencida' : ''}">${fechaAmigable(t.fecha)}</span>`);
  if (t.hora) meta.push(`<span>${I.reloj}${horaAmigable(t.hora)}</span>`);
  if (t.recurrencia) meta.push(`<span title="${RECURRENCIAS[t.recurrencia]}">${I.repetir}${RECURRENCIAS[t.recurrencia]}</span>`);
  if (t.aviso?.activo && t.avisarEn && !t.completada) meta.push(`<span class="${avisoActivo(t) ? 'meta-aviso' : ''}">${I.campanaMini}${textoAviso(t)}</span>`);
  if (t.pago?.monto) meta.push(`<span>${I.moneda}${fin.pesos(t.pago.monto)}</span>`);
  if (t.notas) meta.push('<span class="meta-notas">con notas</span>');
  const subs = t.subtareas || [];
  const hechasSub = subs.filter(x => x.hecha).length;
  const abierta = ui.desplegadas.has(t.id);
  return `<li class="tarea prio-${t.prioridad || 'media'}${t.completada ? ' hecha' : ''}${esVencida(t) ? ' vencida' : ''}${subs.length ? ' con-subs' : ''}" data-id="${t.id}">
    <button class="check" data-accion="alternar-tarea" data-id="${t.id}" role="checkbox" aria-checked="${!!t.completada}" aria-label="Marcar «${esc(t.titulo)}» como ${t.completada ? 'pendiente' : 'hecha'}"></button>
    <button class="tarea-cuerpo" data-accion="editar-tarea" data-id="${t.id}">
      <span class="tarea-titulo"><span class="marca">${esc(t.titulo)}</span></span>
      ${meta.length ? `<span class="tarea-meta">${meta.join('')}</span>` : ''}
    </button>
    ${subs.length ? `<button class="sub-resumen${hechasSub === subs.length ? ' completas' : ''}" data-accion="desplegar-subs" data-id="${t.id}" aria-expanded="${abierta}" aria-label="${abierta ? 'Ocultar' : 'Ver'} subtareas: ${hechasSub} de ${subs.length} hechas">
      <span class="sub-anillo" style="--p:${Math.round((hechasSub / subs.length) * 100)}"></span>${hechasSub}/${subs.length}</button>` : ''}
    ${subs.length && abierta ? `<div class="subtareas">
      <ul>${subs.map(x => `<li class="${x.hecha ? 'hecha' : ''}">
        <button class="check-sub" data-accion="alternar-sub" data-id="${t.id}" data-valor="${x.id}" role="checkbox" aria-checked="${!!x.hecha}" aria-label="Marcar «${esc(x.titulo)}»"></button>
        <span>${esc(x.titulo)}</span></li>`).join('')}</ul>
      <form class="sub-nueva" data-form="sub-rapida" data-id="${t.id}">
        <input name="titulo" placeholder="Agregar subtarea" autocomplete="off" enterkeyhint="done" aria-label="Nueva subtarea de ${esc(t.titulo)}">
      </form>
    </div>` : ''}
  </li>`;
}

function filaSubDlg(x = { id: uid(), titulo: '', hecha: false }) {
  return `<li class="sub-dlg" data-sub="${x.id}">
    <input type="hidden" name="subId" value="${x.id}">
    <input type="checkbox" name="subHecha" value="${x.id}" ${x.hecha ? 'checked' : ''} aria-label="Hecha">
    <input name="subTitulo" value="${esc(x.titulo)}" aria-label="Subtarea" autocomplete="off">
    <button type="button" class="btn-icono" data-accion="quitar-sub-dlg" aria-label="Quitar subtarea">${I.cerrar}</button>
  </li>`;
}

async function alternarSub(tid, sid) {
  const t = db.obtener('tareas', tid);
  if (!t) return;
  const subtareas = (t.subtareas || []).map(x => (x.id === sid ? { ...x, hecha: !x.hecha } : x));
  ui.desplegadas.add(tid);
  await db.guardar('tareas', { ...t, subtareas });
  if (!t.completada && subtareas.length && subtareas.every(x => x.hecha)) {
    toast('Todas las subtareas están listas', { texto: 'Marcar la tarea hecha', fn: () => alternarTarea(tid) });
  }
}

function textoAviso(t) {
  if (avisoActivo(t)) return 'Aviso activo';
  const d = new Date(t.avisarEn);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `Aviso ${fechaAmigable(ymdLocal(t.avisarEn)).toLowerCase()} ${horaAmigable(hm)}`;
}

const listaTareas = (arr, opc) => `<ul class="lista-tareas">${arr.map(t => htmlTarea(t, opc)).join('')}</ul>`;

function capturaRapida(placeholder, contexto) {
  return `<form class="captura" data-form="captura" data-contexto="${contexto}">
    <span class="captura-mas" aria-hidden="true">${I.mas}</span>
    <input id="captura" name="texto" autocomplete="off" enterkeyhint="done" placeholder="${placeholder}" aria-label="Nueva tarea">
    <button class="btn btn-primario" type="submit">Agregar</button>
    <p class="captura-ayuda">Escribe <b>mañana</b>, <b>viernes</b>, <b>28/11</b> o <b>3pm</b> para fecha y hora, <b>#pagos</b> para la categoría y <b>!</b> para prioridad alta.</p>
  </form>`;
}

// =====================================================================
//  Vista: HOY
// =====================================================================
function vistaHoy() {
  const h = hoy();
  const d = parseYmd(h);
  const tareas = db.lista('tareas');
  const vencidas = tareas.filter(esVencida).sort(ordenarTareas);
  const deHoy = tareas.filter(t => !t.completada && t.fecha === h).sort(ordenarTareas);
  const hechasHoy = tareas.filter(t => t.completada && t.completadaEn && new Date(t.completadaEn).toDateString() === new Date().toDateString())
    .sort((a, b) => b.completadaEn - a.completadaEn);
  const habitos = db.lista('habitos').filter(x => tocaHoy(x)).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const conAviso = tareas.filter(t => avisoActivo(t)).sort((a, b) => a.avisarEn - b.avisarEn);
  const deudasProx = db.lista('deudas').filter(d => fin.deudaVencida(d) || fin.venceProntoDeuda(d)).sort((a, b) => a.vence.localeCompare(b.vence));
  const habHechos = habitos.filter(x => hecho(x, h)).length;
  const total = deHoy.length + hechasHoy.length;
  const hora = new Date().getHours();
  const saludo = hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches';

  let resumen;
  if (!total && !vencidas.length) resumen = 'No tienes tareas para hoy.';
  else if (!deHoy.length && !vencidas.length) resumen = `Terminaste las ${total} tareas de hoy.`;
  else resumen = `${hechasHoy.length} de ${total} tareas hechas${vencidas.length ? `, ${vencidas.length} atrasada${vencidas.length > 1 ? 's' : ''}` : ''}.`;

  $('#vista').innerHTML = `
    <section class="hoy-cabecera">
      <div class="fecha-grande" aria-hidden="true">
        <span class="dia-numero">${d.getDate()}</span>
        <span class="dia-texto"><span>${DIAS_NOMBRE[d.getDay()]}</span><span>${new Intl.DateTimeFormat('es-CO', { month: 'long' }).format(d)}</span></span>
      </div>
      <h1 class="sr-only">Hoy, ${fechaLarga(h)}</h1>
      <p class="hoy-resumen">${saludo}. ${resumen}</p>
      ${total ? `<div class="progreso" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${hechasHoy.length}" aria-label="Progreso del día"><span style="width:${Math.round((hechasHoy.length / total) * 100)}%"></span></div>` : ''}
    </section>
    ${conAviso.length ? `<section class="avisos" aria-label="Recordatorios activos">
      <h2>${I.campana}Recordatorios</h2>
      <ul>${conAviso.map(t => `<li>
        <button class="aviso-titulo" data-accion="editar-tarea" data-id="${t.id}"><b>${esc(t.titulo)}</b>
          <small>${t.pago?.monto ? fin.pesos(t.pago.monto) + ' · ' : ''}${t.fecha ? fechaAmigable(t.fecha) : ''}${t.hora ? ' ' + horaAmigable(t.hora) : ''}</small></button>
        <button class="btn" data-accion="posponer-dialogo" data-id="${t.id}">Posponer</button>
        <button class="btn btn-primario" data-accion="alternar-tarea" data-id="${t.id}">Hecha</button>
      </li>`).join('')}</ul></section>` : ''}
    ${capturaRapida('Agregar tarea para hoy', 'hoy')}
    <div class="hoy-columnas">
      <div class="hoy-tareas">
        ${vencidas.length ? `<section class="bloque bloque-vencidas"><h2>Atrasadas <span class="cuenta">${vencidas.length}</span></h2>
          ${listaTareas(vencidas)}
          <button class="btn btn-texto" data-accion="mover-vencidas">Pasar todas a hoy</button></section>` : ''}
        <section class="bloque"><h2>Para hoy <span class="cuenta">${deHoy.length}</span></h2>
          ${deHoy.length ? listaTareas(deHoy, { mostrarFecha: false }) : `<p class="vacio">${hechasHoy.length ? 'Todo listo por hoy.' : 'Escribe arriba lo primero que tengas que hacer hoy.'}</p>`}
        </section>
        ${hechasHoy.length ? `<section class="bloque bloque-hechas">
          <button class="btn btn-texto" data-accion="ver-hechas" aria-expanded="${ui.verHechasHoy}">${ui.verHechasHoy ? 'Ocultar' : 'Ver'} las ${hechasHoy.length} hechas hoy</button>
          ${ui.verHechasHoy ? listaTareas(hechasHoy, { mostrarFecha: false }) : ''}</section>` : ''}
      </div>
      <aside class="hoy-habitos bloque">
        <h2>Hábitos de hoy <span class="cuenta">${habHechos}/${habitos.length}</span></h2>
        ${habitos.length ? `<ul class="chips-habitos">${habitos.map(x => `
          <li><button class="chip-habito" data-accion="alternar-habito" data-id="${x.id}" data-fecha="${h}" aria-pressed="${hecho(x, h)}">
            <span class="chip-check" aria-hidden="true"></span><span>${esc(x.nombre)}</span>${racha(x) > 1 ? `<small>${racha(x)} días</small>` : ''}
          </button></li>`).join('')}</ul>`
        : `<p class="vacio">Sin hábitos para hoy. <a href="#/habitos">Crear un hábito</a></p>`}
        ${deudasProx.length ? `<h2 class="sub-aside">Pagos y cobros cercanos</h2>
          <ul class="mini-deudas">${deudasProx.map(d => `<li><button data-accion="abrir-deuda" data-id="${d.id}">
            <span><b>${d.sentido === 'debo' ? 'Pagar a' : 'Cobrar a'} ${esc(d.persona)}</b><small class="${fin.deudaVencida(d) ? 'meta-vencida' : ''}">${fin.deudaVencida(d) ? 'Venció ' : 'Vence '}${fechaAmigable(d.vence).toLowerCase()}</small></span>
            <span class="${d.sentido === 'debo' ? 'monto-gasto' : 'monto-ingreso'}">${fin.pesos(fin.saldo(d))}</span></button></li>`).join('')}</ul>` : ''}
      </aside>
    </div>`;
}

// =====================================================================
//  Vista: TAREAS
// =====================================================================
const FILTROS = { proximas: 'Próximas', hoy: 'Hoy', todas: 'Todas', sinfecha: 'Sin fecha', hechas: 'Hechas' };

function vistaTareas() {
  const h = hoy();
  let tareas = db.lista('tareas');
  if (ui.areaId) tareas = tareas.filter(t => t.areaId === ui.areaId);
  const f = ui.filtro;
  if (f === 'hechas') tareas = tareas.filter(t => t.completada).sort((a, b) => (b.completadaEn || 0) - (a.completadaEn || 0));
  else {
    tareas = tareas.filter(t => !t.completada);
    if (f === 'hoy') tareas = tareas.filter(t => t.fecha && t.fecha <= h);
    if (f === 'proximas') tareas = tareas.filter(t => t.fecha && t.fecha <= addDays(h, 7));
    if (f === 'sinfecha') tareas = tareas.filter(t => !t.fecha);
    tareas.sort(ordenarTareas);
  }

  // Agrupar por fecha
  const grupos = new Map();
  for (const t of tareas) {
    let clave;
    if (f === 'hechas') clave = t.completadaEn ? fechaAmigable(new Date(t.completadaEn).toISOString().slice(0, 10)) : 'Antes';
    else clave = !t.fecha ? 'Sin fecha' : t.fecha < h ? 'Atrasadas' : fechaAmigable(t.fecha);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(t);
  }
  const a = area(ui.areaId);
  const vacios = {
    proximas: 'No tienes tareas en los próximos 7 días.',
    hoy: 'Nada pendiente para hoy.',
    todas: 'No tienes tareas pendientes.',
    sinfecha: 'Todas tus tareas tienen fecha.',
    hechas: 'Aún no has completado tareas.',
  };

  $('#vista').innerHTML = `
    <header class="vista-cabecera">
      <h1>${a ? `<i class="punto grande" style="--c:${a.color}"></i>${esc(a.nombre)}` : 'Tareas'}</h1>
      ${a ? `<button class="btn btn-texto solo-escritorio" data-accion="quitar-area">Ver todas las categorías</button>` : ''}
      <div class="acciones"><button class="btn" data-accion="pegar-tareas">${I.importar}Pegar tareas</button></div>
    </header>
    ${capturaRapida(a ? `Agregar tarea en ${a.nombre}` : 'Agregar tarea', 'tareas')}
    <div class="filtros" role="tablist" aria-label="Filtrar tareas">
      ${Object.entries(FILTROS).map(([k, v]) => `<button role="tab" class="filtro" data-accion="filtro" data-valor="${k}" aria-selected="${f === k}">${v}</button>`).join('')}
    </div>
    <div class="filtros chips-cat solo-movil" role="group" aria-label="Filtrar por categoría">
      <button class="filtro" data-accion="quitar-area" aria-pressed="${!ui.areaId}">Todas</button>
      ${areasOrdenadas().map(x => `<button class="filtro" data-accion="filtrar-area" data-id="${x.id}" aria-pressed="${x.id === ui.areaId}"><i class="punto" style="--c:${x.color}"></i>${esc(x.nombre)}</button>`).join('')}
    </div>
    ${tareas.length ? [...grupos].map(([k, arr]) => `
      <section class="bloque ${k === 'Atrasadas' ? 'bloque-vencidas' : ''}"><h2>${k} <span class="cuenta">${arr.length}</span></h2>
        ${listaTareas(arr, { mostrarFecha: k === 'Atrasadas' || f === 'hechas' })}</section>`).join('')
      : `<p class="vacio grande">${vacios[f]}</p>`}`;
  $('.chips-cat [aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// ---------------------------------------------------------------------
//  Diálogo de tarea
// ---------------------------------------------------------------------
function abrirTarea(id, valores = {}) {
  const t = id ? db.obtener('tareas', id) : { id: uid(), titulo: '', notas: '', prioridad: 'media', fecha: ui.vista === 'hoy' ? hoy() : null, hora: null, recurrencia: '', areaId: ui.vista === 'tareas' ? ui.areaId : null, ...valores };
  const nueva = !id;
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="tarea" data-id="${t.id}" data-nueva="${nueva}">
      <header class="dlg-cabecera"><h2>${nueva ? 'Nueva tarea' : 'Editar tarea'}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <label class="campo"><span>Qué hay que hacer</span><input name="titulo" required value="${esc(t.titulo)}" autocomplete="off"></label>
      <div class="fila-campos">
        <label class="campo"><span>Fecha</span><input type="date" name="fecha" value="${t.fecha || ''}"></label>
        <label class="campo"><span>Hora</span><input type="time" name="hora" value="${t.hora || ''}"></label>
      </div>
      <div class="fila-campos">
        <label class="campo"><span>Categoría</span><select name="areaId"><option value="">Sin categoría</option>
          ${areasOrdenadas().map(a => `<option value="${a.id}" ${a.id === t.areaId ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
        <label class="campo"><span>Repetir</span><select name="recurrencia">
          ${Object.entries(RECURRENCIAS).map(([k, v]) => `<option value="${k}" ${k === (t.recurrencia || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <div class="campo"><span id="lbl-prio">Prioridad</span><div class="segmentado" role="radiogroup" aria-labelledby="lbl-prio">
        ${['alta', 'media', 'baja'].map(p => `<label><input type="radio" name="prioridad" value="${p}" ${p === (t.prioridad || 'media') ? 'checked' : ''}><span>${p[0].toUpperCase() + p.slice(1)}</span></label>`).join('')}
      </div></div>
      <section class="subseccion">
        <h3>Subtareas</h3>
        <ul class="lista-sub-dlg" id="lista-sub-dlg">${(t.subtareas || []).map(filaSubDlg).join('')}</ul>
        <div class="sub-agregar">
          <input id="nueva-sub" placeholder="Agregar subtarea y pulsar Enter" autocomplete="off" enterkeyhint="enter" aria-label="Nueva subtarea">
          <button type="button" class="btn" data-accion="agregar-sub-dlg">${I.mas}Agregar</button>
        </div>
      </section>
      <section class="subseccion aviso-config">
        <label class="interruptor"><input type="checkbox" name="avisoActivo" ${t.aviso?.activo ? 'checked' : ''}><span class="interruptor-pista" aria-hidden="true"></span>
          <span><b>Avisarme</b><small>Notificación que se repite hasta que marques la tarea como hecha</small></span></label>
        <div class="aviso-campos">
          <div class="fila-campos">
            <label class="campo"><span>Cuándo</span><select name="avisoDias">
              ${Object.entries(DIAS_ANTES).map(([k, v]) => `<option value="${k}" ${Number(k) === Number(t.aviso?.diasAntes || 0) ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            <label class="campo"><span>A qué hora</span><input type="time" name="avisoHora" value="${t.aviso?.hora || t.hora || '08:00'}"></label>
          </div>
          <label class="campo"><span>Si no la marco, repetir el aviso</span><select name="avisoRepetir">
            ${Object.entries(REPETIR_AVISO).map(([k, v]) => `<option value="${k}" ${Number(k) === Number(t.aviso?.repetirMin || 60) ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          ${t.avisarEn && !t.completada && t.aviso?.activo ? `<p class="ayuda">Próximo aviso: ${esc(textoAviso(t).replace(/^Aviso /, ''))}</p>` : ''}
        </div>
      </section>
      <section class="subseccion">
        <div class="fila-campos">
          <label class="campo"><span>Valor a pagar (opcional)</span><input name="pagoMonto" inputmode="numeric" data-monto placeholder="$ 0" value="${t.pago?.monto ? fin.numero(t.pago.monto) : ''}" autocomplete="off"></label>
          <label class="campo"><span>Categoría del gasto</span><select name="pagoCategoria">
            ${fin.CATEGORIAS_GASTO.map(c => `<option ${c === (t.pago?.categoria || 'Servicios') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        </div>
        <p class="ayuda">Si pones un valor, al marcarla como hecha te pregunta cuánto pagaste y lo registra en Finanzas.</p>
      </section>
      <label class="campo"><span>Notas</span><textarea name="notas" rows="3">${esc(t.notas || '')}</textarea></label>
      <footer class="dlg-pie">
        ${nueva ? '' : `<button type="button" class="btn btn-peligro" data-accion="eliminar-tarea" data-id="${t.id}">${I.basura}Eliminar</button>`}
        <span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">${nueva ? 'Crear tarea' : 'Guardar cambios'}</button>
      </footer>
    </form>`);
  if (nueva) setTimeout(() => $('#dlg input[name=titulo]')?.focus(), 50);
}

async function guardarTareaDesdeForm(form) {
  const fd = new FormData(form);
  const previa = db.obtener('tareas', form.dataset.id) || { id: form.dataset.id, completada: false };
  const t = {
    ...previa,
    titulo: fd.get('titulo').trim(),
    fecha: fd.get('fecha') || null,
    hora: fd.get('hora') || null,
    areaId: fd.get('areaId') || null,
    recurrencia: fd.get('recurrencia') || '',
    prioridad: fd.get('prioridad') || 'media',
    notas: fd.get('notas').trim(),
    subtareas: (() => {
      const ids = fd.getAll('subId'), titulos = fd.getAll('subTitulo'), hechas = new Set(fd.getAll('subHecha'));
      const pendiente = $('#nueva-sub')?.value.trim();
      const lista = ids.map((id, i) => ({ id, titulo: String(titulos[i] || '').trim(), hecha: hechas.has(id) })).filter(x => x.titulo);
      if (pendiente) lista.push({ id: uid(), titulo: pendiente, hecha: false });
      return lista;
    })(),
    aviso: { activo: fd.get('avisoActivo') === 'on', diasAntes: Number(fd.get('avisoDias')) || 0, hora: fd.get('avisoHora') || '08:00', repetirMin: Number(fd.get('avisoRepetir')) || 60 },
    pago: { monto: fin.leerMonto(fd.get('pagoMonto')), categoria: fd.get('pagoCategoria') || 'Servicios' },
  };
  if ((t.recurrencia || t.aviso.activo) && !t.fecha) t.fecha = hoy();
  if (t.pago.monto && !t.areaId) t.areaId = db.lista('areas').find(a => norm(a.nombre) === 'pagos')?.id || null;
  if (!t.titulo) return;
  t.avisarEn = calcularAvisarEn(t);
  cerrarDialogo();
  await db.guardar('tareas', t);
  if (t.aviso.activo && avisos.permiso() === 'default') {
    toast('Tarea guardada. Permite las notificaciones para recibir el aviso.', { texto: 'Permitir', fn: () => avisos.pedirPermiso().then(() => render()) });
  } else if (t.aviso.activo && avisos.permiso() === 'denied') {
    toast('Tarea guardada, pero las notificaciones están bloqueadas en el navegador.');
  } else {
    toast(form.dataset.nueva === 'true' ? 'Tarea creada' : 'Cambios guardados');
  }
  revisarAvisos();
}

async function alternarTarea(id, boton) {
  const t = db.obtener('tareas', id);
  if (!t) return;
  if (t.completada) {
    const r = { ...t, completada: false, completadaEn: null };
    r.avisarEn = calcularAvisarEn(r);
    return db.guardar('tareas', r);
  }
  if (t.pago?.monto) return abrirPagoTarea(t);
  return completarTarea(t);
}

async function completarTarea(t, gasto = null) {
  const li = $(`.tarea[data-id="${t.id}"]`);
  li?.classList.add('tachando');
  await new Promise(r => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420));
  const previa = { ...t };
  let mov = null;
  if (gasto?.monto) {
    mov = { id: uid(), clase: 'gasto', monto: gasto.monto, categoria: gasto.categoria || 'Servicios', descripcion: t.titulo, fecha: hoy(), tareaId: t.id };
    await db.guardar('movimientos', mov);
  }
  let msg;
  if (t.recurrencia) {
    const prox = proximaFecha(t.fecha, t.recurrencia);
    const n = { ...t, fecha: prox, vecesHecha: (t.vecesHecha || 0) + 1, ultimaVez: Date.now(), subtareas: (t.subtareas || []).map(x => ({ ...x, hecha: false })) };
    n.avisarEn = calcularAvisarEn(n);
    await db.guardar('tareas', n);
    msg = `Hecha. Se repite ${fechaAmigable(prox).toLowerCase()}`;
  } else {
    await db.guardar('tareas', { ...t, completada: true, completadaEn: Date.now(), avisarEn: null });
    msg = 'Tarea hecha';
  }
  if (mov) msg += `. Gasto de ${fin.pesos(mov.monto)} registrado`;
  avisos.cerrarNotificacion(t.id);
  toast(msg, { texto: 'Deshacer', fn: async () => { await db.guardar('tareas', previa); if (mov) await db.eliminar('movimientos', mov.id); } });
}

function agregarSubDlg() {
  const inp = $('#nueva-sub');
  const titulo = inp?.value.trim();
  if (!titulo) return inp?.focus();
  $('#lista-sub-dlg').insertAdjacentHTML('beforeend', filaSubDlg({ id: uid(), titulo, hecha: false }));
  inp.value = '';
  inp.focus();
}

function abrirPagoTarea(t) {
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="pago-tarea" data-id="${t.id}">
      <header class="dlg-cabecera"><h2>${esc(t.titulo)}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <label class="campo"><span>¿Cuánto pagaste?</span><input name="monto" class="monto-grande" inputmode="numeric" data-monto value="${fin.numero(t.pago.monto)}" autocomplete="off"></label>
      <label class="campo"><span>Categoría</span><select name="categoria">
        ${fin.CATEGORIAS_GASTO.map(c => `<option ${c === (t.pago.categoria || 'Servicios') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <footer class="dlg-pie">
        <button type="submit" class="btn" name="modo" value="sin">Solo marcar hecha</button>
        <span class="separador"></span>
        <button type="submit" class="btn btn-primario" name="modo" value="con">Registrar gasto y marcar hecha</button>
      </footer>
    </form>`);
  setTimeout(() => { const i = $('#dlg input[name=monto]'); i?.focus(); i?.select(); }, 50);
}

async function agregarRapido(form) {
  const input = form.texto;
  const texto = input.value.trim();
  if (!texto) return;
  const p = parsearRapido(texto, areasOrdenadas());
  if (!p.titulo) return;
  const t = {
    id: uid(), titulo: p.titulo, notas: '', prioridad: p.prioridad, hora: p.hora, recurrencia: '', completada: false,
    areaId: p.areaId || (form.dataset.contexto === 'tareas' ? ui.areaId : null) || null,
    fecha: p.fecha || (form.dataset.contexto === 'hoy' || p.hora ? hoy() : null),
  };
  await db.guardar('tareas', t);
  $('#captura')?.focus();
  toast(t.fecha ? `Agregada para ${fechaAmigable(t.fecha).toLowerCase()}${t.hora ? ' a las ' + horaAmigable(t.hora) : ''}` : 'Agregada sin fecha');
}

// ---------------------------------------------------------------------
//  Recordatorios: posponer y acciones desde la notificación
// ---------------------------------------------------------------------
async function posponer(id, minutos, hasta = null) {
  const t = db.obtener('tareas', id);
  if (!t) return;
  const cuando = hasta || Date.now() + minutos * 60000;
  await db.guardar('tareas', { ...t, avisarEn: cuando, aviso: { ...(t.aviso || {}), activo: true } });
  avisos.cerrarNotificacion(id);
  const d = new Date(cuando);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  toast(`Te avisaré ${fechaAmigable(ymdLocal(cuando)).toLowerCase()} a las ${horaAmigable(hm)}`);
}

function abrirPosponer(id) {
  const t = db.obtener('tareas', id);
  if (!t) return toast('Esa tarea ya no existe.');
  const h = new Date().getHours();
  const opciones = [[15, '15 minutos'], [60, '1 hora'], [180, '3 horas']];
  const manana = new Date(); manana.setDate(manana.getDate() + 1); manana.setHours(8, 0, 0, 0);
  const noche = new Date(); noche.setHours(20, 0, 0, 0);
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="posponer" data-id="${t.id}">
      <header class="dlg-cabecera"><h2>${esc(t.titulo)}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <p class="ayuda">¿Cuándo te lo recuerdo de nuevo?</p>
      <div class="opciones-posponer">
        ${opciones.map(([m, txt]) => `<button type="button" class="btn" data-accion="posponer" data-id="${t.id}" data-valor="${m}">En ${txt}</button>`).join('')}
        ${h < 19 ? `<button type="button" class="btn" data-accion="posponer-hasta" data-id="${t.id}" data-valor="${noche.getTime()}">Esta noche, 8:00 p. m.</button>` : ''}
        <button type="button" class="btn" data-accion="posponer-hasta" data-id="${t.id}" data-valor="${manana.getTime()}">Mañana, 8:00 a. m.</button>
      </div>
      <label class="campo"><span>Otra fecha y hora</span><input type="datetime-local" name="cuando" min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}"></label>
      <footer class="dlg-pie">
        <button type="submit" class="btn">Posponer hasta esa fecha</button>
        <span class="separador"></span>
        <button type="button" class="btn btn-primario" data-accion="hecha-desde-aviso" data-id="${t.id}">Marcar hecha</button>
      </footer>
    </form>`);
}

async function manejarAccionAviso(tareaId, accion) {
  const t = db.obtener('tareas', tareaId);
  if (!t) return toast('Esa tarea ya no existe.');
  if (ui.vista !== 'hoy') ir('hoy');
  if (accion === 'hecha') return t.completada ? toast('Esa tarea ya estaba hecha.') : alternarTarea(tareaId);
  if (accion === 'posponer') return posponer(tareaId, 60);
  return abrirPosponer(tareaId);
}

let avisosVistos = '';
/** Revisa avisos vencidos: muestra notificación local (si no hay push) y actualiza la vista Hoy */
async function revisarAvisos() {
  const activos = db.lista('tareas').filter(t => avisoActivo(t));
  const firma = activos.map(t => t.id + t.avisarEn).join();
  if (firma !== avisosVistos) { avisosVistos = firma; if (ui.vista === 'hoy' && !$('dialog[open]')) render(); }
  if (avisos.pushActivo() && navigator.onLine) return; // el servidor se encarga
  for (const t of activos) {
    await avisos.mostrarLocal(t, { cuerpo: [t.fecha ? fechaAmigable(t.fecha) : '', t.hora ? horaAmigable(t.hora) : '', t.pago?.monto ? fin.pesos(t.pago.monto) : ''].filter(Boolean).join(' · ') }).catch(() => {});
  }
}

// =====================================================================
//  Vista: FINANZAS
// =====================================================================
const colorCategoria = c => COLORES[Math.abs([...String(c)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)) % COLORES.length];

function vistaFinanzas() {
  const movs = db.lista('movimientos');
  const deudas = db.lista('deudas');
  const ahorros = db.lista('ahorros');
  const pendientes = deudas.filter(d => !fin.saldada(d));
  const botones = {
    mes: `<button class="btn" data-accion="nuevo-mov" data-valor="ingreso">${I.mas}Ingreso</button><button class="btn btn-primario" data-accion="nuevo-mov" data-valor="gasto">${I.mas}Gasto</button>`,
    deudas: `<button class="btn btn-primario" data-accion="nueva-deuda">${I.mas}Nueva deuda</button>`,
    ahorros: `<button class="btn btn-primario" data-accion="nuevo-ahorro">${I.mas}Nuevo ahorro</button>`,
  };
  $('#vista').innerHTML = `
    <header class="vista-cabecera"><h1>Finanzas</h1>
      <div class="acciones solo-escritorio">${botones[ui.fpestana] || ''}</div></header>
    <div class="filtros" role="tablist" aria-label="Sección de finanzas">
      <button role="tab" class="filtro" data-accion="fpestana" data-valor="mes" aria-selected="${ui.fpestana === 'mes'}">Gastos e ingresos</button>
      <button role="tab" class="filtro" data-accion="fpestana" data-valor="deudas" aria-selected="${ui.fpestana === 'deudas'}">Deudas ${pendientes.length ? `<span class="cuenta">${pendientes.length}</span>` : ''}</button>
      <button role="tab" class="filtro" data-accion="fpestana" data-valor="ahorros" aria-selected="${ui.fpestana === 'ahorros'}">Ahorros ${ahorros.length ? `<span class="cuenta">${ahorros.length}</span>` : ''}</button>
    </div>
    ${ui.fpestana === 'deudas' ? htmlDeudas(deudas) : ui.fpestana === 'ahorros' ? htmlAhorros(ahorros) : htmlMes(movs)}`;
}

function htmlMes(movs) {
  const mes = ui.fmes;
  const r = fin.resumenMes(movs, mes);
  const base = fin.saldoBase(movs);
  const disp = fin.disponible(movs, mes);
  const ant = fin.resumenMes(movs, fin.moverMes(mes, -1));
  let comparacion = '';
  if (ant.gastos > 0 && r.gastos > 0) {
    const dif = Math.round(((r.gastos - ant.gastos) / ant.gastos) * 100);
    comparacion = dif === 0 ? 'Gastaste lo mismo que el mes anterior.' : `Gastaste ${Math.abs(dif)}% ${dif > 0 ? 'más' : 'menos'} que el mes anterior.`;
  }
  const max = r.categorias[0]?.[1] || 1;
  // Colores distintos por categoría según su peso en el mes
  const colores = new Map(r.categorias.map(([c], i) => [c, COLORES[i % COLORES.length]]));
  const colorCategoria = c => colores.get(c) || COLORES[COLORES.length - 1];
  const porDia = new Map();
  for (const m of r.delMes.sort((a, b) => b.fecha.localeCompare(a.fecha) || (b.creadoEn || 0) - (a.creadoEn || 0))) {
    if (!porDia.has(m.fecha)) porDia.set(m.fecha, []);
    porDia.get(m.fecha).push(m);
  }
  return `
    <div class="mes-nav">
      <button class="btn-icono" data-accion="fmes" data-valor="-1" aria-label="Mes anterior">${I.izq}</button>
      <h2>${fin.nombreMes(mes)}</h2>
      <button class="btn-icono" data-accion="fmes" data-valor="1" aria-label="Mes siguiente">${I.der}</button>
      ${mes !== fin.mesActual() ? `<button class="btn btn-texto" data-accion="fmes" data-valor="0">Ir al mes actual</button>` : ''}
    </div>
    <dl class="resumen-mes">
      <div><dt>Ingresos del mes</dt><dd class="monto-ingreso">${fin.pesos(r.ingresos)}</dd></div>
      <div><dt>Gastos del mes</dt><dd class="monto-gasto">${fin.pesos(r.gastos)}</dd></div>
      ${disp !== null
        ? `<div class="disponible"><dt>Disponible ${mes === fin.mesActual() ? 'hoy' : 'al cierre del mes'}</dt><dd class="${disp < 0 ? 'negativo' : ''}">${fin.pesos(disp)}</dd>
            <button class="btn-base" data-accion="saldo-base">Saldo inicial ${fin.pesos(base.monto)} ${base.fecha === hoy() ? 'hoy' : 'el ' + fechaAmigable(base.fecha).toLowerCase()} · Cambiar</button></div>`
        : base
          ? `<div class="disponible"><dt>Balance del mes</dt><dd class="${r.balance < 0 ? 'negativo' : ''}">${fin.pesos(r.balance)}</dd>
              <span class="btn-base">Este mes es anterior a tu saldo inicial</span></div>`
          : `<div class="disponible sin-base"><dt>Disponible</dt><dd>¿Cuánto tienes hoy?</dd>
              <button class="btn" data-accion="saldo-base">Ingresar saldo actual</button></div>`}
    </dl>
    ${disp !== null ? `<p class="ayuda">Balance del mes: <b class="${r.balance < 0 ? 'monto-gasto' : 'monto-ingreso'}">${r.balance < 0 ? '−' : '+'}${fin.pesos(Math.abs(r.balance))}</b>${comparacion ? '. ' + comparacion : ''}</p>` : comparacion ? `<p class="ayuda">${comparacion}</p>` : ''}
    <div class="fin-columnas">
      <section class="bloque"><h2>Movimientos <span class="cuenta">${r.delMes.length}</span></h2>
        ${porDia.size ? [...porDia].map(([f, arr]) => `
          <h3 class="dia-mov">${fechaAmigable(f)}</h3>
          <ul class="lista-movs">${arr.map(m => `<li><button class="mov" data-accion="editar-mov" data-id="${m.id}">
            <i class="punto" style="--c:${colorCategoria(m.categoria)}"></i>
            <span class="mov-texto"><b>${esc(m.descripcion || m.categoria || (m.clase === 'gasto' ? 'Gasto' : 'Ingreso'))}</b><small>${esc(m.categoria || '')}</small></span>
            <span class="${m.clase === 'gasto' ? 'monto-gasto' : 'monto-ingreso'}">${m.clase === 'gasto' ? '−' : '+'}${fin.pesos(m.monto)}</span>
          </button></li>`).join('')}</ul>`).join('')
        : `<div class="vacio grande"><p>No hay movimientos en ${fin.nombreMes(mes).toLowerCase()}.</p>
            <div class="fila-botones"><button class="btn btn-primario" data-accion="nuevo-mov" data-valor="gasto">Registrar un gasto</button>
            <button class="btn" data-accion="nuevo-mov" data-valor="ingreso">Registrar un ingreso</button></div></div>`}
      </section>
      <aside class="bloque">
        <h2>En qué se fue la plata</h2>
        ${r.categorias.length ? `<ul class="categorias">${r.categorias.map(([c, v]) => `<li>
          <span class="cat-nombre"><i class="punto" style="--c:${colorCategoria(c)}"></i>${esc(c)}</span>
          <span class="cat-valor">${fin.pesos(v)} <small>${Math.round((v / r.gastos) * 100)}%</small></span>
          <span class="cat-barra"><span style="width:${(v / max) * 100}%;--c:${colorCategoria(c)}"></span></span></li>`).join('')}</ul>`
        : '<p class="vacio">Aún no hay gastos este mes.</p>'}
        <button class="btn btn-texto" data-accion="exportar-csv">${I.exportar}Descargar movimientos del mes (.csv)</button>
      </aside>
    </div>`;
}

function htmlDeuda(d) {
  const total = Number(d.monto) || 0;
  const pagado = fin.abonado(d);
  const venc = fin.deudaVencida(d);
  return `<li class="deuda${fin.saldada(d) ? ' saldada' : ''}">
    <button class="deuda-info" data-accion="abrir-deuda" data-id="${d.id}">
      <b>${esc(d.persona)}</b>
      ${d.concepto ? `<small>${esc(d.concepto)}</small>` : ''}
      <span class="deuda-saldo">${fin.saldada(d) ? 'Saldada' : `${fin.pesos(fin.saldo(d))} <small>de ${fin.pesos(total)}</small>`}</span>
      <span class="progreso"><span style="width:${total ? Math.min(100, (pagado / total) * 100) : 0}%"></span></span>
      ${d.vence && !fin.saldada(d) ? `<small class="${venc ? 'meta-vencida' : ''}">${venc ? 'Venció' : 'Vence'} ${fechaAmigable(d.vence).toLowerCase()}</small>` : ''}
    </button>
    ${fin.saldada(d) ? '' : `<button class="btn" data-accion="abonar" data-id="${d.id}">${d.sentido === 'debo' ? 'Abonar' : 'Recibí un pago'}</button>`}
  </li>`;
}

function htmlDeudas(deudas) {
  const grupo = (sentido, titulo, vacio) => {
    const todas = deudas.filter(d => d.sentido === sentido);
    const pend = todas.filter(d => !fin.saldada(d)).sort((a, b) => (a.vence || '9999').localeCompare(b.vence || '9999'));
    const listas = todas.filter(d => fin.saldada(d));
    const total = pend.reduce((s, d) => s + fin.saldo(d), 0);
    return `<section class="bloque grupo-deudas">
      <h2>${titulo}</h2>
      <p class="total-deuda ${sentido === 'debo' ? 'monto-gasto' : 'monto-ingreso'}">${fin.pesos(total)}</p>
      ${pend.length ? `<ul class="lista-deudas">${pend.map(htmlDeuda).join('')}</ul>` : `<p class="vacio">${vacio}</p>`}
      ${listas.length ? `<button class="btn btn-texto" data-accion="ver-saldadas">${ui.verSaldadas ? 'Ocultar' : 'Ver'} ${listas.length} saldada${listas.length > 1 ? 's' : ''}</button>
        ${ui.verSaldadas ? `<ul class="lista-deudas">${listas.map(htmlDeuda).join('')}</ul>` : ''}` : ''}
    </section>`;
  };
  return `<div class="fin-columnas deudas">
    ${grupo('debo', 'Lo que debo', 'No tienes deudas pendientes.')}
    ${grupo('meDeben', 'Lo que me deben', 'Nadie te debe dinero.')}
  </div>
  <button class="btn btn-primario solo-movil" data-accion="nueva-deuda">${I.mas}Nueva deuda</button>`;
}

function htmlAhorros(ahorros) {
  const lista = ahorros.slice().sort((a, b) => (b.monto || 0) - (a.monto || 0));
  const total = fin.totalAhorros(lista);
  return `
    <section class="bloque">
      <h2>Total ahorrado</h2>
      <p class="total-deuda monto-ingreso">${fin.pesos(total)}</p>
      ${lista.length ? `<ul class="lista-deudas">${lista.map(a => {
        const av = fin.avanceMeta(a);
        return `<li class="deuda">
          <button class="deuda-info" data-accion="editar-ahorro" data-id="${a.id}">
            <b>${esc(a.nombre)}</b>
            ${a.nota ? `<small>${esc(a.nota)}</small>` : ''}
            <span class="deuda-saldo">${fin.pesos(a.monto)}${a.meta ? ` <small>de ${fin.pesos(a.meta)} · ${av}%</small>` : ''}</span>
            ${a.meta ? `<span class="progreso"><span style="width:${av}%"></span></span>` : ''}
          </button>
          <button class="btn" data-accion="aporte-ahorro" data-id="${a.id}">Agregar</button>
        </li>`;
      }).join('')}</ul>`
      : `<div class="vacio grande"><p>Registra dónde tienes tus ahorros y cuánto hay en cada uno: cuenta de ahorros, CDT, alcancía, fondo de emergencia…</p>
          <button class="btn btn-primario" data-accion="nuevo-ahorro">Agregar un ahorro</button></div>`}
    </section>
    ${lista.length ? `<button class="btn btn-primario solo-movil" data-accion="nuevo-ahorro">${I.mas}Nuevo ahorro</button>` : ''}`;
}

function abrirSaldoBase() {
  const base = fin.saldoBase(db.lista('movimientos'));
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="saldo-base">
      <header class="dlg-cabecera"><h2>Saldo actual</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <p class="ayuda">Escribe cuánto dinero tienes disponible (efectivo y cuentas, sin contar ahorros). Desde esa fecha la app suma tus ingresos y resta tus gastos.</p>
      <label class="campo"><span>Valor disponible</span><input name="monto" class="monto-grande" inputmode="numeric" data-monto required value="${base ? fin.numero(base.monto) : ''}" placeholder="$ 0" autocomplete="off"></label>
      <label class="campo"><span>A la fecha</span><input type="date" name="fecha" required value="${hoy()}" max="${hoy()}"></label>
      <p class="ayuda">Los movimientos anteriores a esa fecha no cambian el disponible.</p>
      <footer class="dlg-pie"><span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">Guardar saldo</button></footer>
    </form>`);
  setTimeout(() => { const i = $('#dlg input[name=monto]'); i?.focus(); i?.select(); }, 50);
}

function abrirAhorro(id) {
  const a = id ? db.obtener('ahorros', id) : { id: uid(), nombre: '', monto: 0, meta: 0, nota: '', historial: [] };
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="ahorro" data-id="${a.id}">
      <header class="dlg-cabecera"><h2>${id ? 'Ahorro' : 'Nuevo ahorro'}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <label class="campo"><span>Nombre</span><input name="nombre" required value="${esc(a.nombre)}" placeholder="Cuenta de ahorros, CDT, fondo de emergencia…" autocomplete="off"></label>
      <label class="campo"><span>Valor actual</span><input name="monto" class="monto-grande" inputmode="numeric" data-monto value="${a.monto ? fin.numero(a.monto) : ''}" placeholder="$ 0" autocomplete="off"></label>
      <div class="fila-campos">
        <label class="campo"><span>Meta (opcional)</span><input name="meta" inputmode="numeric" data-monto value="${a.meta ? fin.numero(a.meta) : ''}" placeholder="$ 0" autocomplete="off"></label>
        <label class="campo"><span>Nota</span><input name="nota" value="${esc(a.nota || '')}" placeholder="Banco, plazo…" autocomplete="off"></label>
      </div>
      ${id && a.historial?.length ? `<section class="subseccion"><h3>Movimientos</h3>
        <ul class="lista-abonos">${a.historial.slice().sort((x, y) => y.fecha.localeCompare(x.fecha)).slice(0, 12).map(h => `<li>
          <span>${fechaAmigable(h.fecha)}${h.nota ? ' · ' + esc(h.nota) : ''}</span><b class="${h.monto < 0 ? 'monto-gasto' : 'monto-ingreso'}">${h.monto < 0 ? '−' : '+'}${fin.pesos(Math.abs(h.monto))}</b></li>`).join('')}</ul></section>` : ''}
      <footer class="dlg-pie">
        ${id ? `<button type="button" class="btn btn-peligro" data-accion="eliminar-ahorro" data-id="${a.id}">${I.basura}Eliminar</button>` : ''}
        <span class="separador"></span>
        ${id ? `<button type="button" class="btn" data-accion="aporte-ahorro" data-id="${a.id}">Agregar o retirar</button>` : ''}
        <button type="submit" class="btn btn-primario">${id ? 'Guardar cambios' : 'Agregar ahorro'}</button>
      </footer>
    </form>`);
  if (!id) setTimeout(() => $('#dlg input[name=nombre]')?.focus(), 50);
}

function abrirAporte(id) {
  const a = db.obtener('ahorros', id);
  if (!a) return;
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="aporte" data-id="${a.id}">
      <header class="dlg-cabecera"><h2>${esc(a.nombre)}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <p class="ayuda">Valor actual: <b>${fin.pesos(a.monto)}</b></p>
      <div class="segmentado" role="radiogroup" aria-label="Tipo de movimiento">
        <label><input type="radio" name="tipo" value="agregar" checked data-cambio="tipo-aporte"><span>Agregar dinero</span></label>
        <label><input type="radio" name="tipo" value="retirar" data-cambio="tipo-aporte"><span>Retirar</span></label>
      </div>
      <label class="campo"><span>Valor</span><input name="monto" class="monto-grande" inputmode="numeric" data-monto required placeholder="$ 0" autocomplete="off"></label>
      <div class="fila-campos">
        <label class="campo"><span>Fecha</span><input type="date" name="fecha" value="${hoy()}"></label>
        <label class="campo"><span>Nota</span><input name="nota" placeholder="Quincena, imprevisto…" autocomplete="off"></label>
      </div>
      <label class="casilla"><input type="checkbox" name="registrar" checked><span id="txt-registrar">Descontarlo del disponible (se registra como gasto «Ahorro»)</span></label>
      <footer class="dlg-pie"><span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">Guardar</button></footer>
    </form>`);
  setTimeout(() => $('#dlg input[name=monto]')?.focus(), 50);
}

function opcionesCategorias(clase, actual) {
  const lista = clase === 'ingreso' ? fin.CATEGORIAS_INGRESO : fin.CATEGORIAS_GASTO;
  const todas = actual && !lista.includes(actual) ? [...lista, actual] : lista;
  return todas.map(c => `<option ${c === actual ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

function abrirMovimiento(id, clase = 'gasto') {
  const m = id ? db.obtener('movimientos', id) : {
    id: uid(), clase, monto: 0, categoria: clase === 'gasto' ? 'Alimentación' : 'Salario', descripcion: '',
    fecha: ui.fmes === fin.mesActual() ? hoy() : ui.fmes + '-01',
  };
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="movimiento" data-id="${m.id}">
      <header class="dlg-cabecera"><h2>${id ? 'Editar movimiento' : 'Registrar'}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <div class="segmentado" role="radiogroup" aria-label="Tipo de movimiento">
        <label><input type="radio" name="clase" value="gasto" data-cambio="clase-mov" ${m.clase === 'gasto' ? 'checked' : ''}><span>Gasto</span></label>
        <label><input type="radio" name="clase" value="ingreso" data-cambio="clase-mov" ${m.clase === 'ingreso' ? 'checked' : ''}><span>Ingreso</span></label>
      </div>
      <label class="campo"><span>Valor</span><input name="monto" class="monto-grande" inputmode="numeric" data-monto required value="${m.monto ? fin.numero(m.monto) : ''}" placeholder="$ 0" autocomplete="off"></label>
      <div class="fila-campos">
        <label class="campo"><span>Categoría</span><select name="categoria">${opcionesCategorias(m.clase, m.categoria)}</select></label>
        <label class="campo"><span>Fecha</span><input type="date" name="fecha" required value="${m.fecha}"></label>
      </div>
      <label class="campo"><span>Descripción</span><input name="descripcion" value="${esc(m.descripcion)}" placeholder="${m.clase === 'gasto' ? 'Mercado, gasolina, recibo del agua…' : 'Pago quincena, clases…'}" autocomplete="off"></label>
      ${m.deudaId ? '<p class="ayuda">Este movimiento es un abono de una deuda. Si lo eliminas, el abono sigue en la deuda.</p>' : ''}
      <footer class="dlg-pie">
        ${id ? `<button type="button" class="btn btn-peligro" data-accion="eliminar-mov" data-id="${m.id}">${I.basura}Eliminar</button>` : ''}
        <span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">${id ? 'Guardar cambios' : 'Registrar'}</button>
      </footer>
    </form>`);
  if (!id) setTimeout(() => $('#dlg input[name=monto]')?.focus(), 50);
}

function abrirDeuda(id) {
  const d = id ? db.obtener('deudas', id) : { id: uid(), sentido: 'debo', persona: '', concepto: '', monto: 0, fecha: hoy(), vence: '', abonos: [] };
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="deuda" data-id="${d.id}">
      <header class="dlg-cabecera"><h2>${id ? 'Deuda' : 'Nueva deuda'}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <div class="segmentado" role="radiogroup" aria-label="Quién debe">
        <label><input type="radio" name="sentido" value="debo" ${d.sentido === 'debo' ? 'checked' : ''}><span>Yo debo</span></label>
        <label><input type="radio" name="sentido" value="meDeben" ${d.sentido === 'meDeben' ? 'checked' : ''}><span>Me deben</span></label>
      </div>
      <label class="campo"><span>Persona o entidad</span><input name="persona" required value="${esc(d.persona)}" placeholder="Banco, tarjeta de crédito, Juan…" autocomplete="off"></label>
      <label class="campo"><span>Concepto</span><input name="concepto" value="${esc(d.concepto)}" placeholder="Préstamo, compra a cuotas…" autocomplete="off"></label>
      <label class="campo"><span>Valor total</span><input name="monto" class="monto-grande" inputmode="numeric" data-monto required value="${d.monto ? fin.numero(d.monto) : ''}" placeholder="$ 0" autocomplete="off"></label>
      <div class="fila-campos">
        <label class="campo"><span>Desde</span><input type="date" name="fecha" value="${d.fecha || ''}"></label>
        <label class="campo"><span>Fecha límite</span><input type="date" name="vence" value="${d.vence || ''}"></label>
      </div>
      ${id && d.abonos?.length ? `<section class="subseccion"><h3>Abonos · ${fin.pesos(fin.abonado(d))}</h3>
        <ul class="lista-abonos">${d.abonos.slice().sort((a, b) => b.fecha.localeCompare(a.fecha)).map(a => `<li>
          <span>${fechaAmigable(a.fecha)}${a.nota ? ' · ' + esc(a.nota) : ''}</span><b>${fin.pesos(a.monto)}</b>
          <button type="button" class="btn-icono" data-accion="borrar-abono" data-id="${d.id}" data-valor="${a.id}" aria-label="Borrar abono">${I.cerrar}</button></li>`).join('')}</ul>
        <p class="ayuda">Saldo pendiente: <b>${fin.pesos(fin.saldo(d))}</b></p></section>` : ''}
      <footer class="dlg-pie">
        ${id ? `<button type="button" class="btn btn-peligro" data-accion="eliminar-deuda" data-id="${d.id}">${I.basura}Eliminar</button>` : ''}
        <span class="separador"></span>
        ${id && !fin.saldada(d) ? `<button type="button" class="btn" data-accion="abonar" data-id="${d.id}">${d.sentido === 'debo' ? 'Abonar' : 'Recibí un pago'}</button>` : ''}
        <button type="submit" class="btn btn-primario">${id ? 'Guardar cambios' : 'Crear deuda'}</button>
      </footer>
    </form>`);
  if (!id) setTimeout(() => $('#dlg input[name=persona]')?.focus(), 50);
}

function abrirAbono(id) {
  const d = db.obtener('deudas', id);
  if (!d) return;
  const debo = d.sentido === 'debo';
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="abono" data-id="${d.id}">
      <header class="dlg-cabecera"><h2>${debo ? 'Abono a' : 'Pago de'} ${esc(d.persona)}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <p class="ayuda">Saldo pendiente: <b>${fin.pesos(fin.saldo(d))}</b></p>
      <label class="campo"><span>Valor</span><input name="monto" class="monto-grande" inputmode="numeric" data-monto required value="${fin.numero(fin.saldo(d))}" autocomplete="off"></label>
      <div class="fila-campos">
        <label class="campo"><span>Fecha</span><input type="date" name="fecha" value="${hoy()}"></label>
        <label class="campo"><span>Nota</span><input name="nota" placeholder="Cuota 3, transferencia…" autocomplete="off"></label>
      </div>
      <label class="casilla"><input type="checkbox" name="registrar" checked><span>Registrar también como ${debo ? 'gasto' : 'ingreso'} del mes</span></label>
      <footer class="dlg-pie"><span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">Guardar ${debo ? 'abono' : 'pago'}</button></footer>
    </form>`);
  setTimeout(() => { const i = $('#dlg input[name=monto]'); i?.focus(); i?.select(); }, 50);
}

// =====================================================================
//  Vista: HÁBITOS
// =====================================================================
function vistaHabitos() {
  const habitos = db.lista('habitos').sort((a, b) => a.nombre.localeCompare(b.nombre));
  const semana = semanaActual();
  const h = hoy();
  $('#vista').innerHTML = `
    <header class="vista-cabecera"><h1>Hábitos</h1>
      <button class="btn btn-primario solo-escritorio" data-accion="nuevo-habito">${I.mas}Nuevo hábito</button></header>
    ${habitos.length ? `<ul class="lista-habitos">${habitos.map(x => {
      const r = racha(x);
      return `<li class="habito">
        <div class="habito-info">
          <button class="habito-nombre" data-accion="editar-habito" data-id="${x.id}">${esc(x.nombre)}</button>
          <span class="habito-dato">${r ? `Racha de ${r} ${r === 1 ? 'día' : 'días'}` : 'Sin racha aún'}</span>
          <span class="habito-dato">${cumplimiento(x)}% en 30 días</span>
          <span class="habito-dato">${!x.dias?.length || x.dias.length === 7 ? 'Todos los días' : x.dias.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => DIAS_NOMBRE[d].slice(0, 3)).join(', ')}</span>
        </div>
        <div class="semana" role="group" aria-label="Semana de ${esc(x.nombre)}">
          ${semana.map(f => {
            const dia = parseYmd(f).getDay();
            const toca = tocaHoy(x, f);
            const futuro = f > h;
            return `<button class="dia${f === h ? ' es-hoy' : ''}${toca ? '' : ' no-toca'}" data-accion="alternar-habito" data-id="${x.id}" data-fecha="${f}" aria-pressed="${hecho(x, f)}" ${futuro ? 'disabled' : ''} aria-label="${DIAS_NOMBRE[dia]} ${f}">${DIAS_CORTOS[dia]}</button>`;
          }).join('')}
        </div>
        <div class="mapa" aria-hidden="true">${Array.from({ length: 35 }, (_, i) => {
          const f = addDays(h, i - 34);
          return `<i class="${hecho(x, f) ? 'si' : tocaHoy(x, f) ? 'no' : 'na'}" title="${f}"></i>`;
        }).join('')}</div>
      </li>`;
    }).join('')}</ul>`
    : `<div class="vacio grande"><p>Un hábito es algo que quieres hacer con regularidad: leer 20 minutos, hacer ejercicio, revisar el correo de la universidad.</p>
       <button class="btn btn-primario" data-accion="nuevo-habito">Crear el primer hábito</button></div>`}`;
}

function abrirHabito(id) {
  const x = id ? db.obtener('habitos', id) : { id: uid(), nombre: '', dias: [], registro: {} };
  const dias = x.dias?.length ? x.dias : [0, 1, 2, 3, 4, 5, 6];
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="habito" data-id="${x.id}">
      <header class="dlg-cabecera"><h2>${id ? 'Editar hábito' : 'Nuevo hábito'}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <label class="campo"><span>Nombre</span><input name="nombre" required value="${esc(x.nombre)}" placeholder="Leer 20 minutos" autocomplete="off"></label>
      <fieldset class="campo dias-semana"><legend>Qué días</legend>
        ${[1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" name="dias" value="${d}" ${dias.includes(d) ? 'checked' : ''}><span title="${DIAS_NOMBRE[d]}">${DIAS_CORTOS[d]}</span></label>`).join('')}
      </fieldset>
      <footer class="dlg-pie">
        ${id ? `<button type="button" class="btn btn-peligro" data-accion="eliminar-habito" data-id="${x.id}">${I.basura}Eliminar</button>` : ''}
        <span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">${id ? 'Guardar cambios' : 'Crear hábito'}</button>
      </footer>
    </form>`);
  if (!id) setTimeout(() => $('#dlg input[name=nombre]')?.focus(), 50);
}

async function alternarHabito(id, fecha) {
  const x = db.obtener('habitos', id);
  if (!x) return;
  const registro = { ...(x.registro || {}) };
  if (registro[fecha]) delete registro[fecha];
  else registro[fecha] = true;
  await db.guardar('habitos', { ...x, registro });
}

// =====================================================================
//  Vista: NOTAS
// =====================================================================
function vistaNotas() {
  if (ui.notaId && !db.obtener('notas', ui.notaId)) ui.notaId = null;
  $('#vista').innerHTML = `
    <div class="notas${ui.notaId ? ' con-nota' : ''}">
      <section class="notas-lista" aria-label="Lista de notas">
        <header class="vista-cabecera"><h1>Notas</h1>
          <div class="acciones">
            <button class="btn" data-accion="importar">${I.importar}<span>Importar</span></button>
            <button class="btn btn-primario solo-escritorio" data-accion="nueva-nota">${I.mas}Nueva nota</button>
          </div></header>
        <label class="buscador">${I.buscar}<span class="sr-only">Buscar en notas</span>
          <input id="buscar-notas" type="search" placeholder="Buscar en todas las notas" value="${esc(ui.busqueda)}" data-input="buscar"></label>
        <div class="filtros" id="filtros-cuaderno"></div>
        <ul class="lista-notas" id="lista-notas"></ul>
      </section>
      <section class="notas-editor" id="editor-nota" aria-label="Editor de nota"></section>
    </div>`;
  pintarListaNotas();
  pintarEditorNota();
}

function notasFiltradas() {
  let notas = db.lista('notas');
  if (ui.cuaderno === 'ninguno') notas = notas.filter(n => !n.areaId || !area(n.areaId));
  else if (ui.cuaderno !== 'todos') notas = notas.filter(n => n.areaId === ui.cuaderno);
  if (ui.etiqueta) notas = notas.filter(n => n.etiquetas?.includes(ui.etiqueta));
  const q = norm(ui.busqueda);
  if (q) {
    const palabras = q.split(/\s+/);
    notas = notas.filter(n => { const t = norm(n.titulo + ' ' + n.contenido); return palabras.every(p => t.includes(p)); });
  }
  return notas.sort((a, b) => (b.fijada ? 1 : 0) - (a.fijada ? 1 : 0) || b.actualizadoEn - a.actualizadoEn);
}

function resumenTexto(md, n = 140) {
  return String(md || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`~\[\]()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

function pintarListaNotas() {
  const cont = $('#lista-notas');
  if (!cont) return;
  const todas = db.lista('notas');
  const areas = areasOrdenadas().filter(a => todas.some(n => n.areaId === a.id) || ui.cuaderno === a.id);
  $('#filtros-cuaderno').innerHTML = `
    <button class="filtro" data-accion="cuaderno" data-valor="todos" aria-pressed="${ui.cuaderno === 'todos'}">Todas <span class="cuenta">${todas.length}</span></button>
    ${areas.map(a => `<button class="filtro" data-accion="cuaderno" data-valor="${a.id}" aria-pressed="${ui.cuaderno === a.id}"><i class="punto" style="--c:${a.color}"></i>${esc(a.nombre)}</button>`).join('')}
    ${todas.some(n => !n.areaId) ? `<button class="filtro" data-accion="cuaderno" data-valor="ninguno" aria-pressed="${ui.cuaderno === 'ninguno'}">Sin cuaderno</button>` : ''}
    ${ui.etiqueta ? `<button class="filtro activo-etiqueta" data-accion="quitar-etiqueta" aria-label="Quitar filtro de etiqueta">#${esc(ui.etiqueta)} ${I.cerrar}</button>` : ''}`;
  const notas = notasFiltradas();
  cont.innerHTML = notas.length ? notas.map(n => {
    const a = area(n.areaId);
    const foto = imgs.idsEnTexto(n.contenido, n)[0];
    return `<li><a class="nota-item${n.id === ui.notaId ? ' activa' : ''}${foto ? ' con-foto' : ''}" href="#/notas/${n.id}" aria-current="${n.id === ui.notaId}">
      ${foto ? `<img class="nota-thumb" data-img="${foto}" alt="">` : ''}
      <span class="nota-item-titulo">${n.fijada ? `<span class="pin" title="Fijada">${I.fijar}</span>` : ''}${esc(n.titulo || 'Sin título')}</span>
      <span class="nota-item-resumen">${esc(resumenTexto(n.contenido)) || '<em>Vacía</em>'}</span>
      <span class="nota-item-meta">${a ? `<span><i class="punto" style="--c:${a.color}"></i>${esc(a.nombre)}</span>` : ''}<span>${fechaAmigable(ymdLocal(n.actualizadoEn))}</span></span>
    </a></li>`;
  }).join('') : `<li class="vacio">${todas.length ? 'Ninguna nota coincide con la búsqueda.' : 'Aún no tienes notas. Crea una o pulsa Importar para traer las de tu celular.'}</li>`;
  imgs.hidratar(cont);
}

const ymdLocal = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function renderMarkdown(md, nota = null) {
  const html = window.marked.parse(imgs.prepararMarkdown(md, nota || (ui.notaId && db.obtener('notas', ui.notaId))), { gfm: true, breaks: true });
  return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

function pintarEditorNota() {
  const cont = $('#editor-nota');
  if (!cont) return;
  $('.notas')?.classList.toggle('con-nota', !!ui.notaId);
  const n = ui.notaId && db.obtener('notas', ui.notaId);
  if (!n) {
    cont.innerHTML = `<div class="editor-vacio"><p>Elige una nota de la lista o crea una nueva.</p>
      <button class="btn btn-primario" data-accion="nueva-nota">${I.mas}Nueva nota</button>
      <button class="btn" data-accion="nueva-nota-clase">${I.plantilla}Apunte de clase</button></div>`;
    return;
  }
  const pendientes = contarPendientes(n);
  cont.innerHTML = `
    <div class="editor-barra">
      <a class="btn-icono solo-movil" href="#/notas" aria-label="Volver a la lista">${I.atras}</a>
      <label class="selector-cuaderno"><span class="sr-only">Cuaderno</span>
        <select data-cambio="cuaderno-nota"><option value="">Sin cuaderno</option>
          ${areasOrdenadas().map(a => `<option value="${a.id}" ${a.id === n.areaId ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
      <span class="separador"></span>
      <button class="btn-icono" data-accion="alternar-vista-previa" aria-pressed="${ui.vistaPrevia}" title="${ui.vistaPrevia ? 'Editar' : 'Ver con formato'}" aria-label="${ui.vistaPrevia ? 'Editar' : 'Ver con formato'}">${ui.vistaPrevia ? I.lapiz : I.ojo}</button>
      <button class="btn-icono" data-accion="fijar-nota" aria-pressed="${!!n.fijada}" title="${n.fijada ? 'Quitar de fijadas' : 'Fijar arriba'}" aria-label="Fijar">${I.fijar}</button>
      <button class="btn-icono" data-accion="exportar-nota" title="Descargar como .md" aria-label="Descargar como Markdown">${I.exportar}</button>
      <button class="btn-icono peligro" data-accion="eliminar-nota" title="Eliminar nota" aria-label="Eliminar nota">${I.basura}</button>
    </div>
    <textarea id="nota-titulo" class="nota-titulo" rows="1" placeholder="Título" aria-label="Título de la nota" data-input="nota">${esc(n.titulo)}</textarea>
    <div class="editor-herramientas" role="toolbar" aria-label="Formato">
      <button class="btn-mini ancho resaltado-suave" data-accion="adjuntar-imagen" title="Agregar foto o imagen">${I.imagen}Imagen</button>
      <button class="btn-mini" data-accion="md" data-md="titulo" title="Subtítulo">T</button>
      <button class="btn-mini" data-accion="md" data-md="negrita" title="Negrita"><b>N</b></button>
      <button class="btn-mini" data-accion="md" data-md="lista" title="Lista">•</button>
      <button class="btn-mini" data-accion="md" data-md="casilla" title="Casilla de pendiente">☐</button>
      <button class="btn-mini ancho" data-accion="plantilla-clase" title="Insertar plantilla de apunte de clase">${I.plantilla}Plantilla de clase</button>
      ${pendientes ? `<button class="btn-mini ancho resaltado" data-accion="pendientes-a-tareas">${I.casilla}Crear ${pendientes} tarea${pendientes > 1 ? 's' : ''}</button>` : ''}
    </div>
    <div class="galeria-nota" id="galeria-nota"></div>
    <div class="editor-cuerpo${ui.vistaPrevia ? ' previa' : ''}">
      <textarea id="nota-contenido" data-id="${n.id}" class="nota-contenido" placeholder="Escribe aquí. Usa # para títulos, - [ ] para pendientes y #etiquetas para encontrar la nota después." aria-label="Contenido de la nota" data-input="nota">${esc(n.contenido || '')}</textarea>
      <article class="nota-render" id="nota-render">${renderMarkdown(n.contenido, n)}</article>
    </div>
    <footer class="editor-pie">
      ${n.etiquetas?.length ? n.etiquetas.map(t => `<button class="etiqueta" data-accion="etiqueta" data-valor="${esc(t)}">#${esc(t)}</button>`).join('') : ''}
      <span class="separador"></span><small id="estado-guardado">Guardada ${haceCuanto(n.actualizadoEn)}</small>
    </footer>`;
  activarCasillas();
  imgs.hidratar($('#nota-render'));
  pintarGaleria(n.contenido);
}

// ---------------------------------------------------------------------
//  Imágenes en las notas
// ---------------------------------------------------------------------
let galeriaActual = '';
function pintarGaleria(contenido, forzar = false) {
  const g = $('#galeria-nota');
  if (!g) return;
  const ids = [...new Set(imgs.idsEnTexto(contenido, ui.notaId && db.obtener('notas', ui.notaId)))];
  const clave = ids.join(',');
  if (!forzar && clave === galeriaActual && g.childElementCount === ids.length) return;
  galeriaActual = clave;
  g.innerHTML = ids.map(id => `<figure>
    <button class="galeria-ver" data-accion="ver-imagen" data-valor="${id}" aria-label="Ver imagen"><img data-img="${id}" alt=""></button>
    <button class="galeria-quitar" data-accion="quitar-imagen" data-valor="${id}" aria-label="Quitar imagen">${I.cerrar}</button>
  </figure>`).join('');
  imgs.hidratar(g);
}

function elegirImagenes() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.multiple = true;
  inp.onchange = () => inp.files.length && adjuntarImagenes([...inp.files]);
  inp.click();
}

/** Comprime, guarda y escribe ![](img:ID) donde estaba el cursor */
async function adjuntarImagenes(files) {
  const n = ui.notaId && db.obtener('notas', ui.notaId);
  const fotos = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(f.name || ''));
  if (!n || !fotos.length) return;
  await guardarNotaYa();
  toast(fotos.length > 1 ? `Agregando ${fotos.length} imágenes…` : 'Agregando imagen…');
  const marcas = [];
  const mapa = { ...(db.obtener('notas', n.id)?.imagenes || {}) };
  for (const f of fotos) {
    try {
      const id = await imgs.guardarImagen(f, n.id, f.name || '');
      const alias = imgs.siguienteAlias({ imagenes: mapa });
      mapa[alias] = id;
      marcas.push(`![foto ${alias}](img:${alias})`);
    } catch (e) { console.error(e); toast(`No se pudo leer ${f.name || 'la imagen'}. Prueba con una foto JPG o PNG.`); }
  }
  if (!marcas.length) return;
  await db.guardar('notas', { ...db.obtener('notas', n.id), imagenes: mapa }, { silencioso: true });
  const ta = $('#nota-contenido');
  const v = ta.value;
  let pos = ui.vistaPrevia ? v.length : Number(ta.dataset.pos ?? v.length);
  if (pos > v.length) pos = v.length;
  const antes = v.slice(0, pos), despues = v.slice(pos);
  const bloque = (antes && !antes.endsWith('\n') ? '\n' : '') + marcas.join('\n') + '\n' + (despues && !despues.startsWith('\n') ? '\n' : '');
  ta.value = antes + bloque + despues;
  ta.dataset.pos = String((antes + bloque).length);
  await guardarNotaYa();
  pintarGaleria(ta.value, true);
  toast(marcas.length > 1 ? `${marcas.length} imágenes agregadas` : 'Imagen agregada');
}

async function quitarImagen(id) {
  const n = db.obtener('notas', ui.notaId);
  const ta = $('#nota-contenido');
  if (!n || !ta) return;
  const previo = ta.value;
  const refs = [id, ...Object.entries(n.imagenes || {}).filter(([, v]) => v === id).map(([k]) => k)];
  for (const ref of refs) ta.value = ta.value.replace(new RegExp(`\\n?!\\[[^\\]]*\\]\\(img:${ref}\\)\\n?`, 'g'), '\n');
  ta.value = ta.value.replace(/\n{3,}/g, '\n\n');
  await guardarNotaYa();
  await db.eliminar('imagenes', id);
  imgs.olvidar(id);
  pintarGaleria(ta.value, true);
  toast('Imagen quitada', { texto: 'Deshacer', fn: async () => {
    await db.restaurar('imagenes', id);
    const t = $('#nota-contenido');
    if (t && ui.notaId === n.id) { t.value = previo; await guardarNotaYa(); pintarGaleria(previo, true); }
    else await db.guardar('notas', { ...db.obtener('notas', n.id), contenido: previo });
  } });
}

async function abrirVisor(id) {
  const url = await imgs.urlImagen(id);
  if (!url) return toast('Esta imagen aún no se ha sincronizado en este dispositivo.');
  const d = $('#dlg');
  d.classList.add('visor-dlg');
  abrirDialogo(`
    <div class="visor">
      <img src="${url}" alt="">
      <div class="visor-barra">
        <button class="btn" data-accion="descargar-imagen" data-valor="${id}">${I.exportar}Descargar</button>
        <button class="btn btn-primario" data-accion="cerrar-dialogo">Cerrar</button>
      </div>
    </div>`);
  d.addEventListener('close', () => d.classList.remove('visor-dlg'), { once: true });
}

const RE_CASILLA = /^(\s*[-*+]\s+)\[( |x|X)\]\s+(.*)$/gm;

function contarPendientes(n) {
  const hechas = new Set(n.tareasCreadas || []);
  return [...(n.contenido || '').matchAll(RE_CASILLA)].filter(m => m[2] === ' ' && m[3].trim() && !hechas.has(norm(m[3]))).length;
}

function activarCasillas() {
  const render = $('#nota-render');
  if (!render) return;
  $$('input[type=checkbox]', render).forEach((cb, i) => {
    cb.disabled = false;
    cb.addEventListener('change', () => {
      const ta = $('#nota-contenido');
      let k = -1;
      ta.value = ta.value.replace(RE_CASILLA, (m, pre, marca, txt) => {
        k++;
        return k === i ? `${pre}[${marca === ' ' ? 'x' : ' '}] ${txt}` : m;
      });
      guardarNotaYa();
    });
  });
}

const guardarNota = debounce(() => guardarNotaYa(), 500);

async function guardarNotaYa(id = ui.notaId) {
  const n = id && db.obtener('notas', id);
  const ta = $('#nota-contenido');
  if (!n || !ta || ta.dataset.id !== id) return;
  const titulo = $('#nota-titulo').value.replace(/\s*\n\s*/g, ' ');
  const contenido = ta.value;
  if (titulo === n.titulo && contenido === n.contenido) return;
  await db.guardar('notas', { ...n, titulo, contenido, etiquetas: extraerEtiquetas(contenido) }, { silencioso: true });
  if (ui.notaId !== id) return;
  const r = $('#nota-render');
  if (r) { r.innerHTML = renderMarkdown(contenido); activarCasillas(); imgs.hidratar(r); }
  pintarGaleria(contenido);
  const e = $('#estado-guardado');
  if (e) e.textContent = 'Guardada';
}

async function nuevaNota({ clase = false } = {}) {
  const areaId = ui.cuaderno !== 'todos' && ui.cuaderno !== 'ninguno' ? ui.cuaderno : null;
  const n = { id: uid(), titulo: '', contenido: clase ? plantillaClase(areaId) : '', areaId, etiquetas: [], fijada: false };
  if (clase) { const a = area(areaId); n.titulo = `${a ? a.nombre + ' · ' : ''}Clase del ${fechaAmigable(hoy()) === 'Hoy' ? new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long' }).format(new Date()) : hoy()}`; }
  await db.guardar('notas', n);
  ui.vistaPrevia = false;
  ir('notas', n.id);
  setTimeout(() => (clase ? $('#nota-contenido') : $('#nota-titulo'))?.focus(), 60);
}

function plantillaClase(areaId) {
  const a = area(areaId);
  return `**Curso:** ${a ? a.nombre : ''}\n**Fecha:** ${new Intl.DateTimeFormat('es-CO', { dateStyle: 'long' }).format(new Date())}\n**Tema:** \n\n## Lo que vimos\n- \n\n## Dudas de los estudiantes\n- \n\n## Pendientes para la próxima clase\n- [ ] \n`;
}

function insertarMd(tipo) {
  const ta = $('#nota-contenido');
  if (!ta || ui.vistaPrevia) return;
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  const inicioLinea = v.lastIndexOf('\n', s - 1) + 1;
  let nuevo, cursor;
  if (tipo === 'negrita') { nuevo = v.slice(0, s) + `**${sel || 'texto'}**` + v.slice(e); cursor = s + 2 + (sel || 'texto').length; }
  else {
    const pre = { titulo: '## ', lista: '- ', casilla: '- [ ] ' }[tipo];
    nuevo = v.slice(0, inicioLinea) + pre + v.slice(inicioLinea);
    cursor = e + pre.length;
  }
  ta.value = nuevo;
  ta.focus();
  ta.setSelectionRange(cursor, cursor);
  guardarNota();
}

async function pendientesATareas() {
  const n = db.obtener('notas', ui.notaId);
  if (!n) return;
  const ya = new Set(n.tareasCreadas || []);
  const nuevas = [];
  for (const m of (n.contenido || '').matchAll(RE_CASILLA)) {
    const txt = m[3].trim();
    if (m[2] !== ' ' || !txt || ya.has(norm(txt))) continue;
    ya.add(norm(txt));
    nuevas.push({ id: uid(), titulo: txt, notas: `De la nota «${n.titulo}»`, prioridad: 'media', fecha: null, hora: null, recurrencia: '', areaId: n.areaId || null, completada: false, notaId: n.id });
  }
  if (!nuevas.length) return;
  await db.guardarVarios('tareas', nuevas);
  await db.guardar('notas', { ...n, tareasCreadas: [...ya] });
  pintarEditorNota();
  toast(`${nuevas.length} tarea${nuevas.length > 1 ? 's creadas' : ' creada'} sin fecha`, { texto: 'Ver tareas', fn: () => { ui.filtro = 'sinfecha'; ui.areaId = null; ir('tareas'); } });
}

// =====================================================================
//  Importar notas
// =====================================================================
function elegirArchivos() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = '.md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip';
  inp.onchange = () => inp.files.length && previsualizarImport([...inp.files]);
  inp.click();
}

async function previsualizarImport(files) {
  toast('Leyendo archivos…');
  let r;
  try { r = await imp.leerArchivos(files); }
  catch (e) { console.error(e); toast('No se pudieron leer los archivos. Revisa que sean .md, .txt o .zip.'); return; }
  mostrarPrevia(r.candidatas, r.avisos);
}

function mostrarPrevia(candidatas, avisos = []) {
  if (!candidatas.length) { toast(avisos[0] || 'No se encontraron notas en esos archivos.'); return; }
  const huellas = new Set(db.lista('notas').map(imp.huellaNota));
  candidatas.forEach((c, i) => { c.i = i; c.duplicada = huellas.has(imp.huellaNota(c)); });
  const areas = areasOrdenadas();
  const detectados = [...new Set(candidatas.map(c => c.cuaderno).filter(Boolean))];
  mostrarPrevia.datos = candidatas;
  const nuevas = candidatas.filter(c => !c.duplicada).length;
  abrirDialogo(`
    <form method="dialog" class="formulario ancho" data-form="importar">
      <header class="dlg-cabecera"><h2>Importar notas</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <p class="ayuda">Se encontraron ${candidatas.length} nota${candidatas.length > 1 ? 's' : ''}${candidatas.length - nuevas ? `; ${candidatas.length - nuevas} ya existe${candidatas.length - nuevas > 1 ? 'n' : ''} y quedaron sin marcar` : ''}.</p>
      ${avisos.length ? `<p class="ayuda aviso">${avisos.map(esc).join('<br>')}</p>` : ''}
      <label class="campo"><span>Cuaderno</span><select name="destino">
        ${detectados.length ? `<option value="auto">Según la carpeta o el archivo (${detectados.slice(0, 3).map(esc).join(', ')}${detectados.length > 3 ? '…' : ''})</option>` : ''}
        <option value="">Sin cuaderno</option>
        ${areas.map(a => `<option value="${a.id}" ${ui.cuaderno === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}
      </select></label>
      ${detectados.length ? '<p class="ayuda">Si eliges “según la carpeta”, los cuadernos que no existan se crearán automáticamente.</p>' : ''}
      <div class="previa-acciones"><button type="button" class="btn btn-texto" data-accion="marcar-todas" data-valor="1">Marcar todas</button>
        <button type="button" class="btn btn-texto" data-accion="marcar-todas" data-valor="0">Desmarcar todas</button></div>
      <ul class="lista-previa">${candidatas.map(c => `
        <li><label class="item-previa">
          <input type="checkbox" name="sel" value="${c.i}" ${c.duplicada ? '' : 'checked'}>
          <span class="item-previa-texto"><b>${esc(c.titulo)}</b>
            <small>${esc(resumenTexto(c.contenido, 110)) || 'Vacía'}</small>
            <span class="item-previa-meta">${c.duplicada ? '<span class="insignia">Ya existe</span>' : ''}${c.cuaderno ? `<span>${esc(c.cuaderno)}</span>` : ''}${c.etiquetas.length ? `<span>${c.etiquetas.slice(0, 4).map(t => '#' + esc(t)).join(' ')}</span>` : ''}${c.aviso ? `<span class="aviso">${esc(c.aviso)}</span>` : ''}</span>
          </span></label></li>`).join('')}</ul>
      <footer class="dlg-pie"><span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario" id="btn-importar">Importar ${nuevas} nota${nuevas === 1 ? '' : 's'}</button></footer>
    </form>`);
}

async function confirmarImport(form) {
  const fd = new FormData(form);
  const sel = new Set(fd.getAll('sel').map(Number));
  const destino = fd.get('destino');
  const elegidas = mostrarPrevia.datos.filter(c => sel.has(c.i));
  if (!elegidas.length) { toast('Marca al menos una nota.'); return; }
  const porNombre = new Map(areasOrdenadas().map(a => [norm(a.nombre), a.id]));
  const crear = [];
  const notas = elegidas.map(c => {
    let areaId = destino === 'auto' ? null : destino || null;
    if (destino === 'auto' && c.cuaderno && norm(c.cuaderno) !== 'sin cuaderno') {
      const k = norm(c.cuaderno);
      if (!porNombre.has(k)) {
        const a = { id: uid(), nombre: c.cuaderno, color: COLORES[(areasOrdenadas().length + crear.length) % COLORES.length], orden: 99 };
        crear.push(a); porNombre.set(k, a.id);
      }
      areaId = porNombre.get(k);
    }
    return imp.candidataANota(c, areaId);
  });
  cerrarDialogo();
  if (crear.length) await db.guardarVarios('areas', crear);
  for (const n of notas) {
    const incrustadas = [...n.contenido.matchAll(/!\[([^\]]*)\]\((data:image\/[^)\s]+)\)/g)];
    for (const m of incrustadas) {
      try {
        const id = await imgs.guardarImagen(m[2], n.id);
        n.imagenes = { ...(n.imagenes || {}) };
        const alias = imgs.siguienteAlias(n);
        n.imagenes[alias] = id;
        n.contenido = n.contenido.replace(m[0], `![${m[1] || 'foto ' + alias}](img:${alias})`);
      } catch { /* se deja como estaba */ }
    }
  }
  await db.guardarVarios('notas', notas);
  ui.cuaderno = 'todos';
  toast(`${notas.length} nota${notas.length > 1 ? 's importadas' : ' importada'}${crear.length ? ` y ${crear.length} cuaderno${crear.length > 1 ? 's' : ''} nuevo${crear.length > 1 ? 's' : ''}` : ''}`);
  ir('notas');
}

function abrirImportarNotas() {
  abrirDialogo(`
    <div class="formulario">
      <header class="dlg-cabecera"><h2>Importar notas</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <button class="opcion-import" data-accion="importar-archivos">
        <b>${I.importar}Elegir archivos de texto</b>
        <small>Las notas que exportaste <b>como texto (.txt)</b> desde tu celular. Puedes marcar varias a la vez. También sirven .md o un .zip.</small>
      </button>
      <button class="opcion-import" data-accion="pegar">
        <b>${I.copiar}Pegar el texto de una nota</b>
        <small>Abre la nota en tu celular, <b>Seleccionar todo → Copiar</b> y pégala. La primera línea será el título.</small>
      </button>
      <div class="opcion-import info">
        <b>Desde la app de notas</b>
        <small>Abre la nota → <b>Compartir → Compartir nota como texto → Gestor agenda</b> y elige <b>Guardar como nota</b>. Funciona con la app instalada en el celular.</small>
      </div>
    </div>`);
}

function abrirPegar() {
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="pegar">
      <header class="dlg-cabecera"><h2>Pegar notas</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <p class="ayuda">Pega el texto de la nota. La primera línea será el título.</p>
      ${navigator.clipboard?.readText ? `<button type="button" class="btn" data-accion="leer-portapapeles">${I.copiar}Pegar lo que copié</button>` : ''}
      <p class="ayuda">¿Varias notas a la vez? Sepáralas con una línea que solo tenga <code>---</code>.</p>
      <label class="campo"><span class="sr-only">Texto</span><textarea name="texto" rows="10" required></textarea></label>
      <footer class="dlg-pie"><span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">Revisar notas</button></footer>
    </form>`);
}

/** Lo que llega desde el menú "Compartir" del celular */
async function procesarCompartido() {
  const params = new URLSearchParams(location.search);
  if (!params.has('compartir')) return;
  history.replaceState(null, '', location.pathname + (location.hash || '#/notas'));
  const items = await db.idb.shareTake();
  const archivos = items.flatMap(it => it.files || []);
  if (archivos.length) { ir('notas'); return previsualizarImport(archivos); }
  const it = items[0] || { title: params.get('title'), text: params.get('text'), url: params.get('url') };
  const texto = [it.text, it.url].filter(Boolean).join('\n\n');
  if (!texto && !it.title) return;
  textoCompartido = { titulo: it.title || '', texto };
  const lineas = texto.split('\n').filter(l => l.trim()).length;
  abrirDialogo(`
    <div class="formulario">
      <header class="dlg-cabecera"><h2>Recibiste un texto</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <pre class="texto-recibido">${esc(texto.slice(0, 600))}${texto.length > 600 ? '…' : ''}</pre>
      <p class="ayuda">¿Qué quieres crear con él?</p>
      <div class="fila-botones">
        <button class="btn btn-primario" data-accion="compartido-nota">Guardar como nota</button>
        <button class="btn" data-accion="compartido-tareas">${lineas > 1 ? 'Crear tareas (una por línea)' : 'Crear una tarea'}</button>
      </div>
    </div>`);
}

let textoCompartido = null;

async function compartidoComoNota() {
  const it = textoCompartido;
  if (!it) return;
  const texto = it.texto;
  const c = it.titulo ? imp.parsearMarkdown(`# ${it.titulo}\n\n${texto}`, '', Date.now()) : imp.parsearTextoPlano(texto, '', Date.now());
  const n = imp.candidataANota(c, null);
  await db.guardar('notas', n);
  cerrarDialogo();
  ir('notas', n.id);
  toast('Nota creada desde Compartir. Elige su cuaderno arriba.');
}

// ---------------------------------------------------------------------
//  Pegar tareas como texto
// ---------------------------------------------------------------------
function abrirPegarTareas(texto = '') {
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="pegar-tareas">
      <header class="dlg-cabecera"><h2>Pegar tareas</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <p class="ayuda">En tu celular abre la lista, mantén presionado el texto, elige <b>Seleccionar todo → Copiar</b> y pégalo aquí. Cada línea será una tarea.</p>
      <label class="campo"><span class="sr-only">Texto de las tareas</span>
        <textarea name="texto" rows="9" required placeholder="☐ Pagar celular el 15/12&#10;☐ Calificar parcial mañana 3pm #docencia&#10;☑ Comprar tinta">${esc(texto)}</textarea></label>
      ${navigator.clipboard?.readText ? `<button type="button" class="btn" data-accion="leer-portapapeles">${I.copiar}Pegar lo que copié</button>` : ''}
      <details class="guia"><summary>¿Qué entiende?</summary>
        <ul class="ayuda">
          <li>Casillas ☐ ☑, [ ] [x], viñetas (-, •) y números (1. 2.).</li>
          <li>Las marcadas como hechas (☑, [x], ✓) se muestran sin seleccionar.</li>
          <li>Fechas y horas: <i>mañana</i>, <i>viernes</i>, <i>15/12</i>, <i>3pm</i>, <i>10:30</i>.</li>
          <li><i>#pagos</i> asigna la categoría; <i>!</i> pone prioridad alta.</li>
          <li>Una línea como <i>Maestría:</i> asigna esa categoría a las tareas que siguen.</li>
        </ul></details>
      <footer class="dlg-pie"><span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">Revisar tareas</button></footer>
    </form>`);
  if (!texto) setTimeout(() => $('#dlg textarea')?.focus(), 50);
}

let tareasPegadas = [];

function previsualizarTareas(texto) {
  const items = parsearListaTareas(texto, areasOrdenadas());
  if (!items.length) return toast('No encontré tareas en ese texto.');
  const existentes = new Set(db.lista('tareas').filter(t => !t.completada).map(t => norm(t.titulo)));
  items.forEach((it, i) => { it.i = i; it.duplicada = existentes.has(norm(it.titulo)); });
  tareasPegadas = items;
  const marcadas = items.filter(it => !it.hecha && !it.duplicada).length;
  const conArea = items.some(it => it.areaId);
  abrirDialogo(`
    <form method="dialog" class="formulario ancho" data-form="importar-tareas">
      <header class="dlg-cabecera"><h2>${items.length} tarea${items.length > 1 ? 's' : ''} encontrada${items.length > 1 ? 's' : ''}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <div class="fila-campos">
        <label class="campo"><span>Categoría</span><select name="area">
          ${conArea ? '<option value="auto">Según cada línea</option>' : ''}
          <option value="">Sin categoría</option>
          ${areasOrdenadas().map(a => `<option value="${a.id}">${esc(a.nombre)}</option>`).join('')}</select></label>
        <label class="campo"><span>Fecha</span><select name="fecha">
          <option value="auto">Según cada línea</option>
          <option value="hoy">Hoy para todas</option>
          <option value="manana">Mañana para todas</option>
          <option value="">Sin fecha</option></select></label>
      </div>
      <div class="previa-acciones"><button type="button" class="btn btn-texto" data-accion="marcar-todas" data-valor="1">Marcar todas</button>
        <button type="button" class="btn btn-texto" data-accion="marcar-todas" data-valor="0">Desmarcar todas</button></div>
      <ul class="lista-previa">${items.map(it => {
        const a = area(it.areaId);
        return `<li><label class="item-previa">
          <input type="checkbox" name="sel" value="${it.i}" ${it.hecha || it.duplicada ? '' : 'checked'}>
          <span class="item-previa-texto"><b>${esc(it.titulo)}</b>
            <span class="item-previa-meta">
              ${it.hecha ? '<span class="insignia">Ya hecha</span>' : ''}${it.duplicada ? '<span class="insignia">Ya existe</span>' : ''}
              ${it.fecha ? `<span>${fechaAmigable(it.fecha)}</span>` : ''}${it.hora ? `<span>${horaAmigable(it.hora)}</span>` : ''}
              ${a ? `<span><i class="punto" style="--c:${a.color}"></i> ${esc(a.nombre)}</span>` : ''}${it.prioridad === 'alta' ? '<span>Prioridad alta</span>' : ''}
              ${it.subtareas?.length ? `<span>${it.subtareas.length} subtarea${it.subtareas.length > 1 ? 's' : ''}</span>` : ''}
              ${it.notas ? `<span>${esc(it.notas.slice(0, 60))}</span>` : ''}
            </span></span></label></li>`;
      }).join('')}</ul>
      <footer class="dlg-pie">
        <button type="button" class="btn btn-texto" data-accion="volver-pegar">Editar texto</button>
        <span class="separador"></span>
        <button type="submit" class="btn btn-primario" id="btn-importar">Crear ${marcadas} tarea${marcadas === 1 ? '' : 's'}</button></footer>
    </form>`);
  previsualizarTareas.texto = texto;
}

async function crearTareasPegadas(form) {
  const fd = new FormData(form);
  const sel = new Set(fd.getAll('sel').map(Number));
  const elegidas = tareasPegadas.filter(it => sel.has(it.i));
  if (!elegidas.length) return toast('Marca al menos una tarea.');
  const modoArea = fd.get('area'), modoFecha = fd.get('fecha');
  const fechaFija = { hoy: hoy(), manana: addDays(hoy(), 1), '': null };
  const nuevas = elegidas.map(it => {
    let fecha = modoFecha === 'auto' ? it.fecha : fechaFija[modoFecha];
    if (modoFecha === 'auto' && !fecha && it.hora) fecha = hoy();
    return {
      id: uid(), titulo: it.titulo, subtareas: (it.subtareas || []).map(x => ({ id: uid(), titulo: x.titulo, hecha: !!x.hecha })), notas: it.notas || '', prioridad: it.prioridad || 'media', fecha, hora: it.hora || null,
      recurrencia: '', areaId: modoArea === 'auto' ? it.areaId || null : modoArea || null, completada: false,
    };
  });
  cerrarDialogo();
  await db.guardarVarios('tareas', nuevas);
  ui.filtro = nuevas.some(t => !t.fecha) && nuevas.every(t => !t.fecha) ? 'sinfecha' : 'todas';
  ui.areaId = null;
  ir('tareas');
  toast(`${nuevas.length} tarea${nuevas.length > 1 ? 's creadas' : ' creada'}`);
}

// =====================================================================
//  Vista: AJUSTES
// =====================================================================
async function vistaAjustes() {
  const cfg = sync.getConfig();
  const ses = cfg ? await sync.sesion().catch(() => null) : null;
  const e = sync.getEstado();
  const tema = localStorage.getItem('ga-tema') || 'sistema';
  const instalada = matchMedia('(display-mode: standalone)').matches;
  const totales = { tareas: db.lista('tareas').length, notas: db.lista('notas').length, habitos: db.lista('habitos').length };

  let nube;
  if (!cfg) {
    nube = `<p>Conecta un proyecto gratuito de Supabase para guardar una copia de todo en la nube. Si pierdes el celular, entras con tu cuenta en otro dispositivo y recuperas tus datos.</p>
      <form id="form-supabase" class="formulario" data-form="supabase">
        <label class="campo"><span>URL del proyecto</span><input name="url" type="url" required placeholder="https://xxxxxxxx.supabase.co" autocomplete="off"></label>
        <label class="campo"><span>Clave pública (publishable o anon)</span><input name="key" required placeholder="sb_publishable_… o eyJhbGci…" autocomplete="off"></label>
        <p class="ayuda">Las encuentras en Supabase › Project Settings › API Keys. Nunca uses la clave <b>secret</b> ni la <b>service_role</b>.</p>
        <button class="btn btn-primario" type="submit">Guardar conexión</button>
      </form>`;
  } else if (!ses) {
    nube = `<p class="ayuda">Proyecto: <code>${esc(cfg.url.replace(/^https?:\/\//, ''))}</code></p>
      <form id="form-login" class="formulario" data-form="login">
        <label class="campo"><span>Correo</span><input name="email" type="email" required autocomplete="email"></label>
        <label class="campo"><span>Contraseña</span><input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
        <div class="fila-botones">
          <button class="btn btn-primario" type="submit" name="modo" value="entrar">Entrar</button>
          <button class="btn" type="submit" name="modo" value="registrar">Crear cuenta</button>
          <span class="separador"></span>
          <button class="btn btn-texto" type="button" data-accion="olvidar-supabase">Cambiar proyecto</button>
        </div>
      </form>`;
  } else {
    nube = `<div class="estado-sync grande" data-fase="${e.fase}"></div>
      <dl class="datos-sync">
        <div><dt>Cuenta</dt><dd>${esc(ses.user.email)}</dd></div>
        <div><dt>Proyecto</dt><dd><code>${esc(cfg.url.replace(/^https?:\/\//, ''))}</code></dd></div>
        <div><dt>Pendientes por subir</dt><dd>${db.pendientes().length}</dd></div>
      </dl>
      <div class="fila-botones">
        <button class="btn btn-primario" data-accion="sincronizar">${I.girar}Sincronizar ahora</button>
        <span class="separador"></span>
        <button class="btn btn-texto" data-accion="salir">Cerrar sesión</button>
      </div>`;
  }

  $('#vista').innerHTML = `
    <header class="vista-cabecera"><h1>Ajustes</h1></header>
    <div class="ajustes">
      <section class="panel"><h2>Respaldo en la nube</h2>${nube}</section>

      ${panelRecordatorios(cfg, ses)}

      <section class="panel"><h2>Categorías</h2>
        <p class="ayuda">Agrupan tus tareas (y sirven de cuadernos para las notas). Toca una para cambiar su nombre o color.</p>
        <ul class="lista-areas">${areasOrdenadas().map(a => `
          <li><i class="punto grande" style="--c:${a.color}"></i><span>${esc(a.nombre)}</span>
            <button class="btn btn-texto" data-accion="editar-area" data-id="${a.id}">Editar</button></li>`).join('')}</ul>
        ${sugeridasFaltantes().length ? `<p class="ayuda">Sugeridas: ${sugeridasFaltantes().map(n => `<button class="etiqueta" data-accion="agregar-sugerida" data-valor="${esc(n)}">+ ${esc(n)}</button>`).join(' ')}</p>` : ''}
        <button class="btn" data-accion="nueva-area">${I.mas}Nueva categoría</button>
      </section>

      <section class="panel"><h2>Importar notas y tareas</h2>
        <p class="ayuda">Notas exportadas como texto (.txt) o Markdown (.md), o un .zip con varias. Antes de guardar verás la lista para elegir cuáles traer.</p>
        <div class="fila-botones">
          <button class="btn btn-primario" data-accion="importar-archivos">${I.importar}Elegir archivos</button>
          <button class="btn" data-accion="pegar">Pegar notas</button>
          <button class="btn" data-accion="pegar-tareas">Pegar tareas</button>
        </div>
      </section>

      <section class="panel"><h2>Exportar y restaurar</h2>
        <p class="ayuda">Tienes ${totales.tareas} tareas, ${totales.notas} notas y ${totales.habitos} hábitos en este dispositivo.</p>
        <div class="fila-botones">
          <button class="btn" data-accion="exportar-notas">${I.exportar}Notas en Markdown (.zip)</button>
          <button class="btn" data-accion="exportar-json">${I.exportar}Respaldo completo (.json)</button>
          <button class="btn" data-accion="restaurar-json">${I.importar}Restaurar respaldo</button>
        </div>
      </section>

      <section class="panel"><h2>Apariencia</h2>
        <div class="segmentado" role="radiogroup" aria-label="Tema">
          ${[['sistema', 'Como el sistema'], ['claro', 'Claro'], ['oscuro', 'Oscuro']].map(([k, v]) => `
            <label><input type="radio" name="tema" value="${k}" data-cambio="tema" ${tema === k ? 'checked' : ''}><span>${v}</span></label>`).join('')}
        </div>
      </section>

      <section class="panel"><h2>Instalar la app</h2>
        ${instalada ? '<p>Ya estás usando la app instalada.</p>'
          : eventoInstalar ? `<p>Instálala para abrirla desde su propio ícono, sin barra del navegador.</p><button class="btn btn-primario" data-accion="instalar">Instalar Gestor agenda</button>`
          : `<p class="ayuda">En el celular (Chrome): menú ⋮ › <b>Agregar a la pantalla principal</b> o <b>Instalar app</b>.<br>En el computador (Chrome o Edge): ícono de instalar al final de la barra de direcciones.</p>`}
      </section>

      <section class="panel solo-escritorio"><h2>Atajos de teclado</h2>
        <dl class="atajos">
          <div><dt><kbd>N</kbd></dt><dd>Nueva tarea, nota o hábito según la sección</dd></div>
          <div><dt><kbd>/</kbd></dt><dd>Buscar en notas</dd></div>
          <div><dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Cambiar de sección</dd></div>
          <div><dt><kbd>Ctrl</kbd> <kbd>S</kbd></dt><dd>Guardar la nota al instante</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Cerrar ventana</dd></div>
        </dl>
      </section>
    </div>`;
  pintarIndicadores(sync.getEstado());
}

function panelRecordatorios(cfg, ses) {
  const p = avisos.permiso();
  const estadoPermiso = { granted: 'Permitidas', denied: 'Bloqueadas', default: 'Sin decidir', 'no-soportado': 'Este navegador no las admite' }[p];
  let cerrada;
  if (!cfg || !ses) cerrada = '<p class="ayuda">Para recibir avisos con la app cerrada, primero conecta el respaldo en la nube.</p>';
  else if (avisos.pushActivo()) cerrada = `<p>Activos en este dispositivo.</p>
    <div class="fila-botones"><button class="btn" data-accion="probar-push">Probar con la app cerrada</button>
    <button class="btn btn-texto" data-accion="desactivar-push">Desactivar</button></div>`;
  else cerrada = `<p class="ayuda">Necesita la función «avisos» en tu Supabase (una sola vez, ver guía abajo).</p>
    <button class="btn btn-primario" data-accion="activar-push" ${p === 'denied' ? 'disabled' : ''}>Activar en este dispositivo</button>`;
  return `<section class="panel"><h2>Recordatorios</h2>
    <dl class="datos-sync"><div><dt>Notificaciones</dt><dd>${estadoPermiso}</dd></div></dl>
    ${p === 'default' ? '<button class="btn btn-primario" data-accion="permitir-avisos">Permitir notificaciones</button>' : ''}
    ${p === 'denied' ? '<p class="ayuda aviso">Están bloqueadas. En Chrome: candado o ⋮ › Configuración del sitio › Notificaciones › Permitir. En la app instalada: mantén presionado el ícono › Información de la app › Notificaciones.</p>' : ''}
    ${p === 'granted' ? '<button class="btn" data-accion="probar-aviso">Ver un aviso de prueba</button>' : ''}
    <h3>Con la app cerrada</h3>
    ${cerrada}
    <details class="guia" ${clavesGeneradas ? 'open' : ''}>
      <summary>Configurar el servidor de avisos en Supabase</summary>
      <ol>
        <li>Pulsa <b>Generar claves</b> y copia los dos valores.</li>
        <li>En Supabase: <b>Edge Functions › Secrets</b>, crea <code>VAPID_PRIVATE_KEY</code> y <code>AVISOS_SECRETO</code> con esos valores.</li>
        <li><b>Edge Functions › Deploy a new function › Via Editor</b>, nómbrala <code>avisos</code>, pega el archivo <code>supabase/functions/avisos/index.ts</code> y despliégala. En sus ajustes, desactiva <b>Verify JWT</b>.</li>
        <li>En el <b>SQL Editor</b>, ejecuta <code>supabase/avisos_cron.sql</code> con tu URL y el mismo secreto.</li>
        <li>Vuelve aquí y pulsa <b>Activar en este dispositivo</b> (en el celular y en el PC).</li>
      </ol>
      ${clavesGeneradas ? '' : '<button class="btn" data-accion="generar-claves">Generar claves</button>'}
      <div id="claves-generadas" class="claves">${clavesGeneradas ? htmlClaves(clavesGeneradas) : ''}</div>
    </details>
  </section>`;
}

function htmlClaves(c) {
  return `
    <label class="campo"><span>VAPID_PRIVATE_KEY</span><textarea readonly rows="3" class="codigo">${esc(c.privada)}</textarea></label>
    <button class="btn" data-accion="copiar" data-valor="${esc(c.privada)}">${I.copiar}Copiar clave privada</button>
    <label class="campo"><span>AVISOS_SECRETO</span><input readonly class="codigo" value="${esc(c.secreto)}"></label>
    <button class="btn" data-accion="copiar" data-valor="${esc(c.secreto)}">${I.copiar}Copiar secreto</button>
    <p class="ayuda aviso">Pégalas en Supabase antes de cerrar la app: no se guardan en ningún lado. No las compartas.</p>
    <button class="btn btn-texto" data-accion="ocultar-claves">Ya las guardé, ocultar</button>`;
}

function abrirArea(id) {
  const a = id ? db.obtener('areas', id) : { id: uid(), nombre: '', color: COLORES[areasOrdenadas().length % COLORES.length], orden: areasOrdenadas().length };
  abrirDialogo(`
    <form method="dialog" class="formulario" data-form="area" data-id="${a.id}">
      <header class="dlg-cabecera"><h2>${id ? 'Editar categoría' : 'Nueva categoría'}</h2>
        <button type="button" class="btn-icono" data-accion="cerrar-dialogo" aria-label="Cerrar">${I.cerrar}</button></header>
      <label class="campo"><span>Nombre</span><input name="nombre" required value="${esc(a.nombre)}" placeholder="Pagos, Casa, Universidad…" autocomplete="off"></label>
      <fieldset class="campo colores"><legend>Color</legend>
        ${COLORES.map(c => `<label><input type="radio" name="color" value="${c}" ${c === a.color ? 'checked' : ''}><span style="--c:${c}" aria-label="Color ${c}"></span></label>`).join('')}
      </fieldset>
      <footer class="dlg-pie">
        ${id ? `<button type="button" class="btn btn-peligro" data-accion="eliminar-area" data-id="${a.id}">${I.basura}Eliminar</button>` : ''}
        <span class="separador"></span>
        <button type="button" class="btn" data-accion="cerrar-dialogo">Cancelar</button>
        <button type="submit" class="btn btn-primario">${id ? 'Guardar cambios' : 'Crear categoría'}</button></footer>
    </form>`);
  setTimeout(() => $('#dlg input[name=nombre]')?.focus(), 50);
}

function exportarJSON() {
  const datos = { app: 'gestor-agenda', version: 1, exportado: new Date().toISOString() };
  for (const t of db.TIPOS) datos[t] = db.lista(t, { incluirEliminados: false }).map(db.limpio);
  descargar(`${imp.nombreExport('gestor-agenda-respaldo')}.json`, new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' }));
  toast('Respaldo descargado');
}

function restaurarJSON() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    try {
      const datos = JSON.parse(await inp.files[0].text());
      if (datos.app !== 'gestor-agenda') throw new Error('formato');
      const n = db.TIPOS.reduce((s, t) => s + (datos[t]?.length || 0), 0);
      if (!confirm(`Se agregarán o actualizarán ${n} registros desde el respaldo. Los que ya existan con el mismo identificador se reemplazarán. ¿Continuar?`)) return;
      await db.reemplazarTodo(datos);
      toast(`Respaldo restaurado: ${n} registros`);
    } catch { toast('Ese archivo no es un respaldo de Gestor agenda.'); }
  };
  inp.click();
}

// =====================================================================
//  Diálogos
// =====================================================================
function abrirDialogo(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  if (!d.open) d.showModal();
}
function cerrarDialogo() {
  const d = $('#dlg');
  if (d.open) d.close();
}

// =====================================================================
//  Eventos
// =====================================================================
async function alHacerClic(ev) {
  const el = ev.target.closest('[data-accion]');
  if (ev.target.id === 'dlg') { cerrarDialogo(); return; } // clic en el fondo
  const imVista = ev.target.closest('.nota-render img[data-img]');
  if (imVista) return abrirVisor(imVista.dataset.img);
  if (!el) return;
  const { accion, id, valor } = el.dataset;
  switch (accion) {
    case 'alternar-tarea': return alternarTarea(id, el);
    case 'desplegar-subs': { if (ui.desplegadas.has(id)) ui.desplegadas.delete(id); else ui.desplegadas.add(id); return render(); }
    case 'alternar-sub': return alternarSub(id, valor);
    case 'agregar-sub-dlg': return agregarSubDlg();
    case 'quitar-sub-dlg': el.closest('.sub-dlg')?.remove(); return;
    case 'editar-tarea': return abrirTarea(id);
    case 'eliminar-tarea': {
      cerrarDialogo();
      await db.eliminar('tareas', id);
      return toast('Tarea eliminada', { texto: 'Deshacer', fn: () => db.restaurar('tareas', id) });
    }
    case 'mover-vencidas': {
      const v = db.lista('tareas').filter(esVencida);
      await db.guardarVarios('tareas', v.map(t => ({ ...t, fecha: hoy() })));
      return toast(`${v.length} tarea${v.length > 1 ? 's pasadas' : ' pasada'} a hoy`);
    }
    case 'ver-hechas': ui.verHechasHoy = !ui.verHechasHoy; return render();
    case 'filtro': ui.filtro = valor; return render();
    case 'filtrar-area': ui.areaId = id; if (!['hechas', 'sinfecha'].includes(ui.filtro)) ui.filtro = 'todas'; return ir('tareas');
    case 'quitar-area': ui.areaId = null; return render();
    case 'alternar-habito': return alternarHabito(id, el.dataset.fecha);
    case 'nuevo-habito': return abrirHabito();
    case 'editar-habito': return abrirHabito(id);
    case 'eliminar-habito': {
      cerrarDialogo();
      await db.eliminar('habitos', id);
      return toast('Hábito eliminado', { texto: 'Deshacer', fn: () => db.restaurar('habitos', id) });
    }
    case 'nueva-nota': return nuevaNota();
    case 'nueva-nota-clase': return nuevaNota({ clase: true });
    case 'cuaderno': ui.cuaderno = valor; return pintarListaNotas();
    case 'etiqueta': ui.etiqueta = valor; return pintarListaNotas();
    case 'quitar-etiqueta': ui.etiqueta = null; return pintarListaNotas();
    case 'alternar-vista-previa': await guardarNotaYa(); ui.vistaPrevia = !ui.vistaPrevia; return pintarEditorNota();
    case 'fijar-nota': { const n = db.obtener('notas', ui.notaId); await db.guardar('notas', { ...n, fijada: !n.fijada }, { silencioso: true }); return pintarEditorNota(); }
    case 'exportar-nota': {
      await guardarNotaYa();
      const n = db.obtener('notas', ui.notaId);
      let md = imp.notaAMarkdown(n, areasOrdenadas());
      for (const m of [...md.matchAll(imgs.RE_IMG)]) { const u = await imgs.urlImagen(imgs.resolver(n, m[2])); if (u) md = md.split(`(img:${m[2]})`).join(`(${u})`); }
      return descargar(`${nombreArchivo(n.titulo)}.md`, new Blob([md], { type: 'text/markdown' }));
    }
    case 'eliminar-nota': {
      const nid = ui.notaId;
      await db.eliminar('notas', nid);
      ir('notas');
      return toast('Nota eliminada', { texto: 'Deshacer', fn: () => db.restaurar('notas', nid).then(() => ir('notas', nid)) });
    }
    case 'md': return insertarMd(el.dataset.md);
    case 'adjuntar-imagen': return elegirImagenes();
    case 'ver-imagen': return abrirVisor(valor);
    case 'quitar-imagen': return quitarImagen(valor);
    case 'descargar-imagen': {
      const r = await db.obtenerCompleto('imagenes', valor);
      if (!r?.dataUrl) return;
      const ext = (r.dataUrl.match(/^data:image\/(\w+)/) || [])[1] || 'jpg';
      return descargar(`imagen-${valor.slice(0, 8)}.${ext === 'jpeg' ? 'jpg' : ext}`, await (await fetch(r.dataUrl)).blob());
    }
    case 'plantilla-clase': {
      const ta = $('#nota-contenido');
      if (!ta) return;
      if (ui.vistaPrevia) { ui.vistaPrevia = false; pintarEditorNota(); }
      const t = $('#nota-contenido');
      t.value = (t.value.trim() ? t.value.replace(/\s*$/, '\n\n') : '') + plantillaClase(db.obtener('notas', ui.notaId)?.areaId);
      t.focus();
      return guardarNotaYa().then(pintarEditorNota);
    }
    case 'pendientes-a-tareas': await guardarNotaYa(); return pendientesATareas();
    case 'importar': return abrirImportarNotas();
    case 'importar-archivos': cerrarDialogo(); return elegirArchivos();
    case 'pegar-tareas': return abrirPegarTareas();
    case 'volver-pegar': return abrirPegarTareas(previsualizarTareas.texto || '');
    case 'leer-portapapeles': {
      try {
        const t = await navigator.clipboard.readText();
        if (!t.trim()) return toast('El portapapeles está vacío. Copia primero tus tareas.');
        $('#dlg textarea[name=texto]').value = t;
      } catch { toast('No pude leer lo copiado. Mantén presionado el cuadro y elige Pegar.'); }
      return;
    }
    case 'compartido-nota': return compartidoComoNota();
    case 'compartido-tareas': {
      const it = textoCompartido;
      if (!it) return;
      ir('tareas');
      return previsualizarTareas([it.titulo, it.texto].filter(Boolean).join('\n'));
    }
    case 'pegar': return abrirPegar();
    case 'marcar-todas': $$('#dlg input[name=sel]').forEach(c => { c.checked = valor === '1'; }); return actualizarBotonImport();
    case 'nueva-area': return abrirArea();
    case 'agregar-sugerida': await agregarCategorias([valor]); return toast(`Categoría «${valor}» creada`);
    case 'editar-area': return abrirArea(id);
    case 'eliminar-area': {
      const a = db.obtener('areas', id);
      const n = db.lista('tareas').filter(t => t.areaId === id).length + db.lista('notas').filter(t => t.areaId === id).length;
      if (n && !confirm(`«${a.nombre}» tiene ${n} tareas o notas. Quedarán sin categoría, no se borran. ¿Eliminar la categoría?`)) return;
      cerrarDialogo();
      if (ui.areaId === id) ui.areaId = null;
      await db.eliminar('areas', id);
      return toast('Categoría eliminada', { texto: 'Deshacer', fn: () => db.restaurar('areas', id) });
    }
    case 'sincronizar': return sync.sincronizar();
    case 'salir': await sync.salir(); return render();
    case 'olvidar-supabase': sync.setConfig(null); return render();
    case 'instalar': if (eventoInstalar) { eventoInstalar.prompt(); await eventoInstalar.userChoice; eventoInstalar = null; render(); } return;
    case 'exportar-notas': {
      const notas = db.lista('notas');
      if (!notas.length) return toast('No hay notas para exportar.');
      descargar(`${imp.nombreExport('notas')}.zip`, await imp.exportarZip(notas, areasOrdenadas(), (n, ref) => imgs.urlImagen(imgs.resolver(n, ref))));
      return toast(`${notas.length} notas exportadas`);
    }
    case 'exportar-json': return exportarJSON();
    case 'restaurar-json': return restaurarJSON();
    case 'cerrar-dialogo': return cerrarDialogo();
    case 'actualizar-app': return actualizarApp();
    // Recordatorios
    case 'posponer-dialogo': return abrirPosponer(id);
    case 'posponer': cerrarDialogo(); return posponer(id, Number(valor));
    case 'posponer-hasta': cerrarDialogo(); return posponer(id, 0, Number(valor));
    case 'hecha-desde-aviso': cerrarDialogo(); return alternarTarea(id);
    case 'permitir-avisos': await avisos.pedirPermiso(); return render();
    case 'activar-push': {
      el.disabled = true;
      try { await avisos.activarPush(); toast('Listo: recibirás avisos aunque la app esté cerrada.'); }
      catch (e) { toast(e.message); }
      return render();
    }
    case 'desactivar-push': await avisos.desactivarPush().catch(() => {}); toast('Avisos con la app cerrada desactivados en este dispositivo.'); return render();
    case 'probar-aviso': {
      if (avisos.permiso() !== 'granted' && (await avisos.pedirPermiso()) !== 'granted') return toast('Primero permite las notificaciones.');
      await avisos.mostrarLocal({ id: 'prueba', titulo: 'Así se verán tus recordatorios', avisarEn: Date.now(), aviso: { repetirMin: 1 } }, { forzar: true, cuerpo: 'Usa "Posponer" o "Marcar hecha".' });
      return;
    }
    case 'probar-push': {
      const t = { id: uid(), titulo: 'Prueba de aviso con la app cerrada', notas: 'Puedes borrar esta tarea.', prioridad: 'baja', fecha: hoy(), hora: null, recurrencia: '', areaId: null, completada: false,
        aviso: { activo: true, diasAntes: 0, hora: '00:00', repetirMin: 1440 }, avisarEn: Date.now() + 60000 };
      await db.guardar('tareas', t);
      await sync.sincronizar();
      return toast('Cierra la app. En 1 o 2 minutos debe llegar el aviso.');
    }
    case 'generar-claves': {
      clavesGeneradas = await avisos.generarClaves();
      $('#claves-generadas').innerHTML = htmlClaves(clavesGeneradas);
      return;
    }
    case 'ocultar-claves': clavesGeneradas = null; return render();
    case 'copiar': try { await navigator.clipboard.writeText(valor); toast('Copiado'); } catch { toast('No se pudo copiar; selecciónalo y cópialo a mano.'); } return;
    // Finanzas
    case 'fpestana': ui.fpestana = valor; return render();
    case 'fmes': ui.fmes = Number(valor) === 0 ? fin.mesActual() : fin.moverMes(ui.fmes, Number(valor)); return render();
    case 'nuevo-mov': return abrirMovimiento(null, valor);
    case 'editar-mov': return abrirMovimiento(id);
    case 'eliminar-mov': {
      cerrarDialogo();
      await db.eliminar('movimientos', id);
      return toast('Movimiento eliminado', { texto: 'Deshacer', fn: () => db.restaurar('movimientos', id) });
    }
    case 'nueva-deuda': return abrirDeuda();
    case 'saldo-base': return abrirSaldoBase();
    case 'nuevo-ahorro': return abrirAhorro();
    case 'editar-ahorro': return abrirAhorro(id);
    case 'aporte-ahorro': return abrirAporte(id);
    case 'eliminar-ahorro': {
      const a = db.obtener('ahorros', id);
      if (!confirm(`¿Eliminar «${a.nombre}»? Los gastos o ingresos ya registrados se mantienen.`)) return;
      cerrarDialogo();
      await db.eliminar('ahorros', id);
      return toast('Ahorro eliminado', { texto: 'Deshacer', fn: () => db.restaurar('ahorros', id) });
    }
    case 'abrir-deuda': return abrirDeuda(id);
    case 'abonar': return abrirAbono(id);
    case 'ver-saldadas': ui.verSaldadas = !ui.verSaldadas; return render();
    case 'borrar-abono': {
      const d = db.obtener('deudas', id);
      const ab = d.abonos.find(a => a.id === valor);
      if (!confirm(`¿Borrar el abono de ${fin.pesos(ab.monto)}?${ab.movimientoId ? ' También se borrará el movimiento registrado.' : ''}`)) return;
      await db.guardar('deudas', { ...d, abonos: d.abonos.filter(a => a.id !== valor) });
      if (ab.movimientoId) await db.eliminar('movimientos', ab.movimientoId);
      return abrirDeuda(id);
    }
    case 'eliminar-deuda': {
      cerrarDialogo();
      await db.eliminar('deudas', id);
      return toast('Deuda eliminada', { texto: 'Deshacer', fn: () => db.restaurar('deudas', id) });
    }
    case 'exportar-csv': {
      const movs = db.lista('movimientos').filter(m => fin.mesDe(m.fecha) === ui.fmes);
      if (!movs.length) return toast('No hay movimientos en este mes.');
      descargar(`movimientos-${ui.fmes}.csv`, new Blob([fin.movimientosCSV(movs)], { type: 'text/csv;charset=utf-8' }));
      return toast(`${movs.length} movimientos descargados`);
    }
  }
}

function actualizarBotonImport() {
  const n = $$('#dlg input[name=sel]:checked').length;
  const b = $('#btn-importar');
  const tareas = !!$('#dlg [data-form=importar-tareas]');
  if (b) { b.textContent = tareas ? `Crear ${n} tarea${n === 1 ? '' : 's'}` : `Importar ${n} nota${n === 1 ? '' : 's'}`; b.disabled = !n; }
}

document.addEventListener('submit', async ev => {
  const f = ev.target;
  const tipo = f.dataset.form;
  if (!tipo) return;
  ev.preventDefault();
  if (tipo === 'sub-rapida') {
    const titulo = f.titulo.value.trim();
    const t = db.obtener('tareas', f.dataset.id);
    if (!titulo || !t) return;
    ui.desplegadas.add(t.id);
    await db.guardar('tareas', { ...t, subtareas: [...(t.subtareas || []), { id: uid(), titulo, hecha: false }] });
    $(`.tarea[data-id="${t.id}"] .sub-nueva input`)?.focus();
    return;
  }
  if (tipo === 'captura') { await agregarRapido(f); f.reset(); $('#captura')?.focus(); return; }
  if (tipo === 'tarea') return guardarTareaDesdeForm(f);
  if (tipo === 'habito') {
    const fd = new FormData(f);
    const previo = db.obtener('habitos', f.dataset.id) || { id: f.dataset.id, registro: {} };
    let dias = fd.getAll('dias').map(Number);
    if (dias.length === 7 || !dias.length) dias = [];
    cerrarDialogo();
    await db.guardar('habitos', { ...previo, nombre: fd.get('nombre').trim(), dias });
    return toast(previo.nombre ? 'Cambios guardados' : 'Hábito creado');
  }
  if (tipo === 'area') {
    const fd = new FormData(f);
    const previa = db.obtener('areas', f.dataset.id) || { id: f.dataset.id, orden: areasOrdenadas().length };
    cerrarDialogo();
    await db.guardar('areas', { ...previa, nombre: fd.get('nombre').trim(), color: fd.get('color') || COLORES[0] });
    return toast(previa.nombre ? 'Cambios guardados' : 'Categoría creada');
  }
  if (tipo === 'importar') return confirmarImport(f);
  if (tipo === 'pegar-tareas') return previsualizarTareas(new FormData(f).get('texto'));
  if (tipo === 'importar-tareas') return crearTareasPegadas(f);
  if (tipo === 'pago-tarea') {
    const fd = new FormData(f);
    const t = db.obtener('tareas', f.dataset.id);
    cerrarDialogo();
    const monto = ev.submitter?.value === 'con' ? fin.leerMonto(fd.get('monto')) : 0;
    return completarTarea(t, monto ? { monto, categoria: fd.get('categoria') } : null);
  }
  if (tipo === 'posponer') {
    const v = new FormData(f).get('cuando');
    if (!v) return toast('Elige una fecha y hora, o usa una de las opciones.');
    const ms = new Date(v).getTime();
    if (ms <= Date.now()) return toast('Esa hora ya pasó.');
    cerrarDialogo();
    return posponer(f.dataset.id, 0, ms);
  }
  if (tipo === 'movimiento') {
    const fd = new FormData(f);
    const monto = fin.leerMonto(fd.get('monto'));
    if (!monto) return toast('Escribe el valor.');
    const previo = db.obtener('movimientos', f.dataset.id) || { id: f.dataset.id };
    cerrarDialogo();
    const m = { ...previo, clase: fd.get('clase'), monto, categoria: fd.get('categoria'), fecha: fd.get('fecha') || hoy(), descripcion: fd.get('descripcion').trim() };
    await db.guardar('movimientos', m);
    if (fin.mesDe(m.fecha) !== ui.fmes) ui.fmes = fin.mesDe(m.fecha);
    return toast(previo.clase ? 'Cambios guardados' : `${m.clase === 'gasto' ? 'Gasto' : 'Ingreso'} de ${fin.pesos(monto)} registrado`);
  }
  if (tipo === 'saldo-base') {
    const fd = new FormData(f);
    const monto = fin.leerMonto(fd.get('monto'));
    const fecha = fd.get('fecha') || hoy();
    const previa = fin.saldoBase(db.lista('movimientos'));
    cerrarDialogo();
    // Un solo saldo inicial: se actualiza el existente
    await db.guardar('movimientos', { ...(previa || { id: uid() }), clase: 'base', monto, fecha, categoria: '', descripcion: 'Saldo inicial', creadoEn: Date.now() });
    ui.fmes = fin.mesActual();
    return toast(`Saldo inicial guardado: ${fin.pesos(monto)}`);
  }
  if (tipo === 'ahorro') {
    const fd = new FormData(f);
    const previo = db.obtener('ahorros', f.dataset.id) || { id: f.dataset.id, historial: [] };
    const monto = fin.leerMonto(fd.get('monto'));
    const a = { ...previo, nombre: fd.get('nombre').trim(), monto, meta: fin.leerMonto(fd.get('meta')), nota: fd.get('nota').trim() };
    if (previo.nombre && monto !== previo.monto) a.historial = [...(previo.historial || []), { id: uid(), fecha: hoy(), monto: monto - (previo.monto || 0), nota: 'Ajuste de valor' }];
    cerrarDialogo();
    await db.guardar('ahorros', a);
    ui.fpestana = 'ahorros';
    if (ui.vista === 'finanzas') render();
    return toast(previo.nombre ? 'Cambios guardados' : `Ahorro agregado: ${fin.pesos(monto)}`);
  }
  if (tipo === 'aporte') {
    const fd = new FormData(f);
    const a = db.obtener('ahorros', f.dataset.id);
    const valor = fin.leerMonto(fd.get('monto'));
    if (!valor) return toast('Escribe el valor.');
    const agregar = fd.get('tipo') === 'agregar';
    if (!agregar && valor > (a.monto || 0)) return toast(`No puedes retirar más de ${fin.pesos(a.monto)}.`);
    const mov = { id: uid(), fecha: fd.get('fecha') || hoy(), monto: agregar ? valor : -valor, nota: fd.get('nota').trim() };
    if (fd.get('registrar') === 'on') {
      const m = { id: uid(), clase: agregar ? 'gasto' : 'ingreso', monto: valor, fecha: mov.fecha, categoria: agregar ? 'Ahorro' : 'Otros ingresos',
        descripcion: `${agregar ? 'Ahorro en' : 'Retiro de'} ${a.nombre}${mov.nota ? ' · ' + mov.nota : ''}`, ahorroId: a.id };
      await db.guardar('movimientos', m);
      mov.movimientoId = m.id;
    }
    cerrarDialogo();
    const nuevo = await db.guardar('ahorros', { ...a, monto: (a.monto || 0) + mov.monto, historial: [...(a.historial || []), mov] });
    return toast(`${a.nombre}: ${fin.pesos(nuevo.monto)}`);
  }
  if (tipo === 'deuda') {
    const fd = new FormData(f);
    const monto = fin.leerMonto(fd.get('monto'));
    if (!monto) return toast('Escribe el valor total.');
    const previa = db.obtener('deudas', f.dataset.id) || { id: f.dataset.id, abonos: [] };
    cerrarDialogo();
    const d = { ...previa, sentido: fd.get('sentido'), persona: fd.get('persona').trim(), concepto: fd.get('concepto').trim(), monto, fecha: fd.get('fecha') || hoy(), vence: fd.get('vence') || '' };
    await db.guardar('deudas', d);
    ui.fpestana = 'deudas';
    if (ui.vista === 'finanzas') render();
    return toast(previa.persona ? 'Cambios guardados' : 'Deuda creada');
  }
  if (tipo === 'abono') {
    const fd = new FormData(f);
    const d = db.obtener('deudas', f.dataset.id);
    const monto = fin.leerMonto(fd.get('monto'));
    if (!monto) return toast('Escribe el valor.');
    const debo = d.sentido === 'debo';
    const abono = { id: uid(), fecha: fd.get('fecha') || hoy(), monto, nota: fd.get('nota').trim() };
    if (fd.get('registrar') === 'on') {
      const mov = { id: uid(), clase: debo ? 'gasto' : 'ingreso', monto, fecha: abono.fecha, categoria: debo ? 'Deudas' : 'Cobro de deuda',
        descripcion: `${debo ? 'Abono a' : 'Pago de'} ${d.persona}${abono.nota ? ' · ' + abono.nota : ''}`, deudaId: d.id };
      await db.guardar('movimientos', mov);
      abono.movimientoId = mov.id;
    }
    cerrarDialogo();
    const nueva = await db.guardar('deudas', { ...d, abonos: [...(d.abonos || []), abono] });
    return toast(fin.saldada(nueva) ? `¡Deuda con ${d.persona} saldada!` : `Abono guardado. Saldo: ${fin.pesos(fin.saldo(nueva))}`);
  }
  if (tipo === 'pegar') {
    const notas = imp.dividirTexto(new FormData(f).get('texto'));
    return mostrarPrevia(notas);
  }
  if (tipo === 'supabase') {
    const fd = new FormData(f);
    const url = fd.get('url').trim().replace(/\/+$/, '');
    const key = fd.get('key').trim();
    if (!/^https:\/\/.+/.test(url)) return toast('La URL debe empezar por https://');
    if (/service_role|sb_secret_/i.test(key) || (() => { try { return JSON.parse(atob(key.split('.')[1])).role === 'service_role'; } catch { return false; } })()) {
      return toast('Esa es una clave secreta. Usa la clave publishable o anon.');
    }
    sync.setConfig({ url, key });
    toast('Conexión guardada. Ahora entra o crea tu cuenta.');
    return render();
  }
  if (tipo === 'login') {
    const fd = new FormData(f);
    const modo = ev.submitter?.value || 'entrar';
    const botones = $$('button', f);
    botones.forEach(b => { b.disabled = true; });
    try {
      if (modo === 'registrar') {
        const r = await sync.registrarse(fd.get('email').trim(), fd.get('password'));
        toast(r === 'confirmar' ? 'Cuenta creada. Abre el enlace que llegó a tu correo y luego entra aquí.' : 'Cuenta creada. Sincronizando…');
      } else {
        await sync.entrar(fd.get('email').trim(), fd.get('password'));
        toast('Sesión iniciada. Sincronizando…');
      }
      render();
    } catch (e) {
      toast(e.message);
      botones.forEach(b => { b.disabled = false; });
    }
  }
});

document.addEventListener('focusout', ev => { if (ev.target.id === 'nota-contenido') ev.target.dataset.pos = String(ev.target.selectionStart); });
document.addEventListener('paste', ev => {
  if (ev.target.id !== 'nota-contenido') return;
  const files = [...(ev.clipboardData?.files || [])].filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  ev.preventDefault();
  ev.target.dataset.pos = String(ev.target.selectionStart);
  adjuntarImagenes(files);
});
document.addEventListener('dragover', ev => { if (ev.target.closest?.('#editor-nota') && [...(ev.dataTransfer?.items || [])].some(i => i.kind === 'file')) { ev.preventDefault(); $('#editor-nota').classList.add('soltando'); } });
document.addEventListener('dragleave', ev => { if (ev.target.id === 'editor-nota' || !ev.relatedTarget) $('#editor-nota')?.classList.remove('soltando'); });
document.addEventListener('drop', ev => {
  if (!ev.target.closest?.('#editor-nota')) return;
  $('#editor-nota').classList.remove('soltando');
  const files = [...(ev.dataTransfer?.files || [])].filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  ev.preventDefault();
  const ta = $('#nota-contenido');
  if (ta && ev.target === ta) ta.dataset.pos = String(ta.selectionStart);
  adjuntarImagenes(files);
});

document.addEventListener('input', ev => {
  const t = ev.target;
  if (t.dataset.input === 'nota') { const e = $('#estado-guardado'); if (e) e.textContent = 'Guardando…'; guardarNota(); }
  if (t.dataset.input === 'buscar') { ui.busqueda = t.value; pintarListaNotas(); }
  if (t.name === 'sel') actualizarBotonImport();
  if (t.hasAttribute?.('data-monto')) {
    const n = fin.leerMonto(t.value);
    t.value = n ? fin.numero(n) : '';
  }
});

document.addEventListener('change', async ev => {
  const t = ev.target;
  const c = t.dataset.cambio;
  if (c === 'area-filtro') { ui.areaId = t.value || null; render(); }
  if (c === 'cuaderno-nota') { const n = db.obtener('notas', ui.notaId); await db.guardar('notas', { ...n, areaId: t.value || null }, { silencioso: true }); }
  if (c === 'tema') { localStorage.setItem('ga-tema', t.value); aplicarTema(t.value); }
  if (c === 'tipo-aporte') { const e = $('#txt-registrar'); if (e) e.textContent = t.value === 'agregar' ? 'Descontarlo del disponible (se registra como gasto «Ahorro»)' : 'Sumarlo al disponible (se registra como ingreso)'; }
  if (c === 'clase-mov') { const sel = $('#dlg select[name=categoria]'); if (sel) sel.innerHTML = opcionesCategorias(t.value); }
});

$('#dlg').addEventListener('close', () => { if (ui.vista !== 'notas') render(); });

function atajos(ev) {
  if (ev.target.id === 'nueva-sub' && ev.key === 'Enter') { ev.preventDefault(); agregarSubDlg(); return; }
  if (ev.target.id === 'nota-titulo' && ev.key === 'Enter') { ev.preventDefault(); $('#nota-contenido')?.focus(); return; }
  const enCampo = ev.target.closest('input, textarea, select, [contenteditable]');
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    if (ui.vista === 'notas' && ui.notaId) { ev.preventDefault(); guardarNotaYa(); toast('Nota guardada'); }
    return;
  }
  if (enCampo || ev.ctrlKey || ev.metaKey || ev.altKey || $('dialog[open]')) return;
  const k = ev.key;
  if (/^[1-6]$/.test(k)) { ev.preventDefault(); return ir(Object.keys(VISTAS)[Number(k) - 1]); }
  if (k === '/') { ev.preventDefault(); if (ui.vista !== 'notas') ir('notas'); setTimeout(() => $('#buscar-notas')?.focus(), 30); return; }
  if (k.toLowerCase() === 'n') { ev.preventDefault(); accionPrincipal(true); }
}

function accionPrincipal(teclado = false) {
  if (ui.vista === 'notas') return nuevaNota();
  if (ui.vista === 'finanzas') return ui.fpestana === 'deudas' ? abrirDeuda() : ui.fpestana === 'ahorros' ? abrirAhorro() : abrirMovimiento();
  if (ui.vista === 'habitos') return abrirHabito();
  if (teclado && $('#captura')) return $('#captura').focus();
  return abrirTarea(null);
}
$('#fab').addEventListener('click', () => accionPrincipal());

// =====================================================================
//  Tema, service worker y actualizaciones
// =====================================================================
function aplicarTema(t) {
  const oscuro = t === 'oscuro' || (t === 'sistema' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.tema = oscuro ? 'oscuro' : 'claro';
  $('meta[name=theme-color]').setAttribute('content', oscuro ? '#0F1522' : '#F6F7F9');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => aplicarTema(localStorage.getItem('ga-tema') || 'sistema'));

let swEsperando = null;
async function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    const avisar = w => { swEsperando = w; const b = $('#banner-actualizar'); b.hidden = false; };
    if (reg.waiting && navigator.serviceWorker.controller) avisar(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) avisar(w); });
    });
    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!recargando) { recargando = true; location.reload(); } });
    setInterval(() => reg.update(), 60 * 60 * 1000);
  } catch (e) { console.warn('Service worker no registrado', e); }
}

async function actualizarApp() {
  await guardarNotaYa();
  swEsperando?.postMessage('actualizar');
}

iniciar();
