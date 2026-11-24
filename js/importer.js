// Importar y exportar notas en Markdown (.md, .txt, .zip)

import { uid, hashTexto, extraerEtiquetas, ymd, nombreArchivo } from './util.js';

const EXT_TEXTO = /\.(md|markdown|mdown|txt)$/i;
const EXT_IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_LADO_IMG = 1280;

/** Lee encabezado YAML sencillo (--- ... ---) */
function frontmatter(texto) {
  const m = texto.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!m) return { meta: {}, cuerpo: texto.replace(/^﻿/, '') };
  const meta = {};
  let claveLista = null;
  for (const linea of m[1].split(/\r?\n/)) {
    const item = linea.match(/^\s*-\s+(.*)$/);
    if (item && claveLista) { meta[claveLista].push(limpiarValor(item[1])); continue; }
    const kv = linea.match(/^([\wÀ-ſ-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const clave = kv[1].toLowerCase();
    let valor = kv[2].trim();
    if (valor === '') { meta[clave] = []; claveLista = clave; continue; }
    claveLista = null;
    if (/^\[.*\]$/.test(valor)) meta[clave] = valor.slice(1, -1).split(',').map(limpiarValor).filter(Boolean);
    else meta[clave] = limpiarValor(valor);
  }
  return { meta, cuerpo: texto.slice(m[0].length) };
}

const limpiarValor = v => String(v).trim().replace(/^["']|["']$/g, '');

function fechaDesde(meta, respaldoMs) {
  const v = meta.fecha || meta.date || meta.created || meta.creado || meta.creada;
  if (v) {
    const d = new Date(Array.isArray(v) ? v[0] : v);
    if (!isNaN(d)) return d.getTime();
  }
  return respaldoMs || Date.now();
}

/** Convierte un texto Markdown en una nota candidata */
export function parsearMarkdown(texto, nombre, fechaArchivo) {
  const { meta, cuerpo } = frontmatter(String(texto).replace(/\r\n/g, '\n'));
  let titulo = meta.title || meta.titulo || '';
  let contenido = cuerpo;
  if (!titulo) {
    const h1 = contenido.match(/^\s*#\s+(.+?)\s*#*\s*$/m);
    const primeraLinea = contenido.trimStart().split('\n')[0] || '';
    if (h1 && contenido.trimStart().startsWith(h1[0].trimStart())) {
      titulo = h1[1].trim();
      contenido = contenido.trimStart().slice(h1[0].trimStart().length);
    } else if (nombre) {
      titulo = nombre.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
      // Si la primera línea repite el nombre del archivo, no duplicarla
      if (primeraLinea.replace(/^#+\s*/, '').trim().toLowerCase() === titulo.trim().toLowerCase()) {
        contenido = contenido.trimStart().slice(primeraLinea.length);
      }
    } else {
      titulo = primeraLinea.replace(/^#+\s*/, '').slice(0, 80);
      contenido = contenido.trimStart().slice(primeraLinea.length);
    }
  }
  contenido = contenido.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
  const tagsMeta = [].concat(meta.tags || meta.etiquetas || []).flatMap(t => String(t).split(/[,\s]+/)).map(t => t.replace(/^#/, '').toLowerCase()).filter(Boolean);
  const etiquetas = [...new Set([...tagsMeta, ...extraerEtiquetas(contenido)])];
  const creadoEn = fechaDesde(meta, fechaArchivo);
  const cuaderno = [].concat(meta.cuaderno || meta.notebook || meta.folder || meta.carpeta || '')[0] || '';
  return { titulo: titulo.trim() || 'Sin título', contenido, etiquetas, creadoEn, cuaderno, origen: nombre || 'texto' };
}

const NOMBRE_GENERICO = /^(?:[\d\s_.:-]+|(?:nota|notas|note|notes|texto|text|xiaomi|mi ?notes?|untitled|sin t[ií]tulo)[\s_.:\d()-]*)$/i;

/**
 * Nota exportada como texto (.txt): la primera línea corta es el título.
 * Si el archivo tiene un nombre genérico (números, "nota_123"), nunca se usa como título.
 */
export function parsearTextoPlano(texto, nombre, fechaArchivo) {
  const limpio = String(texto).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  const lineas = limpio.split('\n');
  const primera = (lineas[0] || '').trim();
  const base = (nombre || '').replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const generico = !base || NOMBRE_GENERICO.test(base);
  const recortar = t => (t.length > 60 ? t.slice(0, 60).replace(/\s+\S*$/, '') + '…' : t);

  // Varias líneas y la primera es corta → es el título
  if (lineas.length > 1 && primera && primera.length <= 100) {
    return parsearMarkdown(`# ${primera.replace(/^#+\s*/, '')}\n\n${lineas.slice(1).join('\n')}`, nombre, fechaArchivo);
  }
  // Archivo con nombre propio → ese nombre es el título y todo el texto es el contenido
  if (!generico) return parsearMarkdown(limpio, nombre, fechaArchivo);
  // Nombre genérico y sin título claro → título con el comienzo del texto, sin perder nada
  const n = parsearMarkdown(`# ${recortar(primera) || 'Sin título'}\n\n`, '', fechaArchivo);
  n.contenido = (primera.length > 60 || lineas.length > 1 ? limpio : '') + '\n';
  n.etiquetas = extraerEtiquetas(n.contenido);
  return n;
}

const esTextoPlano = (nombre, tipo) => /\.txt$/i.test(nombre || '') || (tipo === 'text/plain' && !/\.(md|markdown|mdown)$/i.test(nombre || ''));

export const huellaNota = n => hashTexto((n.titulo || '') + '\n' + (n.contenido || ''));

async function imagenADataURL(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, MAX_LADO_IMG / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } catch { return null; }
}

function resolverRuta(base, rel) {
  const partes = (base ? base.split('/') : []);
  for (const p of decodeURIComponent(rel).split('/')) {
    if (p === '..') partes.pop();
    else if (p && p !== '.') partes.push(p);
  }
  return partes.join('/');
}

/** Incrusta en la nota las imágenes que vienen dentro del .zip */
async function incrustarImagenes(contenido, dirNota, archivosZip) {
  const refs = [];
  contenido.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, ruta) => { refs.push({ m, alt, ruta }); return m; });
  contenido.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (m, ruta) => { refs.push({ m, alt: ruta, ruta, wiki: true }); return m; });
  let sinEncontrar = 0;
  for (const r of refs) {
    if (/^(https?:|data:)/i.test(r.ruta)) continue;
    let archivo = archivosZip[resolverRuta(dirNota, r.ruta)];
    if (!archivo) {
      const solo = r.ruta.split('/').pop().toLowerCase();
      archivo = Object.entries(archivosZip).find(([k]) => k.split('/').pop().toLowerCase() === solo)?.[1];
    }
    if (!archivo || !EXT_IMG.test(r.ruta)) { sinEncontrar++; continue; }
    const url = await imagenADataURL(await archivo.async('blob'));
    if (url) contenido = contenido.replace(r.m, `![${r.alt}](${url})`);
    else sinEncontrar++;
  }
  return { contenido, sinEncontrar };
}

/** Recibe archivos (File[]) y devuelve notas candidatas para la vista previa */
export async function leerArchivos(files) {
  const candidatas = [];
  const avisos = [];
  for (const f of files) {
    const nombre = f.name || 'compartido';
    if (/\.zip$/i.test(nombre) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
      if (!window.JSZip) { avisos.push('No se pudo abrir el .zip'); continue; }
      const zip = await window.JSZip.loadAsync(f);
      const archivos = {};
      zip.forEach((ruta, entrada) => { if (!entrada.dir && !ruta.startsWith('__MACOSX')) archivos[ruta] = entrada; });
      for (const [ruta, entrada] of Object.entries(archivos)) {
        if (!EXT_TEXTO.test(ruta)) continue;
        const texto = await entrada.async('string');
        const n = (esTextoPlano(ruta, '') ? parsearTextoPlano : parsearMarkdown)(texto, ruta, entrada.date?.getTime());
        const dir = ruta.includes('/') ? ruta.slice(0, ruta.lastIndexOf('/')) : '';
        const r = await incrustarImagenes(n.contenido, dir, archivos);
        n.contenido = r.contenido;
        if (r.sinEncontrar) n.aviso = `${r.sinEncontrar} imagen(es) no encontradas`;
        if (!n.cuaderno) n.cuaderno = dir.split('/').filter(Boolean).pop() || '';
        candidatas.push(n);
      }
    } else if (EXT_TEXTO.test(nombre) || /^text\//.test(f.type) || f.type === '' || f.type === 'application/octet-stream') {
      const texto = await f.text();
      candidatas.push((esTextoPlano(nombre, f.type) ? parsearTextoPlano : parsearMarkdown)(texto, nombre, f.lastModified));
    } else {
      avisos.push(`${nombre}: formato no compatible`);
    }
  }
  return { candidatas, avisos };
}

/** Divide un texto pegado en varias notas usando "---" en una línea sola */
export function dividirTexto(texto) {
  return String(texto).replace(/\r\n/g, '\n').split(/\n\s*-{3,}\s*\n/).map(t => t.trim()).filter(Boolean)
    .map(t => parsearTextoPlano(t, '', Date.now()));
}

export function candidataANota(c, areaId) {
  return { id: uid(), titulo: c.titulo, contenido: c.contenido, areaId: areaId || null, etiquetas: c.etiquetas, fijada: false, creadoEn: c.creadoEn };
}

// ---------------- Exportar ----------------
export function notaAMarkdown(n, areas) {
  const area = areas.find(a => a.id === n.areaId);
  const fm = ['---', `titulo: "${String(n.titulo).replace(/"/g, '\\"')}"`, `fecha: ${new Date(n.creadoEn).toISOString()}`];
  if (area) fm.push(`cuaderno: "${area.nombre.replace(/"/g, '\\"')}"`);
  if (n.etiquetas?.length) fm.push(`etiquetas: [${n.etiquetas.join(', ')}]`);
  fm.push('---', '');
  return fm.join('\n') + `# ${n.titulo}\n\n${n.contenido || ''}`;
}

export async function exportarZip(notas, areas) {
  const zip = new window.JSZip();
  const usados = new Set();
  for (const n of notas) {
    const area = areas.find(a => a.id === n.areaId);
    const carpeta = nombreArchivo(area ? area.nombre : 'Sin cuaderno');
    let base = `${carpeta}/${nombreArchivo(n.titulo)}`;
    let nombre = base + '.md', i = 2;
    while (usados.has(nombre.toLowerCase())) nombre = `${base} (${i++}).md`;
    usados.add(nombre.toLowerCase());
    zip.file(nombre, notaAMarkdown(n, areas), { date: new Date(n.actualizadoEn || Date.now()) });
  }
  return zip.generateAsync({ type: 'blob' });
}

export const nombreExport = pref => `${pref}-${ymd()}`;
