-- DEL-4: aviso FINAL de eliminación de cuenta. AÑADE una tabla y cuatro funciones; lo único que redefine de DEL-2 es
-- account_deletion_backlog() (solo suma los avisos vencidos al conteo de trabajo; la condición de limpieza no cambia). Ninguna
-- etapa, RPC de confirmación ni de finalización se toca. La eliminación nunca depende de este aviso (no hay FK desde la limpieza hacia aquí, ni trigger, ni lectura en las etapas).
--
-- Semántica real (sin sobrepromesas):
--  * El correo del destinatario se COPIA aquí desde auth.users mientras la identidad aún existe (el worker lo captura al reclamar
--    la solicitud, siempre antes de la etapa auth_delete) y se BORRA al enviarse, al agotarse los reintentos o a los 14 días (purge_by).
--  * Se envía solo cuando la solicitud está 'completed' con completed_at (account_deletion_notice_claim lo exige en la misma sentencia).
--  * Idempotencia: la reclamación es atómica (FOR UPDATE SKIP LOCKED + lease) y el proveedor recibe Idempotency-Key = request_id.
--    Caso "el proveedor aceptó pero el worker falló antes de registrar el éxito": el reintento reutiliza la misma clave y Resend
--    devuelve el resultado original SIN reenviar, mientras la clave siga vigente (24 h). Por eso ningún reintento se permite pasadas
--    23 h desde el primer intento: después el aviso se ABANDONA (sin duplicar) en lugar de arriesgar un duplicado. Garantía real:
--    como máximo un correo por solicitud dentro de esa ventana; fuera de ella, 0 (nunca 2). No es "exactamente una vez": si el
--    proveedor acepta y el aviso se abandona por agotarse la ventana, el correo pudo haberse entregado sin quedar registrado.
--
-- ROLLBACK (solo borra datos de avisos, nunca de eliminación):
--   drop function public.account_deletion_notice_purge(); drop function public.account_deletion_notice_finish(uuid, text, boolean, text);
--   drop function public.account_deletion_notice_claim(text, integer); drop function public.account_deletion_notice_capture(uuid, text);
--   drop table public.account_deletion_completion_notices;
--   y restaurar account_deletion_backlog() con la definición de 20261114120000_account_deletion_runtime.sql.

create table public.account_deletion_completion_notices (
  request_id       uuid primary key references public.account_deletion_requests(id) on delete cascade,
  recipient        text,
  locale           text not null default 'en' check (locale in ('es', 'en', 'de')),
  status           text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'abandoned')),
  attempts         integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at  timestamptz not null default now(),
  lease_owner      text,
  lease_until      timestamptz,
  last_error_code  text check (last_error_code is null or last_error_code in
    ('not_configured', 'rejected', 'rate_limited', 'provider_unavailable', 'timeout', 'invalid_response', 'unexpected')),
  created_at       timestamptz not null default now(),
  first_attempt_at timestamptz,
  sent_at          timestamptz,
  purge_by         timestamptz not null default (now() + interval '14 days'),
  -- El correo existe SOLO mientras el aviso está pendiente o enviándose.
  check ((status in ('pending', 'sending')) = (recipient is not null)),
  check (recipient is null or char_length(recipient) between 3 and 320),
  check ((status = 'sending') = (lease_owner is not null and lease_until is not null)),
  check ((status = 'sent') = (sent_at is not null))
);
alter table public.account_deletion_completion_notices owner to postgres;
alter table public.account_deletion_completion_notices enable row level security;
alter table public.account_deletion_completion_notices force row level security;
revoke all on public.account_deletion_completion_notices from public, anon, authenticated, service_role;
create index account_deletion_completion_notices_due_idx
  on public.account_deletion_completion_notices (next_attempt_at) where status in ('pending', 'sending');

-- Captura (idempotente): solo la solicitud reclamada por ESTE worker, aún sin completar, y mientras la identidad exista.
create function public.account_deletion_notice_capture(p_request_id uuid, p_worker text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_req public.account_deletion_requests%rowtype; v_email text; v_meta text; v_locale text; v_n integer;
begin
  if p_request_id is null or p_worker is null or char_length(p_worker) > 100 then raise exception 'invalid_argument'; end if;
  select * into v_req from public.account_deletion_requests where id = p_request_id;
  if not found or v_req.lease_owner is distinct from p_worker
     or v_req.status not in ('access_blocked', 'cleanup_in_progress', 'cleanup_retry_pending') then
    return false;
  end if;
  select nullif(btrim(u.email), ''), u.raw_user_meta_data ->> 'locale' into v_email, v_meta from auth.users u where u.id = v_req.user_id;
  if v_email is null or char_length(v_email) not between 3 and 320 then return false; end if;
  v_locale := case when v_meta in ('es', 'en', 'de') then v_meta else 'en' end;
  insert into public.account_deletion_completion_notices (request_id, recipient, locale)
    values (p_request_id, v_email, v_locale) on conflict (request_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
alter function public.account_deletion_notice_capture(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_notice_capture(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_notice_capture(uuid, text) to service_role;

-- Reclamación atómica: solo solicitudes COMPLETED con completed_at, con lease de 10 min y dentro de la ventana de idempotencia (23 h).
create function public.account_deletion_notice_claim(p_worker text, p_limit integer default 3)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp(); v_out jsonb := '[]'::jsonb; r record;
begin
  if p_worker is null or char_length(p_worker) > 100 or p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'invalid_argument'; end if;
  for r in
    select n.request_id from public.account_deletion_completion_notices n
      join public.account_deletion_requests q on q.id = n.request_id
     where q.status = 'completed' and q.completed_at is not null
       and n.recipient is not null and n.attempts < 5 and n.purge_by > v_now
       and coalesce(n.first_attempt_at, v_now) > v_now - interval '23 hours'
       and ((n.status = 'pending' and n.next_attempt_at <= v_now) or (n.status = 'sending' and n.lease_until <= v_now))
     order by n.next_attempt_at limit p_limit
     for update of n skip locked
  loop
    update public.account_deletion_completion_notices
       set status = 'sending', attempts = attempts + 1, lease_owner = p_worker, lease_until = v_now + interval '10 minutes',
           first_attempt_at = coalesce(first_attempt_at, v_now)
     where request_id = r.request_id;
    v_out := v_out || (select jsonb_build_object('requestId', n.request_id, 'recipient', n.recipient, 'locale', n.locale, 'attempt', n.attempts)
                         from public.account_deletion_completion_notices n where n.request_id = r.request_id);
  end loop;
  return v_out;
end;
$$;
alter function public.account_deletion_notice_claim(text, integer) owner to postgres;
revoke execute on function public.account_deletion_notice_claim(text, integer) from public, anon, authenticated;
grant execute on function public.account_deletion_notice_claim(text, integer) to service_role;

-- Resultado del envío. Éxito ⇒ el correo se borra en la misma sentencia. Fallo ⇒ backoff (5 min, 15 min, 1 h, 4 h) o abandono tras 5.
create function public.account_deletion_notice_finish(p_request_id uuid, p_worker text, p_ok boolean, p_error_code text default null)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_n public.account_deletion_completion_notices%rowtype; v_now timestamptz := pg_catalog.clock_timestamp(); v_delay integer;
begin
  if p_request_id is null or p_worker is null or p_ok is null or (p_ok and p_error_code is not null)
     or (not p_ok and (p_error_code is null or p_error_code not in
       ('not_configured', 'rejected', 'rate_limited', 'provider_unavailable', 'timeout', 'invalid_response', 'unexpected'))) then
    raise exception 'invalid_argument';
  end if;
  select * into v_n from public.account_deletion_completion_notices
   where request_id = p_request_id and status = 'sending' and lease_owner = p_worker for update;
  if not found then return 'lease_lost'; end if;
  if p_ok then
    update public.account_deletion_completion_notices
       set status = 'sent', recipient = null, sent_at = v_now, lease_owner = null, lease_until = null, last_error_code = null
     where request_id = p_request_id;
    return 'sent';
  end if;
  if v_n.attempts >= 5 or p_error_code in ('rejected', 'not_configured') then
    update public.account_deletion_completion_notices
       set status = 'abandoned', recipient = null, lease_owner = null, lease_until = null, last_error_code = p_error_code
     where request_id = p_request_id;
    return 'abandoned';
  end if;
  v_delay := (array[300, 900, 3600, 14400])[least(v_n.attempts, 4)];
  update public.account_deletion_completion_notices
     set status = 'pending', lease_owner = null, lease_until = null, last_error_code = p_error_code,
         next_attempt_at = v_now + pg_catalog.make_interval(secs => v_delay)
   where request_id = p_request_id;
  return 'retry_scheduled';
end;
$$;
alter function public.account_deletion_notice_finish(uuid, text, boolean, text) owner to postgres;
revoke execute on function public.account_deletion_notice_finish(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.account_deletion_notice_finish(uuid, text, boolean, text) to service_role;

-- Purga: retención máxima 14 días; también abandona lo que ya no puede reintentarse sin riesgo de duplicado.
create function public.account_deletion_notice_purge()
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_now timestamptz := pg_catalog.clock_timestamp(); v_n integer;
begin
  update public.account_deletion_completion_notices
     set status = 'abandoned', recipient = null, lease_owner = null, lease_until = null
   where status in ('pending', 'sending')
     and (purge_by <= v_now
          or first_attempt_at <= v_now - interval '23 hours'
          or (attempts >= 5 and (status = 'pending' or lease_until <= v_now)));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
alter function public.account_deletion_notice_purge() owner to postgres;
revoke execute on function public.account_deletion_notice_purge() from public, anon, authenticated;
grant execute on function public.account_deletion_notice_purge() to service_role;

-- Despertador: además del trabajo de limpieza, un aviso final VENCIDO también es trabajo (si no, un reintento tras un fallo de correo
-- no despertaría al ejecutor hasta la siguiente eliminación). Misma firma, propietario y privilegios que la versión de DEL-2; la
-- condición de limpieza es IDÉNTICA y solo se suma la de avisos. (Rollback: restaurar la definición de 20261114120000.)
create or replace function public.account_deletion_backlog()
returns integer language sql stable security definer set search_path = pg_catalog, public as $$
  select (
    (select count(*) from public.account_deletion_requests r
      where r.status = 'access_blocked'
         or (r.status = 'cleanup_retry_pending' and r.next_retry_at <= pg_catalog.clock_timestamp())
         or (r.status = 'cleanup_in_progress' and r.lease_until <= pg_catalog.clock_timestamp()))
    +
    (select count(*) from public.account_deletion_completion_notices n
       join public.account_deletion_requests q on q.id = n.request_id
      where q.status = 'completed' and q.completed_at is not null and n.recipient is not null
        and n.attempts < 5 and n.purge_by > pg_catalog.clock_timestamp()
        and coalesce(n.first_attempt_at, pg_catalog.clock_timestamp()) > pg_catalog.clock_timestamp() - interval '23 hours'
        and ((n.status = 'pending' and n.next_attempt_at <= pg_catalog.clock_timestamp())
             or (n.status = 'sending' and n.lease_until <= pg_catalog.clock_timestamp())))
  )::integer
$$;
alter function public.account_deletion_backlog() owner to postgres;
revoke all on function public.account_deletion_backlog() from public, anon, authenticated, service_role;
