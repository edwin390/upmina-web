-- 9K-2. Depends on 9K-1; never apply as part of a 9J release.
-- Authority -> post -> report lock order for every moderation mutation.
alter table public.community_post_reports
  add column version integer not null default 1
    constraint community_post_reports_version_check check (version >= 1);

alter table public.moderation_audit_log drop constraint moderation_audit_log_target_type_check;
alter table public.moderation_audit_log add constraint moderation_audit_log_target_type_check
  check (target_type in ('community_post_report', 'community_post'));
alter table public.moderation_audit_log drop constraint moderation_audit_log_action_check;
alter table public.moderation_audit_log add constraint moderation_audit_log_action_check
  check (action in ('report_status_changed', 'post_hidden', 'post_restored'));
create index moderation_audit_log_target_created_idx
  on public.moderation_audit_log (target_type, target_id, created_at desc, id desc);

-- Disable the old service entry point: it has no expected version and can reopen reports.
-- Its historical definition remains intact; the HTTP status route now uses the new RPC.
revoke execute on function public.community_post_report_set_status(uuid, uuid, text, text)
  from service_role;
comment on function public.community_post_report_set_status(uuid, uuid, text, text) is
  'Retired in 9K-2: no role-row lock or optimistic version. API roles have no EXECUTE; use community_moderation_action.';
comment on column public.community_post_reports.status is
  'open -> reviewing -> resolved | dismissed via community_moderation_action. Closed reports are not reopened by restore.';
comment on column public.community_post_reports.version is
  'Optimistic concurrency version for each report transition. Independently validated with the target post version.';

create function public.community_moderation_action(
  p_actor_user_id uuid,
  p_report_id uuid,
  p_action text,
  p_expected_report_version integer,
  p_expected_post_version integer,
  p_note text
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_post_id uuid;
  v_post public.community_posts%rowtype;
  v_report public.community_post_reports%rowtype;
  v_post_exists boolean;
  v_next text;
  v_note text := nullif(btrim(p_note), '');
  v_before_post text;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_user_id is null or p_report_id is null
     or p_action is null or p_expected_report_version is null
     or p_expected_report_version < 1
     or (p_expected_post_version is not null and p_expected_post_version < 1) then
    raise exception 'invalid_argument';
  end if;
  if p_action not in ('hide', 'restore', 'reviewing', 'resolve', 'dismiss') then
    raise exception 'invalid_action';
  end if;
  if char_length(v_note) > 1000 then raise exception 'note_too_long'; end if;

  -- FOR SHARE prevents role UPDATE/DELETE until this transaction finishes, including
  -- non-key role changes (FOR KEY SHARE would not protect that boundary).
  select role into v_role from public.admin_roles
    where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('admin', 'moderator', 'developer') then
    raise exception 'actor_not_moderator';
  end if;

  select post_id into v_post_id from public.community_post_reports where id = p_report_id;
  if not found then raise exception 'report_not_found'; end if;
  select * into v_post from public.community_posts where id = v_post_id for update;
  v_post_exists := found;
  select * into v_report from public.community_post_reports where id = p_report_id for update;
  if not found then raise exception 'report_not_found'; end if;
  if v_report.post_id <> v_post_id or v_report.version <> p_expected_report_version then
    raise exception 'report_version_conflict';
  end if;
  -- NULL is an explicit expectation that the post no longer exists, not a wildcard.
  if (v_post_exists and (p_expected_post_version is null or v_post.version <> p_expected_post_version))
     or (not v_post_exists and p_expected_post_version is not null) then
    raise exception 'post_version_conflict';
  end if;
  if p_action in ('hide', 'restore') and not v_post_exists then
    raise exception 'post_not_found';
  end if;
  v_before_post := case when v_post_exists then v_post.status else null end;

  if p_action = 'restore' then
    if v_post.status <> 'hidden' then raise exception 'post_state_conflict'; end if;
    update public.community_posts set status = 'published', version = version + 1,
      updated_at = v_now where id = v_post_id;
    -- Restoring never reopens any report, including the selected report.
  else
    if v_report.status not in ('open', 'reviewing') then raise exception 'report_closed'; end if;
    if p_action = 'hide' then
      if v_post.status <> 'published' then raise exception 'post_state_conflict'; end if;
      update public.community_posts set status = 'hidden', version = version + 1,
        updated_at = v_now where id = v_post_id;
      v_next := 'resolved';
    elsif p_action = 'reviewing' then
      if v_report.status <> 'open' then raise exception 'report_state_conflict'; end if;
      v_next := 'reviewing';
    elsif p_action = 'resolve' then v_next := 'resolved';
    else v_next := 'dismissed';
    end if;
    update public.community_post_reports set status = v_next, version = version + 1,
      resolved_by = case when v_next in ('resolved', 'dismissed') then p_actor_user_id else null end,
      resolution_note = case when v_next in ('resolved', 'dismissed') then v_note else null end,
      updated_at = v_now where id = p_report_id;
  end if;

  insert into public.moderation_audit_log(actor_user_id, target_type, target_id, action, metadata, created_at)
    values (p_actor_user_id,
      case when p_action in ('hide', 'restore') then 'community_post' else 'community_post_report' end,
      case when p_action in ('hide', 'restore') then v_post_id else p_report_id end,
      case p_action when 'hide' then 'post_hidden' when 'restore' then 'post_restored'
        else 'report_status_changed' end,
      jsonb_build_object('report_id', p_report_id, 'post_id', v_post_id,
        'from_report_status', v_report.status,
        'to_report_status', coalesce(v_next, v_report.status),
        'from_report_version', v_report.version,
        'to_report_version', v_report.version + case when p_action = 'restore' then 0 else 1 end,
        'from_post_status', v_before_post,
        'to_post_status', case p_action when 'hide' then 'hidden' when 'restore' then 'published' else v_before_post end,
        'from_post_version', case when v_post_exists then v_post.version else null end,
        'to_post_version', case when v_post_exists then v_post.version + case when p_action in ('hide','restore') then 1 else 0 end else null end), v_now);
  return jsonb_build_object('id', p_report_id, 'status', coalesce(v_next, v_report.status),
    'version', v_report.version + case when p_action = 'restore' then 0 else 1 end,
    'updatedAt', case when p_action = 'restore' then v_report.updated_at else v_now end);
end;
$$;
revoke all on function public.community_moderation_action(uuid, uuid, text, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.community_moderation_action(uuid, uuid, text, integer, integer, text)
  to service_role;
comment on function public.community_moderation_action(uuid, uuid, text, integer, integer, text) is
  '9K-2: role FOR SHARE, post/report FOR UPDATE, explicit version expectations, atomic moderation and immutable audit. Recent MFA and actor JWT verification at the trusted HTTP boundary. Service-role only.';

-- Bounded audit reader, without granting direct audit-table access to any API role.
create function public.community_moderation_audit(p_actor_user_id uuid, p_report_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_role text; v_post_id uuid; v_result jsonb;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('admin','moderator','developer') then
    raise exception 'actor_not_moderator';
  end if;
  select post_id into v_post_id from public.community_post_reports where id = p_report_id;
  if not found then raise exception 'report_not_found'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_result from (
      select id, actor_user_id, action, metadata, created_at from public.moderation_audit_log
      where (target_type='community_post_report' and target_id=p_report_id)
         or (target_type='community_post' and target_id=v_post_id)
      order by created_at desc, id desc limit 20
    ) a;
  return v_result;
end;
$$;
revoke all on function public.community_moderation_audit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.community_moderation_audit(uuid, uuid) to service_role;
