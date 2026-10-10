-- R5-G: filtros reales de la cola de moderación (motivo, ocultas preventivamente, autor, rango de
-- fechas) aplicados ANTES de paginar. La paginación sigue siendo por cursor (activity, id); no hay
-- OFFSET. La firma gana 5 parámetros con DEFAULT null, así que las llamadas anteriores (5 argumentos
-- posicionales o con nombre) siguen funcionando igual.
drop function public.community_moderation_cases_read(uuid, text, timestamptz, uuid, uuid);

create function public.community_moderation_cases_read(
  p_actor_user_id uuid, p_scope text default 'active',
  p_before_activity timestamptz default null, p_before_cycle uuid default null,
  p_cycle_id uuid default null,
  p_reason text default null, p_hidden_only boolean default false,
  p_author text default null,
  p_from timestamptz default null, p_to timestamptz default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_role text; v_result jsonb;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator','developer','admin') then raise exception 'actor_not_moderator'; end if;
  if p_scope is null or p_scope not in ('active','closed')
    or (p_before_activity is null) <> (p_before_cycle is null)
    or (p_reason is not null and p_reason not in ('spam','harassment','hate_speech','sexual_content','other'))
    or p_hidden_only is null
    or (p_author is not null and p_author !~ '^[a-z0-9_]{2,20}$')
    or (p_from is not null and p_to is not null and p_from >= p_to) then raise exception 'invalid_argument'; end if;
  if p_cycle_id is not null then
    select public.community_moderation_cycle_read(p_cycle_id, true) into v_result;
    if v_result is null then raise exception 'case_not_found'; end if;
    return jsonb_build_object('item', v_result);
  end if;
  with candidates as (
    select y.id, greatest(y.opened_at, coalesce((select max(r.updated_at)
      from public.community_post_reports r where r.cycle_id = y.id), y.opened_at),
      coalesce(y.closed_at, y.opened_at)) activity
    from public.community_moderation_cycles y join public.community_moderation_cases c on c.id = y.case_id
    where ((p_scope = 'active' and y.status = 'pending' and y.cycle_number = c.current_cycle)
      or (p_scope = 'closed' and y.status = 'closed'))
      and (p_reason is null or exists (select 1 from public.community_post_reports r
        where r.cycle_id = y.id and r.reason = p_reason))
      and (not p_hidden_only or exists (select 1 from public.community_posts p
        where p.id = c.post_id and p.status = 'hidden_pending_review'))
      and (p_author is null or exists (select 1 from public.community_posts p
        join public.profiles pr on pr.user_id = p.author_user_id
        where p.id = c.post_id and left(pr.username, length(p_author)) = p_author))
  ), ranged as (
    select * from candidates
    where (p_from is null or activity >= p_from) and (p_to is null or activity < p_to)
  ), page as (
    select * from ranged where p_before_activity is null or (activity, id) < (p_before_activity, p_before_cycle)
    order by activity desc, id desc limit 21
  ), shown as (select * from page order by activity desc, id desc limit 20)
  select jsonb_build_object('cases', coalesce((select jsonb_agg(public.community_moderation_cycle_read(id, false)
    order by activity desc, id desc) from shown), '[]'::jsonb),
    'next', case when (select count(*) from page) > 20 then
      (select jsonb_build_object('activityAt', activity, 'cycleId', id) from shown order by activity, id limit 1)
      else null end) into v_result;
  return v_result;
end;
$$;
alter function public.community_moderation_cases_read(uuid, text, timestamptz, uuid, uuid, text, boolean, text, timestamptz, timestamptz) owner to postgres;
revoke all on function public.community_moderation_cases_read(uuid, text, timestamptz, uuid, uuid, text, boolean, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.community_moderation_cases_read(uuid, text, timestamptz, uuid, uuid, text, boolean, text, timestamptz, timestamptz) to service_role;
