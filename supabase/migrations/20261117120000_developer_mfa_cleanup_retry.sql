-- Reintento manual de limpiezas de MFA: pasa de ADMIN a DEVELOPER (el rol admin deja de poder listarlas/reintentarlas).
-- Solo AÑADE una función de lectura: ids de usuarios con limpieza pendiente, restringida a quien tenga rol developer.
-- No toca admin_mfa_cleanups_pending (queda sin uso desde el backend) ni ninguna tabla.
create function public.admin_mfa_cleanup_pending_ids_for_developer(p_actor_user_id uuid)
returns table (out_user_id uuid)
language plpgsql security definer stable set search_path = pg_catalog, public as $$
begin
  if p_actor_user_id is null
     or not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'developer') then
    raise exception 'actor_not_developer';
  end if;
  return query
    select r.user_id from public.admin_mfa_resets r
     where r.status = 'pending' order by r.requested_at limit 50;
end;
$$;
alter function public.admin_mfa_cleanup_pending_ids_for_developer(uuid) owner to postgres;
revoke all on function public.admin_mfa_cleanup_pending_ids_for_developer(uuid) from public, anon, authenticated;
grant execute on function public.admin_mfa_cleanup_pending_ids_for_developer(uuid) to service_role;
