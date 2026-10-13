-- Rollback LOCAL/OPERADOR de 20261031150000_admin_mfa_recovery.sql. NO ejecutar automáticamente.
-- Se niega a ejecutarse si ya existe historial de recuperaciones: ese historial es auditoría y los
-- factores TOTP ya eliminados no se pueden restaurar (el titular tendría que volver a enrolar).
do $$
begin
  if exists (select 1 from public.admin_mfa_recoveries) then
    raise exception 'rollback_refused_recovery_history_exists';
  end if;
end;
$$;

drop function if exists public.admin_mfa_recovery_mail_event(text, text);
drop function if exists public.admin_mfa_recovery_mail_result(text, boolean, text, text);
drop function if exists public.admin_mfa_recovery_mail_start(uuid, text, text);
drop function if exists public.admin_mfa_recovery_complete(uuid, uuid);
drop function if exists public.admin_mfa_recovery_record_execution(uuid, boolean, integer, text);
drop function if exists public.admin_mfa_recovery_begin_execute(uuid, uuid);
drop function if exists public.admin_mfa_recovery_current(uuid);
drop function if exists public.admin_mfa_recoveries_pending(uuid);
drop function if exists public.admin_mfa_recovery_deny(uuid, uuid, text);
drop function if exists public.admin_mfa_recovery_execution_allowed(uuid);
drop function if exists public.admin_mfa_recovery_cancel_by_token(text);
drop function if exists public.admin_mfa_recovery_cancel_check(text);
drop function if exists public.admin_mfa_recovery_set_cancel(uuid, text);
drop function if exists public.admin_mfa_recovery_approve(uuid, uuid, text);
drop function if exists public.admin_mfa_recovery_cancel(uuid, uuid);
drop function if exists public.admin_mfa_recovery_verify(uuid, text);
drop function if exists public.admin_mfa_recovery_resend(uuid, text);
drop function if exists public.admin_mfa_recovery_create(uuid, text);
drop function if exists public.admin_mfa_recovery_readiness(uuid);
drop function if exists public.admin_mfa_recovery_ready_at(uuid);
drop function if exists public.admin_mfa_recovery_close(uuid, text, text, uuid, text);
drop function if exists public.admin_mfa_recovery_email_hash(uuid);
drop function if exists public.admin_mfa_recovery_log(uuid, uuid, text, uuid, text);
drop table if exists public.admin_mfa_recovery_mail;
drop table if exists public.admin_mfa_recovery_events;
drop table if exists public.admin_mfa_recoveries;
drop function if exists public.admin_mfa_recovery_append_only();
drop function if exists public.admin_mfa_recoveries_guard();
