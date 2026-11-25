// Almacenamiento local (IndexedDB) + estado en memoria
// Cada registro lleva: id, creadoEn, actualizadoEn (ms), eliminado, _dirty (pendiente de subir)

export const TIPOS = ['areas', 'tareas', 'habitos', 'notas', 'movimientos', 'deudas', 'ahorros', 'imagenes'];
const DB_NAME = 'gestor-agenda';
const DB_VERSION = 4;

// Tipos pesados: en memoria solo se guardan los metadatos; el contenido (dataUrl) vive en IndexedDB
export const PESADOS = new Set(['imagenes']);
const soloMeta = o => { const { dataUrl, ...m } = o; return m; };

// La misma función de actualización la usa el service worker (sw.js). Si cambias una, cambia la otra.
export function upgradeDB(db) {
  for (const s of TIPOS) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  if (!db.objectStoreNames.contains('share')) db.createObjectStore('share', { autoIncrement: true });
}

let dbPromise;
function abrir() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => upgradeDB(r.result);
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        res(db);
      };
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}

function req(store, modo, fn) {
  return abrir().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, modo);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

export const idb = {
  getAll: s => req(s, 'readonly', st => st.getAll()),
  get: (s, k) => req(s, 'readonly', st => st.get(k)),
  put: (s, v) => req(s, 'readwrite', st => st.put(v)),
  putMany: (s, arr) => req(s, 'readwrite', st => { arr.forEach(v => st.put(v)); }),
  clear: s => req(s, 'readwrite', st => st.clear()),
  metaGet: k => req('meta', 'readonly', st => st.get(k)),
  metaSet: (k, v) => req('meta', 'readwrite', st => st.put(v, k)),
  /** Saca (y borra) lo que el sistema compartió con la app */
  async shareTake() {
    const items = await req('share', 'readonly', st => st.getAll());
    await req('share', 'readwrite', st => st.clear());
    return items || [];
  },
};

// ---------------- Estado en memoria ----------------
const state = Object.fromEntries(TIPOS.map(t => [t, new Map()]));
const oyentes = new Set();

export function onChange(fn) { oyentes.add(fn); return () => oyentes.delete(fn); }
function emitir(detalle) { oyentes.forEach(fn => { try { fn(detalle); } catch (e) { console.error(e); } }); }

export async function cargar() {
  for (const t of TIPOS) {
    const arr = await idb.getAll(t);
    state[t].clear();
    arr.forEach(o => state[t].set(o.id, PESADOS.has(t) ? soloMeta(o) : o));
  }
}

export function lista(tipo, { incluirEliminados = false } = {}) {
  const arr = [...state[tipo].values()];
  return incluirEliminados ? arr : arr.filter(o => !o.eliminado);
}

export function obtener(tipo, id) {
  const o = state[tipo].get(id);
  return o && !o.eliminado ? o : null;
}

/** Registro completo desde IndexedDB (para tipos pesados, incluye el contenido) */
export async function obtenerCompleto(tipo, id) {
  return PESADOS.has(tipo) ? idb.get(tipo, id) : state[tipo].get(id) || null;
}

/** Si el objeto de un tipo pesado llega sin contenido, se completa con lo guardado */
async function completar(tipo, o) {
  if (!PESADOS.has(tipo) || 'dataUrl' in o) return o;
  const previo = await idb.get(tipo, o.id);
  return { ...(previo || {}), ...o };
}

/** Guarda un registro creado o modificado en el dispositivo */
export async function guardar(tipo, obj, { silencioso = false } = {}) {
  const ahora = Date.now();
  const o = await completar(tipo, { ...obj, creadoEn: obj.creadoEn || ahora, actualizadoEn: Math.max(ahora, (obj.actualizadoEn || 0) + 1), _dirty: true });
  state[tipo].set(o.id, PESADOS.has(tipo) ? soloMeta(o) : o);
  await idb.put(tipo, o);
  emitir({ tipo, id: o.id, origen: 'local', silencioso });
  return state[tipo].get(o.id);
}

export async function guardarVarios(tipo, objs) {
  const ahora = Date.now();
  const arr = await Promise.all(objs.map((obj, i) => completar(tipo, { ...obj, creadoEn: obj.creadoEn || ahora, actualizadoEn: ahora + i, _dirty: true })));
  arr.forEach(o => state[tipo].set(o.id, PESADOS.has(tipo) ? soloMeta(o) : o));
  await idb.putMany(tipo, arr);
  emitir({ tipo, origen: 'local' });
  return arr;
}

/** Borrado "suave": queda una marca para que el borrado también llegue a la nube */
export async function eliminar(tipo, id) {
  const o = state[tipo].get(id);
  if (!o) return;
  return guardar(tipo, { ...o, eliminado: true });
}

export async function restaurar(tipo, id) {
  const o = state[tipo].get(id);
  if (!o) return;
  return guardar(tipo, { ...o, eliminado: false });
}

// ---------------- Soporte para sincronización ----------------
export function pendientes() {
  const out = [];
  for (const t of TIPOS) for (const o of state[t].values()) if (o._dirty) out.push({ tipo: t, obj: o });
  return out;
}

export async function marcarSubido(tipo, id, version) {
  const o = state[tipo].get(id);
  if (o && o.actualizadoEn === version && o._dirty) {
    o._dirty = false;
    if (PESADOS.has(tipo)) {
      const completo = await idb.get(tipo, id);
      if (completo) await idb.put(tipo, { ...completo, _dirty: false });
    } else {
      await idb.put(tipo, o);
    }
  }
}

/** Aplica un registro que viene de la nube. Gana la versión más reciente. */
export async function aplicarRemotos(filas) {
  const porTipo = {};
  for (const r of filas) {
    if (!state[r.tipo]) continue;
    const local = state[r.tipo].get(r.id);
    if (local && local.actualizadoEn >= Number(r.actualizado_en)) continue;
    const o = { ...r.data, id: r.id, actualizadoEn: Number(r.actualizado_en), eliminado: !!r.eliminado, _dirty: false };
    state[r.tipo].set(o.id, PESADOS.has(r.tipo) ? soloMeta(o) : o);
    (porTipo[r.tipo] ||= []).push(o);
  }
  let n = 0;
  for (const [t, arr] of Object.entries(porTipo)) { await idb.putMany(t, arr); n += arr.length; }
  if (n) emitir({ origen: 'remoto' });
  return n;
}

/** Datos limpios (sin campos internos) para respaldo o subida */
export function limpio(o) {
  const { _dirty, ...resto } = o;
  return resto;
}

export async function reemplazarTodo(datos) {
  for (const t of TIPOS) {
    const arr = (datos[t] || []).map(o => ({ ...o, actualizadoEn: Date.now(), _dirty: true }));
    for (const o of arr) state[t].set(o.id, PESADOS.has(t) ? soloMeta(o) : o);
    await idb.putMany(t, arr);
  }
  emitir({ origen: 'local' });
}

/**
 * Si dos dispositivos crearon un área con el mismo nombre (p. ej. las áreas
 * iniciales), se conserva la más antigua y se reasignan tareas y notas.
 */
export async function deduplicarAreas() {
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const porNombre = new Map();
  const reemplazos = new Map();
  for (const a of lista('areas').sort((x, y) => (x.creadoEn || 0) - (y.creadoEn || 0) || x.id.localeCompare(y.id))) {
    const k = norm(a.nombre);
    if (porNombre.has(k)) reemplazos.set(a.id, porNombre.get(k));
    else porNombre.set(k, a.id);
  }
  if (!reemplazos.size) return 0;
  for (const t of ['tareas', 'notas']) {
    const cambiar = lista(t).filter(o => reemplazos.has(o.areaId)).map(o => ({ ...o, areaId: reemplazos.get(o.areaId) }));
    if (cambiar.length) await guardarVarios(t, cambiar);
  }
  await guardarVarios('areas', [...reemplazos.keys()].map(id => ({ ...state.areas.get(id), eliminado: true })));
  return reemplazos.size;
}
