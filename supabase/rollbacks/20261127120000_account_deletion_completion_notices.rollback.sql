-- Rollback de 20261127120000_account_deletion_completion_notices.sql. Solo elimina datos de avisos finales (nunca de eliminación de
-- cuentas) y restaura account_deletion_backlog() con la definición exacta de 20261114120000_account_deletion_runtime.sql.
-- Orden: primero el despertador (referencia la tabla), luego las funciones y por último la tabla.

create or replace function public.account_deletion_backlog()
returns integer language sql stable security definer set search_path = pg_catalog, public as $$
  select count(*)::integer from public.account_deletion_requests r
   where r.status = 'access_blocked'
      or (r.status = 'cleanup_retry_pending' and r.next_retry_at <= pg_catalog.clock_timestamp())
      or (r.status = 'cleanup_in_progress' and r.lease_until <= pg_catalog.clock_timestamp())
$$;
alter function public.account_deletion_backlog() owner to postgres;
revoke all on function public.account_deletion_backlog() from public, anon, authenticated, service_role;

drop function public.account_deletion_notice_purge();
drop function public.account_deletion_notice_finish(uuid, text, boolean, text);
drop function public.account_deletion_notice_claim(text, integer);
drop function public.account_deletion_notice_capture(uuid, text);
drop table public.account_deletion_completion_notices;
