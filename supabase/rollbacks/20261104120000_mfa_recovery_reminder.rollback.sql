-- Rollback LOCAL/OPERADOR de 20261104120000_mfa_recovery_reminder.sql. NO ejecutar automáticamente.
-- Se niega a ejecutarse si ya hay correos 'reminder' registrados: son historial de envíos y no se destruyen.
do $$
begin
  if exists (select 1 from public.admin_mfa_recovery_mail where kind = 'reminder') then
    raise exception 'rollback_refused_reminders_exist';
  end if;
end;
$$;

drop function if exists public.admin_mfa_recovery_reminder_start(uuid, uuid);

alter table public.admin_mfa_recovery_mail drop constraint admin_mfa_recovery_mail_kind_check;
alter table public.admin_mfa_recovery_mail add constraint admin_mfa_recovery_mail_kind_check
  check (kind in ('challenge', 'approved', 'closed', 'completed'));
