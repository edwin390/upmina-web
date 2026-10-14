-- DEL-2: piezas de base de datos del ejecutor de eliminación de cuentas. Requiere 20261113120000 (DEL-1). NO programa nada.
--
--   * account_deletion_revoke_sessions: etapa auth_block, parte SQL. Borra las sesiones (y, por cascada de Auth, sus refresh tokens) de la cuenta.
--     El JWT de acceso ya emitido sigue siendo válido hasta caducar: lo que lo neutraliza es account_deletion_gate en requireAuthenticated.
--   * account_deletion_tick: UN despertador que solo EXPIRA solicitudes y avisa al backend firmado (HMAC de dominio propio
--     UPMINA-ACCOUNT-DELETION-V1, mismo patrón que community_media_purge_tick). No decide qué se borra: el backend reclama por lease.
--     Los secretos (Vault) son pasos del operador: 'account_deletion_shared_secret' y 'account_deletion_endpoint_url'.
--   * La PROGRAMACIÓN (pg_cron) NO está en esta migración a propósito: aplicarla no activa el flujo. Ver docs/DEL-1-ACCOUNT-DELETION.md §13.
-- Rollback (solo local/operador): supabase/rollbacks/20261114120000_account_deletion_runtime.rollback.sql

create function public.account_deletion_revoke_sessions(p_request_id uuid, p_worker text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid; v_n integer;
begin
  v_user := public.account_deletion_assert_running(p_request_id, p_worker, 'auth_block');
  delete from auth.sessions where user_id = v_user;
  get diagnostics v_n = row_count;
  return jsonb_build_object('sessionsRevoked', v_n);
end;
$$;
alter function public.account_deletion_revoke_sessions(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_revoke_sessions(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_revoke_sessions(uuid, text) to service_role;

-- Trabajo que el backend puede reclamar AHORA (misma condición que account_deletion_claim). Solo cuenta; no devuelve filas.
create function public.account_deletion_backlog()
returns integer language sql stable security definer set search_path = pg_catalog, public as $$
  select count(*)::integer from public.account_deletion_requests r
   where r.status = 'access_blocked'
      or (r.status = 'cleanup_retry_pending' and r.next_retry_at <= pg_catalog.clock_timestamp())
      or (r.status = 'cleanup_in_progress' and r.lease_until <= pg_catalog.clock_timestamp())
$$;
alter function public.account_deletion_backlog() owner to postgres;
revoke all on function public.account_deletion_backlog() from public, anon, authenticated, service_role;

create function public.account_deletion_tick()
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  c_endpoint_path constant text := '/api/admin/account-deletion-run';
  v_expired integer; v_backlog integer; v_secret text; v_url text; v_ts text; v_sig text; v_request_id bigint;
begin
  if not pg_try_advisory_xact_lock(pg_catalog.hashtextextended('upmina.account_deletion_tick', 0)) then
    return jsonb_build_object('status', 'skipped_overlap');
  end if;
  v_expired := public.account_deletion_expire_pending(200);
  v_backlog := public.account_deletion_backlog();
  if v_backlog = 0 then
    return jsonb_build_object('status', 'idle', 'expired', v_expired, 'backlog', 0);
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'account_deletion_shared_secret' limit 1;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'account_deletion_endpoint_url' limit 1;
  if v_secret is null or length(v_secret) < 32 or v_url is null
     or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/api/admin/account-deletion-run$' then
    raise warning 'account_deletion_tick: runner_not_configured';
    return jsonb_build_object('status', 'runner_not_configured', 'expired', v_expired, 'backlog', v_backlog);
  end if;
  v_ts := floor(extract(epoch from clock_timestamp()))::bigint::text;
  v_sig := rtrim(translate(encode(extensions.hmac(
      convert_to('UPMINA-ACCOUNT-DELETION-V1' || chr(10) || 'POST' || chr(10) || c_endpoint_path || chr(10) || v_ts, 'UTF8'),
      convert_to(v_secret, 'UTF8'), 'sha256'), 'base64'), '+/', '-_'), '=');
  -- La petición no lleva NADA elegido por el despertador: ni cuentas, ni etapas, ni límites.
  v_request_id := net.http_post(
    url := v_url,
    headers := jsonb_build_object('x-deletion-timestamp', v_ts, 'x-deletion-signature', v_sig),
    timeout_milliseconds := 30000);
  return jsonb_build_object('status', 'runner_enqueued', 'requestId', v_request_id, 'expired', v_expired, 'backlog', v_backlog);
end;
$$;
alter function public.account_deletion_tick() owner to postgres;
revoke all on function public.account_deletion_tick() from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_tick() to postgres;
