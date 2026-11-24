-- =====================================================================
--  Gestor agenda · Esquema de respaldo en Supabase
--  Cómo usarlo: Supabase → tu proyecto → SQL Editor → New query →
--  pega todo este archivo → Run. Se puede ejecutar más de una vez.
-- =====================================================================

-- Una sola tabla guarda todos los registros de la app (áreas, tareas,
-- hábitos y notas). El contenido de cada registro va en "data" (JSON).
create table if not exists public.registros (
  id              uuid primary key,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tipo            text not null,
  data            jsonb not null default '{}'::jsonb,
  actualizado_en  bigint not null,               -- hora del cambio en el dispositivo (ms)
  eliminado       boolean not null default false, -- los borrados también se sincronizan
  server_ts       timestamptz not null default clock_timestamp()  -- hora en que llegó al servidor
);

-- Tipos de registro permitidos (se puede volver a ejecutar para agregar tipos nuevos)
alter table public.registros drop constraint if exists registros_tipo_check;
alter table public.registros add constraint registros_tipo_check
  check (tipo in ('areas', 'tareas', 'habitos', 'notas', 'movimientos', 'deudas'));

create index if not exists registros_user_server_ts on public.registros (user_id, server_ts);
create index if not exists registros_user_tipo on public.registros (user_id, tipo);

-- Seguridad: cada usuario solo puede ver y modificar sus propios registros
alter table public.registros enable row level security;

drop policy if exists "registros_propios" on public.registros;
create policy "registros_propios" on public.registros
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.registros to authenticated;
revoke all on public.registros from anon;

-- Regla "gana el cambio más reciente": si llega una versión más vieja
-- que la guardada, se ignora. También marca la hora de llegada.
create or replace function public.registros_ultimo_gana()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.actualizado_en < old.actualizado_en then
      return old;  -- se queda la versión más reciente
    end if;
    new.user_id := old.user_id;  -- un registro nunca cambia de dueño
  end if;
  new.server_ts := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists registros_ultimo_gana on public.registros;
create trigger registros_ultimo_gana
  before insert or update on public.registros
  for each row execute function public.registros_ultimo_gana();

-- ---------------------------------------------------------------------
-- (Opcional) Vistas para consultar tus datos cómodamente en Supabase
-- ---------------------------------------------------------------------
create or replace view public.v_tareas with (security_invoker = on) as
  select id, data->>'titulo' as titulo, data->>'fecha' as fecha, data->>'hora' as hora,
         data->>'prioridad' as prioridad, (data->>'completada')::boolean as completada,
         to_timestamp(actualizado_en / 1000.0) as actualizado
  from public.registros where tipo = 'tareas' and not eliminado;

create or replace view public.v_notas with (security_invoker = on) as
  select id, data->>'titulo' as titulo, left(data->>'contenido', 200) as inicio,
         to_timestamp(actualizado_en / 1000.0) as actualizado
  from public.registros where tipo = 'notas' and not eliminado;

create or replace view public.v_movimientos with (security_invoker = on) as
  select id, data->>'clase' as clase, (data->>'monto')::numeric as monto, (data->>'fecha')::date as fecha,
         data->>'categoria' as categoria, data->>'descripcion' as descripcion
  from public.registros where tipo = 'movimientos' and not eliminado;

-- =====================================================================
--  RECORDATORIOS (notificaciones con la app cerrada)
-- =====================================================================

-- Dispositivos que aceptaron recibir notificaciones
create table if not exists public.push_suscripciones (
  endpoint     text primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh       text not null,
  auth         text not null,
  dispositivo  text,
  creado       timestamptz not null default now()
);
alter table public.push_suscripciones enable row level security;
drop policy if exists "suscripciones_propias" on public.push_suscripciones;
create policy "suscripciones_propias" on public.push_suscripciones
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.push_suscripciones to authenticated;
revoke all on public.push_suscripciones from anon;

-- Cuándo se envió el último aviso de cada tarea (solo lo usa el servidor)
create table if not exists public.avisos_enviados (
  tarea_id      uuid primary key references public.registros(id) on delete cascade,
  user_id       uuid not null,
  avisar_en     bigint not null,
  ultimo_envio  timestamptz not null
);
alter table public.avisos_enviados enable row level security;
revoke all on public.avisos_enviados from anon, authenticated;

-- Tareas cuyo aviso toca ahora: llegó la hora y no está hecha.
-- Se repite cada "repetirMin" minutos hasta que la tarea se marque como hecha.
create or replace function public.avisos_pendientes()
returns table (tarea_id uuid, user_id uuid, titulo text, fecha text, hora text, avisar_en bigint, monto numeric)
language sql
security definer
set search_path = ''
as $$
  select r.id, r.user_id, r.data->>'titulo', r.data->>'fecha', r.data->>'hora',
         (r.data->>'avisarEn')::bigint,
         nullif(r.data->'pago'->>'monto', '')::numeric
  from public.registros r
  left join public.avisos_enviados a on a.tarea_id = r.id
  where r.tipo = 'tareas'
    and not r.eliminado
    and coalesce((r.data->>'completada')::boolean, false) = false
    and coalesce(r.data->>'avisarEn', '') ~ '^[0-9]+$'
    and (r.data->>'avisarEn')::bigint <= (extract(epoch from now()) * 1000)::bigint
    and (
      a.tarea_id is null
      or a.avisar_en <> (r.data->>'avisarEn')::bigint
      or a.ultimo_envio <= now() - make_interval(mins => greatest(coalesce(nullif(r.data->'aviso'->>'repetirMin', '')::int, 60), 5))
    )
  limit 500;
$$;

-- Posponer desde el botón de la notificación (lo llama la función del servidor)
create or replace function public.posponer_aviso(p_id uuid, p_hasta bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.registros
     set data = jsonb_set(data, '{avisarEn}', to_jsonb(p_hasta)),
         actualizado_en = greatest(actualizado_en + 1, (extract(epoch from now()) * 1000)::bigint)
   where id = p_id and tipo = 'tareas';
$$;

revoke execute on function public.avisos_pendientes() from public, anon, authenticated;
revoke execute on function public.posponer_aviso(uuid, bigint) from public, anon, authenticated;

-- El servidor (función "avisos") sí necesita usarlas
grant execute on function public.avisos_pendientes() to service_role;
grant execute on function public.posponer_aviso(uuid, bigint) to service_role;
grant select, insert, update, delete on public.registros, public.push_suscripciones, public.avisos_enviados to service_role;
