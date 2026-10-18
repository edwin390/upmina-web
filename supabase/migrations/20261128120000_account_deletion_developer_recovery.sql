-- DEL-4b: recuperación MANUAL desde Developer. No crea un sistema nuevo de reintentos ni activa el cron: reutiliza el ejecutor (claim) y
-- `kick`. Redefine UNA función de DEL-1 (account_deletion_developer_retry) y AÑADE dos (alertas y reintento de avisos finales).
--
--  1) developer_retry admite además las solicitudes REALMENTE estancadas, que el panel ya mostraba como "estancadas":
--       * access_blocked desde hace más de 15 min (mismo umbral que account_deletion_alerts);
--       * cleanup_in_progress con el lease CADUCADO (con lease vigente ⇒ 'lease_active': hay una ejecución en curso).
--     No cambia estado (la barrera sigue activa, las etapas hechas no se repiten): solo deja constancia (evento + contador) y el
--     `kick` del handler hace que el claim existente las recoja. El comportamiento para cleanup_retry_pending / cleanup_manual_required
--     es EXACTAMENTE el anterior. La fila queda bloqueada (FOR UPDATE), de modo que dos reintentos simultáneos se serializan.
--  2) account_deletion_notice_alerts: avisos finales que requieren intervención. NO devuelve el correo ni el id de la cuenta.
--  3) account_deletion_notice_developer_retry: adelanta un aviso final elegible; no envía nada por sí mismo (lo envía el ejecutor).
--
-- ROLLBACK: drop de las dos funciones nuevas y restaurar account_deletion_developer_retry con la definición de
-- 20261113120000_account_deletion_foundation.sql.

create or replace function public.account_deletion_developer_retry(p_actor_user_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_role text; v_req public.account_deletion_requests%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is distinct from 'developer' then raise exception 'actor_not_developer'; end if;
  if p_request_id is null then raise exception 'invalid_argument'; end if;
  select * into v_req from public.account_deletion_requests where id = p_request_id for update;
  if not found or v_req.confirmed_at is null then raise exception 'request_not_found'; end if;
  if v_req.status = 'completed' then raise exception 'already_completed'; end if;
  if v_req.status in ('cleanup_retry_pending', 'cleanup_manual_required') then
    -- Solo se reprograma: el ejecutor (mismo claim que los reintentos automáticos) reprocesa las etapas incompletas. No se toca la barrera.
    update public.account_deletion_steps set status = 'pending' where request_id = p_request_id and status = 'failed';
    update public.account_deletion_requests
       set status = 'cleanup_retry_pending', next_retry_at = v_now, consecutive_failures = 0, manual_retry_count = manual_retry_count + 1,
           version = version + 1
     where id = p_request_id;
    insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
      values (p_request_id, 'developer_retry', 'human', p_actor_user_id, v_now);
    return jsonb_build_object('requestId', p_request_id, 'status', 'cleanup_retry_pending');
  elsif v_req.status = 'access_blocked' then
    if v_req.access_blocked_at > v_now - interval '15 minutes' then raise exception 'not_stalled'; end if;
  elsif v_req.status = 'cleanup_in_progress' then
    if v_req.lease_until is not null and v_req.lease_until > v_now then raise exception 'lease_active'; end if;
  else
    raise exception 'retry_not_applicable';
  end if;
  -- Estancada de verdad (sin ejecución en curso): sin cambio de estado; el claim existente la recoge (access_blocked, o lease caducado).
  update public.account_deletion_requests set manual_retry_count = manual_retry_count + 1, version = version + 1 where id = p_request_id;
  insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, metadata, created_at)
    values (p_request_id, 'developer_retry', 'human', p_actor_user_id, jsonb_build_object('stalled', true, 'fromStatus', v_req.status), v_now);
  return jsonb_build_object('requestId', p_request_id, 'status', v_req.status);
end;
$$;
alter function public.account_deletion_developer_retry(uuid, uuid) owner to postgres;
revoke execute on function public.account_deletion_developer_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_developer_retry(uuid, uuid) to service_role;

-- Avisos finales que requieren intervención (sin correo ni identidad). `retryable` y `blockedReason` los calcula la BD con la misma
-- lógica que usa el reintento, para que la interfaz no duplique reglas.
create function public.account_deletion_notice_alerts(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_role text; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id;
  if v_role is distinct from 'developer' then raise exception 'actor_not_developer'; end if;
  return coalesce((select jsonb_agg(row_json order by created_at desc) from (
    select n.created_at, jsonb_build_object(
      'requestId', n.request_id, 'status', n.status, 'attempts', n.attempts, 'errorCode', n.last_error_code,
      'nextAttemptAt', n.next_attempt_at, 'firstAttemptAt', n.first_attempt_at, 'purgeBy', n.purge_by, 'createdAt', n.created_at,
      'blockedReason', case
        when n.status = 'abandoned' then 'abandoned'
        when n.recipient is null then 'abandoned'
        when n.status = 'sending' and n.lease_until > v_now then 'lease_active'
        when n.attempts >= 5 then 'attempts_exhausted'
        when n.purge_by <= v_now or n.first_attempt_at <= v_now - interval '23 hours' then 'window_expired'
        else null end,
      'retryable', (n.status in ('pending', 'sending') and n.recipient is not null and not (n.status = 'sending' and n.lease_until > v_now)
                    and n.attempts < 5 and n.purge_by > v_now and coalesce(n.first_attempt_at, v_now) > v_now - interval '23 hours')
    ) as row_json
    from public.account_deletion_completion_notices n
    join public.account_deletion_requests q on q.id = n.request_id
    where q.status = 'completed' and q.completed_at is not null and n.created_at > v_now - interval '30 days'
      and (n.status = 'abandoned'
           or (n.status = 'pending' and (n.last_error_code is not null or n.next_attempt_at < v_now - interval '30 minutes'))
           or (n.status = 'sending' and n.lease_until <= v_now))
    order by n.created_at desc limit 50) x), '[]'::jsonb);
end;
$$;
alter function public.account_deletion_notice_alerts(uuid) owner to postgres;
revoke execute on function public.account_deletion_notice_alerts(uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_notice_alerts(uuid) to service_role;

-- Reintento manual de un aviso final. Solo adelanta `next_attempt_at`: el ejecutor lo reclama (atómico, con lease) y lo envía. Respeta el
-- límite de 5 intentos, la ventana de idempotencia (23 h) y la retención (purge_by); un aviso abandonado (correo ya borrado) o enviado NO se reabre.
create function public.account_deletion_notice_developer_retry(p_actor_user_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_req public.account_deletion_requests%rowtype; v_n public.account_deletion_completion_notices%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is distinct from 'developer' then raise exception 'actor_not_developer'; end if;
  if p_request_id is null then raise exception 'invalid_argument'; end if;
  select * into v_req from public.account_deletion_requests where id = p_request_id for update;
  if not found or v_req.confirmed_at is null then raise exception 'request_not_found'; end if;
  if v_req.status <> 'completed' or v_req.completed_at is null then raise exception 'request_not_completed'; end if;
  select * into v_n from public.account_deletion_completion_notices where request_id = p_request_id for update;
  if not found then raise exception 'notice_not_found'; end if;
  if v_n.status = 'sent' then raise exception 'already_sent'; end if;
  if v_n.status = 'abandoned' or v_n.recipient is null then raise exception 'notice_abandoned'; end if;
  if v_n.status = 'sending' and v_n.lease_until > v_now then raise exception 'lease_active'; end if;
  if v_n.attempts >= 5 then raise exception 'attempts_exhausted'; end if;
  if v_n.purge_by <= v_now or v_n.first_attempt_at <= v_now - interval '23 hours' then raise exception 'window_expired'; end if;
  -- 'sending' con lease caducado ya es reclamable; 'pending' se adelanta. No se tocan intentos, destinatario ni estado.
  update public.account_deletion_completion_notices set next_attempt_at = least(next_attempt_at, v_now) where request_id = p_request_id;
  insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, metadata, created_at)
    values (p_request_id, 'developer_retry', 'human', p_actor_user_id, jsonb_build_object('target', 'completion_notice'), v_now);
  return jsonb_build_object('requestId', p_request_id, 'status', v_n.status);
end;
$$;
alter function public.account_deletion_notice_developer_retry(uuid, uuid) owner to postgres;
revoke execute on function public.account_deletion_notice_developer_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_notice_developer_retry(uuid, uuid) to service_role;
