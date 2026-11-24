-- =====================================================================
--  Gestor agenda · Revisar avisos cada minuto
--  Ejecuta esto en el SQL Editor DESPUÉS de crear la función "avisos".
--  Reemplaza los dos valores marcados con  <<< >>>  antes de ejecutar.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Guarda la URL del proyecto y el secreto en Vault (cifrados)
-- Si ya existen, primero bórralos en Project Settings › Vault o cambia los nombres.
select vault.create_secret('<<<https://TU-PROYECTO.supabase.co>>>', 'ga_project_url');
select vault.create_secret('<<<EL MISMO TEXTO QUE PUSISTE EN AVISOS_SECRETO>>>', 'ga_avisos_secreto');

-- Quita la tarea programada anterior si existía
select cron.unschedule(jobid) from cron.job where jobname = 'gestor-agenda-avisos';

select cron.schedule(
  'gestor-agenda-avisos',
  '* * * * *',  -- cada minuto
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'ga_project_url') || '/functions/v1/avisos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-secreto', (select decrypted_secret from vault.decrypted_secrets where name = 'ga_avisos_secreto')
    ),
    body := '{"accion":"enviar"}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- Para revisar que funciona (respuestas de las últimas horas):
-- select status_code, content, created from net._http_response order by created desc limit 10;
-- Para detenerlo:
-- select cron.unschedule('gestor-agenda-avisos');
