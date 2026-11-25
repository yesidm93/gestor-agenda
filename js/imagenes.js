// Imágenes de las notas: compresión, almacenamiento y carga diferida
//
// En el texto de la nota una imagen se escribe así:  ![foto 1](img:1)
// La nota guarda en "imagenes" qué id real corresponde a cada número: { "1": "uuid…" }.
// (También se acepta img:UUID directamente.) El contenido vive en IndexedDB y se
// respalda en Supabase como tipo "imagenes".

import * as db from './db.js';
import { uid } from './util.js';

const LADO_MAX = 1440;      // px del lado más largo
const CALIDAD = 0.78;

export const RE_IMG = /!\[([^\]]*)\]\(img:([\w-]+)\)/g;

let formato = null;
function formatoSalida() {
  if (formato) return formato;
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  formato = c.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
  return formato;
}

/** Reduce y comprime una foto (respeta la orientación de la cámara) */
export async function comprimir(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(blob); }
  const k = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // fondo blanco para PNG con transparencia
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const dataUrl = c.toDataURL(formatoSalida(), CALIDAD);
  return { dataUrl, ancho: c.width, alto: c.height, bytes: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75) };
}

/** Guarda una imagen asociada a una nota y devuelve su id */
export async function guardarImagen(blobODataUrl, notaId, nombre = '') {
  const blob = typeof blobODataUrl === 'string' ? await (await fetch(blobODataUrl)).blob() : blobODataUrl;
  const img = await comprimir(blob);
  const id = uid();
  await db.guardar('imagenes', { id, notaId, nombre, ...img }, { silencioso: true });
  return id;
}

// Caché pequeña en memoria para no leer IndexedDB en cada repintado
const cache = new Map();
export async function urlImagen(id) {
  if (cache.has(id)) return cache.get(id);
  const r = await db.obtenerCompleto('imagenes', id);
  const url = r && !r.eliminado ? r.dataUrl : null;
  if (url) {
    cache.set(id, url);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
  }
  return url;
}
export const olvidar = id => cache.delete(id);

/** Convierte la referencia escrita en la nota (número o id) en el id real */
export const resolver = (nota, ref) => (/^\d+$/.test(ref) ? nota?.imagenes?.[ref] : ref) || null;

/** Ids reales de las imágenes en el texto de una nota, en orden */
export const idsEnTexto = (md, nota) => [...String(md || '').matchAll(RE_IMG)].map(m => resolver(nota, m[2])).filter(Boolean);

/** Siguiente número libre para una imagen de la nota */
export const siguienteAlias = nota => String(Math.max(0, ...Object.keys(nota?.imagenes || {}).map(Number)) + 1);

/** Para el visor de Markdown: img:N → #img-ID (DOMPurify no acepta esquemas desconocidos) */
export const prepararMarkdown = (md, nota) => String(md || '').replace(RE_IMG, (m, alt, ref) => `![${alt}](#img-${resolver(nota, ref) || 'falta'})`);

/** Carga las imágenes de un contenedor ya pintado */
export async function hidratar(raiz) {
  if (!raiz) return;
  const imgs = [...raiz.querySelectorAll('img[src^="#img-"], img[data-img]')];
  await Promise.all(imgs.map(async el => {
    const id = el.dataset.img || el.getAttribute('src').slice(5);
    el.dataset.img = id;
    el.removeAttribute('src');
    el.loading = 'lazy';
    el.decoding = 'async';
    const url = await urlImagen(id);
    if (url) { el.src = url; el.classList.remove('img-pendiente'); }
    else { el.classList.add('img-pendiente'); el.alt = el.alt || 'Imagen pendiente de sincronizar'; }
  }));
}
