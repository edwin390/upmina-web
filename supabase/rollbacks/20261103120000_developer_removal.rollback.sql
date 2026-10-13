-- Rollback LOCAL/OPERADOR de 20261103120000_developer_removal.sql. NO ejecutar automáticamente.
-- Las limpiezas MFA registradas por esta migración (admin_mfa_resets con old_role = 'developer') pertenecen a la
-- infraestructura de la fase 1 y no se tocan: ese historial se conserva (el rollback ya se niega si hay 'removed').
-- Se niega a ejecutarse si ya hay retiradas registradas ('removed'): ese historial es auditoría append-only y no
-- se destruye (y new_role volvería a ser NOT NULL). Restaura la forma de admin_developer_audit de 20261102120000.
do $$
begin
  if exists (select 1 from public.admin_developer_audit where action = 'removed') then
    raise exception 'rollback_refused_developer_removals_exist';
  end if;
end;
$$;

drop function if exists public.admin_remove_developer(uuid, uuid);

alter table public.admin_developer_audit drop constraint admin_developer_audit_shape_check;
alter table public.admin_developer_audit add constraint admin_developer_audit_shape_check check (
  (action = 'granted' and previous_role = 'moderator' and new_role = 'developer'
     and actor_user_id is null and operator_note is not null)
  or (action = 'revoked' and previous_role = 'developer' and new_role = 'moderator'
     and actor_user_id is null and operator_note is not null)
  or (action = 'self_transferred' and previous_role = 'admin' and new_role = 'developer'
     and actor_user_id = target_user_id and operator_note is null)
  or (action = 'restored' and previous_role = 'developer' and new_role in ('admin', 'moderator')
     and actor_user_id is not null and actor_user_id <> target_user_id and operator_note is null));
alter table public.admin_developer_audit alter column new_role set not null;
