// Sincronización con Supabase (respaldo en la nube)
// Estrategia: primero bajar cambios (pull), luego subir los pendientes (push).
// Si el mismo registro cambió en dos dispositivos, gana el más reciente.

import * as db from './db.js';
import { debounce } from './util.js';

const CFG_KEY = 'ga-supabase';
const LOTE = 500;
let cliente = null;
let sincronizando = false;
let estado = { fase: 'apagado', mensaje: '', ultima: Number(localStorage.getItem('ga-ultima-sync')) || 0 };
const oyentes = new Set();

export function onEstado(fn) { oyentes.add(fn); fn(estado); return () => oyentes.delete(fn); }
function setEstado(fase, mensaje = '') {
  estado = { ...estado, fase, mensaje };
  oyentes.forEach(fn => fn(estado));
}
export const getEstado = () => estado;

export function getConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; }
}

export function setConfig(cfg) {
  if (cfg) localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(CFG_KEY);
  cliente = null;
}

export function getCliente() {
  if (cliente) return cliente;
  const cfg = getConfig();
  if (!cfg?.url || !cfg?.key || !window.supabase) return null;
  cliente = window.supabase.createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ga-auth', detectSessionInUrl: true },
  });
  cliente.auth.onAuthStateChange((evt) => {
    if (evt === 'SIGNED_IN') setTimeout(() => sincronizar(), 0);
    if (evt === 'SIGNED_OUT') setEstado('sin-sesion');
  });
  return cliente;
}

export async function sesion() {
  const c = getCliente();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session;
}

export async function entrar(email, password) {
  const c = getCliente();
  if (!c) throw new Error('Primero guarda la URL y la clave de tu proyecto Supabase.');
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw traducir(error);
  setEstado('listo');
  sincronizar();
}

export async function registrarse(email, password) {
  const c = getCliente();
  if (!c) throw new Error('Primero guarda la URL y la clave de tu proyecto Supabase.');
  const { data, error } = await c.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
  if (error) throw traducir(error);
  return data.session ? 'sesion' : 'confirmar';
}

export async function salir() {
  const c = getCliente();
  if (c) await c.auth.signOut();
  setEstado('sin-sesion');
}

function traducir(error) {
  const m = error?.message || String(error);
  const tabla = [
    [/invalid login credentials/i, 'Correo o contraseña incorrectos.'],
    [/email not confirmed/i, 'Confirma tu correo: revisa el enlace que te envió Supabase.'],
    [/user already registered/i, 'Ese correo ya tiene cuenta. Usa "Entrar".'],
    [/password should be at least/i, 'La contraseña debe tener al menos 6 caracteres.'],
    [/failed to fetch|networkerror|load failed/i, 'No hay conexión con Supabase. Revisa internet y la URL del proyecto.'],
    [/relation .*registros.* does not exist|could not find the table/i, 'Falta crear la tabla. Ejecuta el archivo supabase.sql en el SQL Editor de Supabase.'],
    [/jwt|invalid api key/i, 'La clave del proyecto no es válida. Usa la clave "publishable" o "anon".'],
  ];
  for (const [re, txt] of tabla) if (re.test(m)) return new Error(txt);
  return new Error(m);
}

export async function sincronizar() {
  if (sincronizando) return;
  const c = getCliente();
  if (!c) return setEstado('apagado');
  if (!navigator.onLine) return setEstado('sin-conexion', 'Se sincronizará cuando vuelva internet');
  const s = await sesion();
  if (!s) return setEstado('sin-sesion');

  sincronizando = true;
  setEstado('sincronizando');
  try {
    // 1) Bajar cambios desde la nube
    let cursor = (await db.idb.metaGet('cursor:' + s.user.id)) || '1970-01-01T00:00:00Z';
    // Pequeño solapamiento de 60 s para no perder cambios que se confirmaron casi al mismo tiempo
    let desde = new Date(new Date(cursor).getTime() - 60000).toISOString();
    let bajados = 0;
    for (;;) {
      const { data, error } = await c.from('registros')
        .select('id,tipo,data,actualizado_en,eliminado,server_ts')
        .gt('server_ts', desde)
        .order('server_ts', { ascending: true })
        .limit(1000);
      if (error) throw traducir(error);
      bajados += await db.aplicarRemotos(data);
      if (data.length) { cursor = data[data.length - 1].server_ts; desde = cursor; }
      if (data.length < 1000) break;
    }
    await db.idb.metaSet('cursor:' + s.user.id, cursor);
    await db.deduplicarAreas();

    // 2) Subir pendientes, por tipo: si Supabase aún no acepta un tipo nuevo, los demás siguen
    const pend = db.pendientes();
    let subidos = 0;
    const rechazados = [];
    for (const tipo of db.TIPOS) {
      const delTipo = pend.filter(p => p.tipo === tipo);
      for (let i = 0; i < delTipo.length; i += LOTE) {
        const lote = delTipo.slice(i, i + LOTE);
        const filas = lote.map(({ obj }) => {
          const { id, actualizadoEn, eliminado, _dirty, ...data } = obj;
          return { id, user_id: s.user.id, tipo, data: { ...data }, actualizado_en: actualizadoEn, eliminado: !!eliminado };
        });
        const { error } = await c.from('registros').upsert(filas, { onConflict: 'id' });
        if (error && /registros_tipo_check/.test(error.message || '')) { rechazados.push(tipo); break; }
        if (error) throw traducir(error);
        for (const { obj } of lote) await db.marcarSubido(tipo, obj.id, obj.actualizadoEn);
        subidos += lote.length;
      }
    }
    if (rechazados.length) {
      estado.ultima = Date.now();
      return setEstado('error', `Supabase aún no acepta «${rechazados.join(', ')}». Ejecuta el SQL de actualización (ver guía). Lo demás sí se respaldó.`);
    }

    estado.ultima = Date.now();
    localStorage.setItem('ga-ultima-sync', String(estado.ultima));
    setEstado('listo', bajados || subidos ? `${bajados} bajados, ${subidos} subidos` : 'Todo al día');
  } catch (e) {
    console.error(e);
    setEstado('error', traducir(e).message);
  } finally {
    sincronizando = false;
  }
}

export const sincronizarPronto = debounce(() => sincronizar(), 4000);

export function iniciarAutoSync() {
  db.onChange(d => { if (d.origen === 'local') sincronizarPronto(); });
  window.addEventListener('online', () => sincronizar());
  window.addEventListener('offline', () => setEstado('sin-conexion', 'Se sincronizará cuando vuelva internet'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(); });
  setInterval(() => { if (document.visibilityState === 'visible') sincronizar(); }, 5 * 60 * 1000);
  sincronizar();
}
