-- R5-H: contador de casos pendientes de moderación. Solo agregado (un entero), sin filas ni datos
-- de personas. Definición = la cola «Activos»: ciclo en `pending` que además es el ciclo VIGENTE de
-- su caso (un caso con ciclos anteriores cerrados cuenta una sola vez). Mismo control de rol que
-- community_moderation_cases_read; ACL solo service_role.
create function public.community_moderation_pending_count(p_actor_user_id uuid)
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_role text; v_count integer;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator','developer','admin') then raise exception 'actor_not_moderator'; end if;
  select count(*)::integer into v_count
  from public.community_moderation_cycles y
  join public.community_moderation_cases c on c.id = y.case_id
  where y.status = 'pending' and y.cycle_number = c.current_cycle;
  return v_count;
end;
$$;
alter function public.community_moderation_pending_count(uuid) owner to postgres;
revoke all on function public.community_moderation_pending_count(uuid) from public, anon, authenticated, service_role;
grant execute on function public.community_moderation_pending_count(uuid) to service_role;
