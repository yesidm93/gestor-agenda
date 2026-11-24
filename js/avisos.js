// Recordatorios: permisos, notificaciones locales y suscripción push (app cerrada)

import { getCliente, getConfig, sesion } from './sync.js';

const LS_PUSH = 'ga-push';
const LS_MOSTRADOS = 'ga-avisos-mostrados';

export const soportado = () => 'Notification' in window && 'serviceWorker' in navigator;
export const permiso = () => (soportado() ? Notification.permission : 'no-soportado');
export const pushActivo = () => localStorage.getItem(LS_PUSH) === '1';

export async function pedirPermiso() {
  if (!soportado()) return 'no-soportado';
  return Notification.requestPermission();
}

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Pide a la función "avisos" de Supabase la clave pública */
export async function clavePublicaServidor() {
  const cfg = getConfig();
  if (!cfg) throw new Error('Primero conecta el respaldo en la nube.');
  let r;
  try {
    r = await fetch(`${cfg.url}/functions/v1/avisos`, { headers: { apikey: cfg.key } });
  } catch {
    throw new Error('No se pudo contactar la función "avisos". Revisa internet y que la función esté creada.');
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok || !datos.clavePublica) throw new Error(datos.error ? `La función respondió: ${datos.error}` : `La función "avisos" no está lista (código ${r.status}). Sigue la guía de configuración.`);
  return datos.clavePublica;
}

export async function activarPush() {
  if (!('PushManager' in window)) throw new Error('Este navegador no permite notificaciones con la app cerrada.');
  if ((await pedirPermiso()) !== 'granted') throw new Error('Debes permitir las notificaciones.');
  const ses = await sesion();
  if (!ses) throw new Error('Inicia sesión en el respaldo en la nube.');
  const clave = await clavePublicaServidor();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const actual = sub.options?.applicationServerKey ? b64url(sub.options.applicationServerKey) : '';
    if (actual && actual !== clave) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: clave });
  const j = sub.toJSON();
  const { error } = await getCliente().from('push_suscripciones').upsert({
    endpoint: j.endpoint, user_id: ses.user.id, p256dh: j.keys.p256dh, auth: j.keys.auth,
    dispositivo: nombreDispositivo(),
  }, { onConflict: 'endpoint' });
  if (error) throw new Error(/push_suscripciones/.test(error.message) ? 'Falta la tabla push_suscripciones: vuelve a ejecutar esquema.sql en Supabase.' : error.message);
  localStorage.setItem(LS_PUSH, '1');
}

export async function desactivarPush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await getCliente()?.from('push_suscripciones').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
  localStorage.removeItem(LS_PUSH);
}

function nombreDispositivo() {
  const ua = navigator.userAgent;
  const m = ua.match(/\(([^)]+)\)/);
  return (/Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Otro') + (m ? ' · ' + m[1].split(';').slice(-1)[0].trim() : '');
}

/** Claves VAPID generadas en el navegador (la privada va como secreto en Supabase) */
export async function generarClaves() {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', par.privateKey);
  const privada = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });
  const secreto = b64url(crypto.getRandomValues(new Uint8Array(24)));
  return { privada, secreto };
}

// ---------------- Notificaciones locales (con la app abierta o en segundo plano) ----------------
function leerMostrados() { try { return JSON.parse(localStorage.getItem(LS_MOSTRADOS)) || {}; } catch { return {}; } }

export async function mostrarLocal(t, { forzar = false, cuerpo = '' } = {}) {
  if (permiso() !== 'granted') return false;
  const mostrados = leerMostrados();
  const previo = mostrados[t.id];
  const repetir = (Number(t.aviso?.repetirMin) || 60) * 60000;
  if (!forzar && previo && previo.avisarEn === t.avisarEn && Date.now() - previo.at < repetir) return false;
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(t.titulo || 'Recordatorio', {
    body: cuerpo,
    tag: 'tarea-' + t.id,
    renotify: true,
    requireInteraction: true,
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    vibrate: [200, 100, 200],
    data: { tareaId: t.id },
    actions: [{ action: 'hecha', title: 'Marcar hecha' }, { action: 'posponer', title: 'Posponer 1 h' }],
  });
  mostrados[t.id] = { at: Date.now(), avisarEn: t.avisarEn };
  // Limpieza de entradas viejas
  for (const [k, v] of Object.entries(mostrados)) if (Date.now() - v.at > 30 * 86400000) delete mostrados[k];
  localStorage.setItem(LS_MOSTRADOS, JSON.stringify(mostrados));
  return true;
}

export async function cerrarNotificacion(tareaId) {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const ns = await reg?.getNotifications({ tag: 'tarea-' + tareaId });
  ns?.forEach(n => n.close());
}
