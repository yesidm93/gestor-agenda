// Service worker: funciona sin conexión y recibe lo que se comparte desde el celular.
// Cambia VERSION cada vez que publiques cambios para que los dispositivos se actualicen.
const VERSION = 'ga-v1.6.0';

const ARCHIVOS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/db.js',
  './js/sync.js',
  './js/importer.js',
  './js/logic.js',
  './js/util.js',
  './js/icons.js',
  './js/finanzas.js',
  './js/avisos.js',
  './vendor/marked.umd.js',
  './vendor/purify.min.js',
  './vendor/jszip.min.js',
  './vendor/supabase.js',
  './fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  './fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  './fonts/bricolage-grotesque-latin-wght-normal.woff2',
  './icons/icono.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/badge-96.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'actualizar') self.skipWaiting();
});

// --- IndexedDB mínima para guardar lo compartido (misma estructura que js/db.js) ---
function abrirDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('gestor-agenda', 3);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ['areas', 'tareas', 'habitos', 'notas', 'movimientos', 'deudas', 'ahorros']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('share')) db.createObjectStore('share', { autoIncrement: true });
    };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
    r.onerror = () => rej(r.error);
  });
}

async function guardarCompartido(req) {
  const fd = await req.formData();
  const files = fd.getAll('archivos').filter(f => f && typeof f === 'object' && f.size > 0);
  const item = { title: fd.get('title') || '', text: fd.get('text') || '', url: fd.get('url') || '', files, fecha: Date.now() };
  const db = await abrirDB();
  await new Promise((res, rej) => {
    const t = db.transaction('share', 'readwrite');
    t.objectStore('share').add(item);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Recibir "Compartir" desde otras apps
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/compartir')) {
    e.respondWith((async () => {
      try { await guardarCompartido(e.request); } catch (err) { console.error(err); }
      return Response.redirect('./?compartir=1#/notas', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Supabase y otros: directo a la red

  // Navegación: primero la red (para ver cambios), si no hay conexión, la copia guardada
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }

  // Archivos de la app: primero la copia guardada
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(resp => {
    if (resp.ok) { const copia = resp.clone(); caches.open(VERSION).then(c => c.put(e.request, copia)); }
    return resp;
  })));
});

// ---------------- Recordatorios ----------------
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Recordatorio', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Recordatorio', {
    body: d.body || '',
    tag: d.tag || 'gestor-agenda',
    renotify: true,
    requireInteraction: true,
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    vibrate: [200, 100, 200],
    data: d.data || {},
    actions: [{ action: 'hecha', title: 'Marcar hecha' }, { action: 'posponer', title: 'Posponer 1 h' }],
  }));
});

self.addEventListener('notificationclick', e => {
  const n = e.notification;
  const d = n.data || {};
  n.close();
  e.waitUntil((async () => {
    // "Posponer" sin abrir la app, si el aviso vino del servidor
    if (e.action === 'posponer' && d.token && d.api) {
      try {
        const r = await fetch(d.api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'posponer', tareaId: d.tareaId, token: d.token, minutos: 60 }) });
        if (r.ok) {
          // Si la app está abierta, que actualice el dato
          for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ tipo: 'sincronizar' });
          return;
        }
      } catch { /* sin conexión: se abre la app */ }
    }
    const accion = e.action || 'abrir';
    const lista = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of lista) {
      if ('focus' in c) {
        c.postMessage({ tipo: 'aviso', tareaId: d.tareaId, accion });
        return c.focus();
      }
    }
    return self.clients.openWindow(new URL(`./?aviso=${encodeURIComponent(d.tareaId || '')}&accion=${accion}#/hoy`, self.registration.scope).href);
  })());
});
