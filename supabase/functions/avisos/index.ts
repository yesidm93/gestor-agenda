// =====================================================================
//  Gestor agenda · Función "avisos" (Supabase Edge Function)
//
//  GET   → devuelve la clave pública para suscribir dispositivos
//  POST  {accion:"enviar"}   → la llama el cron cada minuto; envía los avisos que tocan
//  POST  {accion:"posponer"} → la llama el botón "Posponer" de la notificación
//
//  Secretos (Edge Functions › Secrets):
//    VAPID_PRIVATE_KEY  clave privada en formato JWK (la genera la app en Ajustes)
//    AVISOS_SECRETO     texto largo inventado por ti; el cron lo envía para autorizar
//    VAPID_CONTACTO     opcional, ej. mailto:tucorreo@ejemplo.com
//  SUPABASE_URL y la clave de servidor (SUPABASE_SERVICE_ROLE_KEY o SUPABASE_SECRET_KEYS) ya existen en todas las funciones.
//
//  Al crearla, desactiva "Verify JWT" (la función valida AVISOS_SECRETO por su cuenta).
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildPushHTTPRequest } from "npm:@pushforge/builder@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-avisos-secreto",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const desdeB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

function clavePrivada(): JsonWebKey {
  const txt = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!txt) throw new Error("Falta el secreto VAPID_PRIVATE_KEY");
  return JSON.parse(txt);
}

/** La clave pública se deriva de la privada (punto x,y de la curva P-256) */
function clavePublica(jwk: JsonWebKey): string {
  const x = desdeB64url(jwk.x!), y = desdeB64url(jwk.y!);
  const raw = new Uint8Array(65);
  raw[0] = 4; raw.set(x, 1); raw.set(y, 33);
  return b64url(raw);
}

async function firma(texto: string): Promise<string> {
  const secreto = Deno.env.get("AVISOS_SECRETO") ?? "";
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(texto)))).slice(0, 32);
}

function iguales(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const pesos = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });

function cuerpo(a: { fecha: string | null; hora: string | null; monto: number | null }) {
  const partes: string[] = [];
  if (a.fecha) {
    const [y, m, d] = a.fecha.split("-").map(Number);
    const f = new Date(Date.UTC(y, m - 1, d, 12));
    partes.push("Para el " + new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(f));
  }
  if (a.hora) partes.push("a las " + a.hora);
  let txt = partes.join(" ");
  if (a.monto) txt += (txt ? ". " : "") + "Valor: " + pesos.format(a.monto);
  return txt || "Tienes una tarea pendiente";
}

/** Clave de servidor: la clásica (service_role) o la nueva (secret), según el proyecto */
function claveServidor(): string {
  const clasica = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (clasica) return clasica;
  try {
    const nuevas = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const k = nuevas.default ?? Object.values(nuevas)[0];
    if (k) return String(k);
  } catch { /* sigue abajo */ }
  throw new Error("No se encontró la clave de servidor de Supabase");
}

const admin = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, claveServidor(), { auth: { persistSession: false } });

async function enviar() {
  const jwk = clavePrivada();
  const contacto = Deno.env.get("VAPID_CONTACTO") ?? "mailto:avisos@gestor-agenda.app";
  const api = `${Deno.env.get("SUPABASE_URL")}/functions/v1/avisos`;
  const sb = admin();

  const { data: avisos, error } = await sb.rpc("avisos_pendientes");
  if (error) throw error;
  if (!avisos?.length) return { avisos: 0, enviados: 0 };

  const usuarios = [...new Set(avisos.map((a: { user_id: string }) => a.user_id))];
  const { data: subs, error: e2 } = await sb.from("push_suscripciones").select("*").in("user_id", usuarios);
  if (e2) throw e2;

  let enviados = 0;
  const vencidas = new Set<string>();
  const marcar: { tarea_id: string; user_id: string; avisar_en: number; ultimo_envio: string }[] = [];

  for (const a of avisos) {
    const payload = {
      title: a.titulo || "Recordatorio",
      body: cuerpo(a),
      tag: "tarea-" + a.tarea_id,
      data: { tareaId: a.tarea_id, token: await firma(a.tarea_id), api },
    };
    for (const s of (subs ?? []).filter((s: { user_id: string }) => s.user_id === a.user_id)) {
      try {
        const { endpoint, headers, body } = await buildPushHTTPRequest({
          privateJWK: jwk,
          subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          message: { payload, adminContact: contacto, options: { ttl: 3600, urgency: "high", topic: "t" + a.tarea_id.replace(/-/g, "").slice(0, 30) } },
        });
        const r = await fetch(endpoint, { method: "POST", headers, body });
        if (r.status === 404 || r.status === 410) vencidas.add(s.endpoint);
        else if (r.ok) enviados++;
        else console.error("Push rechazado", r.status, await r.text());
      } catch (err) {
        console.error("Error enviando", err);
      }
    }
    marcar.push({ tarea_id: a.tarea_id, user_id: a.user_id, avisar_en: a.avisar_en, ultimo_envio: new Date().toISOString() });
  }

  if (marcar.length) await sb.from("avisos_enviados").upsert(marcar, { onConflict: "tarea_id" });
  if (vencidas.size) await sb.from("push_suscripciones").delete().in("endpoint", [...vencidas]);
  return { avisos: avisos.length, enviados, suscripcionesBorradas: vencidas.size };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method === "GET") return json({ clavePublica: clavePublica(clavePrivada()) });

    const datos = await req.json().catch(() => ({}));

    if (datos.accion === "posponer") {
      const { tareaId, token } = datos;
      const minutos = Math.min(Math.max(Number(datos.minutos) || 60, 5), 7 * 24 * 60);
      if (!tareaId || !token || !iguales(String(token), await firma(String(tareaId)))) return json({ error: "token inválido" }, 401);
      const { error } = await admin().rpc("posponer_aviso", { p_id: tareaId, p_hasta: Date.now() + minutos * 60000 });
      if (error) throw error;
      return json({ ok: true, minutos });
    }

    const secreto = Deno.env.get("AVISOS_SECRETO");
    if (!secreto || !iguales(req.headers.get("x-avisos-secreto") ?? "", secreto)) return json({ error: "no autorizado" }, 401);
    return json(await enviar());
  } catch (err) {
    console.error(err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
