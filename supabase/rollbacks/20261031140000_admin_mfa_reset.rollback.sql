-- Rollback de 20261031140000_admin_mfa_reset.sql. SOLO para operador/local; no es una migración.
-- Se niega si ya existen limpiezas registradas o auditoría 'mfa_reset_completed' (se perdería historial).

do $$
begin
  if exists (select 1 from public.admin_mfa_resets) then
    raise exception 'rollback_blocked: admin_mfa_resets contiene historial';
  end if;
  if exists (select 1 from public.admin_team_audit where action = 'mfa_reset_completed') then
    raise exception 'rollback_blocked: admin_team_audit contiene mfa_reset_completed';
  end if;
end $$;

grant execute on function public.remove_admin_member(uuid, uuid) to service_role;

drop function public.admin_mfa_activation_check(uuid, uuid);
drop function public.admin_mfa_cleanups_pending(uuid);
drop function public.admin_mfa_reset_record(uuid, boolean, integer, text);
drop function public.admin_mfa_pending_reset(uuid);
drop function public.admin_remove_member_with_mfa_reset(uuid, uuid);
drop trigger admin_mfa_resets_guard on public.admin_mfa_resets;
drop function public.admin_mfa_resets_guard();
drop table public.admin_mfa_resets;

alter table public.admin_team_audit drop constraint admin_team_audit_shape_check;
alter table public.admin_team_audit add constraint admin_team_audit_shape_check
  check (
    (action = 'role_changed' and new_role is not null and new_role <> old_role)
    or (action = 'access_removed' and new_role is null)
  );
alter table public.admin_team_audit drop constraint admin_team_audit_action_check;
alter table public.admin_team_audit add constraint admin_team_audit_action_check
  check (action in ('role_changed', 'access_removed'));
