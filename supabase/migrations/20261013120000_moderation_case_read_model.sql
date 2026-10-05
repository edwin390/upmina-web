-- R3: privileged, bounded case/cycle reads only. No decisions or historical DML.
create index community_post_reports_cycle_activity_idx
  on public.community_post_reports (cycle_id, updated_at desc, id desc);
create index community_moderation_cycles_status_idx
  on public.community_moderation_cycles (status, case_id, cycle_number);

-- Internal projection. Never exposes reporter or auth identities, even in detail.
create function public.community_moderation_cycle_read(p_cycle_id uuid, p_detail boolean)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'caseId', c.id, 'caseVersion', c.version, 'postId', c.post_id,
    'currentCycleId', current_y.id, 'currentCycleNumber', c.current_cycle,
    'cycleId', y.id, 'cycleNumber', y.cycle_number,
    'caseStatus', c.status, 'cycleStatus', y.status, 'closureKind', y.closure_kind,
    'createdAt', c.created_at, 'openedAt', y.opened_at, 'closedAt', y.closed_at,
    'activityAt', greatest(y.opened_at, coalesce(s.activity_at, y.opened_at), coalesce(y.closed_at, y.opened_at)),
    'isCurrentCycle', y.cycle_number = c.current_cycle,
    'post', case when p.id is null then null else jsonb_build_object(
      'text', case when p_detail then p.text else left(p.text, 280) end,
      'status', p.status, 'version', p.version, 'updatedAt', p.updated_at,
      'authorUsername', pr.username, 'quarantineCycleId', p.quarantine_cycle_id) end,
    'totalReports', s.total, 'qualifyingReporters', s.qualifying,
    'firstReportAt', s.first_at, 'lastReportAt', s.last_at,
    'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by reason)
      from (select reason, count(*) n from public.community_post_reports
        where case_id = c.id and cycle_id = y.id group by reason) reasons), '[]'::jsonb),
    'reports', case when p_detail then coalesce((select jsonb_agg(to_jsonb(r) order by r."createdAt" desc, r."reportId" desc)
      from (select id as "reportId", reason, detail, status, version, created_at as "createdAt"
        from public.community_post_reports where case_id = c.id and cycle_id = y.id
        order by created_at desc, id desc limit 50) r), '[]'::jsonb) else '[]'::jsonb end,
    'reportsTruncated', p_detail and s.total > 50,
    'media', case when p_detail and p.id is not null then coalesce((select jsonb_agg(to_jsonb(m) order by m.position)
      from (select pm.id, pm.position, jsonb_build_object('status', a.status, 'kind', a.kind,
        'storage_key', a.storage_key, 'width', a.width, 'height', a.height,
        'duration_seconds', a.duration_seconds) as media_assets
        from public.community_post_media pm join public.media_assets a on a.id = pm.asset_id
        where pm.post_id = p.id order by pm.position limit 10) m), '[]'::jsonb) else '[]'::jsonb end,
    'audit', case when p_detail then coalesce((select jsonb_agg(to_jsonb(a) order by a."createdAt" desc, a.id desc)
      from (select a.id, a.action, a.actor_kind as "actorKind", a.created_at as "createdAt",
        jsonb_build_object('fromPostStatus', a.metadata->'from_post_status',
          'toPostStatus', a.metadata->'to_post_status',
          'fromReportStatus', coalesce(a.metadata->'from_report_status', a.metadata->'from_status'),
          'toReportStatus', coalesce(a.metadata->'to_report_status', a.metadata->'to_status')) as states
        from public.moderation_audit_log a where
          (a.target_type = 'community_post' and a.target_id = c.post_id)
          or (a.target_type = 'community_moderation_case' and a.target_id = c.id)
          or (a.target_type = 'community_post_report' and exists
            (select 1 from public.community_post_reports r where r.id = a.target_id and r.cycle_id = y.id))
        order by a.created_at desc, a.id desc limit 20) a), '[]'::jsonb) else '[]'::jsonb end
  ) from public.community_moderation_cycles y
  join public.community_moderation_cases c on c.id = y.case_id
  join public.community_moderation_cycles current_y on current_y.case_id = c.id and current_y.cycle_number = c.current_cycle
  left join public.community_posts p on p.id = c.post_id
  left join public.profiles pr on pr.user_id = p.author_user_id
  cross join lateral (select count(*) total,
    count(distinct r.reporter_user_id) filter (where y.cycle_number = c.current_cycle and y.status = 'pending'
      and r.status in ('open','reviewing')
      and u.id is not null and r.reporter_user_id <> coalesce(p.author_user_id, c.target_author_user_id)) qualifying,
    min(r.created_at) first_at, max(r.created_at) last_at, max(r.updated_at) activity_at
    from public.community_post_reports r left join auth.users u on u.id = r.reporter_user_id
    where r.case_id = c.id and r.cycle_id = y.id) s
  where y.id = p_cycle_id;
$$;
alter function public.community_moderation_cycle_read(uuid, boolean) owner to postgres;
revoke all on function public.community_moderation_cycle_read(uuid, boolean) from public, anon, authenticated, service_role;

-- One SQL snapshot for page/projection. Role lock protects authority through the read.
-- Active = current pending cycles, even if old individual actions closed every report.
-- History = closed cycles, including prior cycles; legacy closure is not a decision.
create function public.community_moderation_cases_read(
  p_actor_user_id uuid, p_scope text default 'active',
  p_before_activity timestamptz default null, p_before_cycle uuid default null,
  p_cycle_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_role text; v_result jsonb;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator','developer','admin') then raise exception 'actor_not_moderator'; end if;
  if p_scope is null or p_scope not in ('active','closed')
    or (p_before_activity is null) <> (p_before_cycle is null) then raise exception 'invalid_argument'; end if;
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
    where (p_scope = 'active' and y.status = 'pending' and y.cycle_number = c.current_cycle)
      or (p_scope = 'closed' and y.status = 'closed')
  ), page as (
    select * from candidates where p_before_activity is null or (activity, id) < (p_before_activity, p_before_cycle)
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
alter function public.community_moderation_cases_read(uuid, text, timestamptz, uuid, uuid) owner to postgres;
revoke all on function public.community_moderation_cases_read(uuid, text, timestamptz, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.community_moderation_cases_read(uuid, text, timestamptz, uuid, uuid) to service_role;
