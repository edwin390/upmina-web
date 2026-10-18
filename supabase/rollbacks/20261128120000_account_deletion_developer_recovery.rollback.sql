-- Rollback de 20261128120000_account_deletion_developer_recovery.sql: elimina las dos funciones nuevas y restaura
-- account_deletion_developer_retry con la definición exacta de 20261113120000_account_deletion_foundation.sql.
drop function public.account_deletion_notice_developer_retry(uuid, uuid);
drop function public.account_deletion_notice_alerts(uuid);

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
  if v_req.status not in ('cleanup_retry_pending', 'cleanup_manual_required') then raise exception 'retry_not_applicable'; end if;
  -- Solo se reprograma: el ejecutor (mismo claim que los reintentos automáticos) reprocesa las etapas incompletas. No se toca la barrera.
  update public.account_deletion_steps set status = 'pending' where request_id = p_request_id and status = 'failed';
  update public.account_deletion_requests
     set status = 'cleanup_retry_pending', next_retry_at = v_now, consecutive_failures = 0, manual_retry_count = manual_retry_count + 1,
         version = version + 1
   where id = p_request_id;
  insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
    values (p_request_id, 'developer_retry', 'human', p_actor_user_id, v_now);
  return jsonb_build_object('requestId', p_request_id, 'status', 'cleanup_retry_pending');
end;
$$;
alter function public.account_deletion_developer_retry(uuid, uuid) owner to postgres;
revoke execute on function public.account_deletion_developer_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_developer_retry(uuid, uuid) to service_role;
