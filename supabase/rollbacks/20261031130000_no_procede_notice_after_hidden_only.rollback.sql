-- Rollback de 20261031130000: restaura la definición ORIGINAL de 20261015120000 (aviso `reports_not_valid`
-- también cuando la publicación nunca fue ocultada). Solo para operador; no es una migración.
-- No borra ni modifica avisos ya creados.

create or replace function public.community_moderation_case_decide(
  p_actor_user_id uuid, p_case_id uuid, p_cycle_id uuid,
  p_expected_case_version integer, p_expected_post_version integer,
  p_decision text, p_resolution_message text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text;
  v_post_id uuid;
  v_post public.community_posts%rowtype;
  v_case public.community_moderation_cases%rowtype;
  v_cycle public.community_moderation_cycles%rowtype;
  v_exists boolean;
  v_before_status text;
  v_before_version integer;
  v_message text := nullif(btrim(p_resolution_message, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'');
  v_decision_id uuid := gen_random_uuid();
  v_now timestamptz;
  v_changed boolean := false;
begin
  if p_actor_user_id is null or p_case_id is null or p_cycle_id is null
    or p_expected_case_version is null or p_expected_case_version < 1
    or (p_expected_post_version is not null and p_expected_post_version < 1)
    or p_decision is null or p_decision not in ('reports_not_valid','content_actioned') then
    raise exception 'invalid_argument';
  end if;
  if p_decision = 'content_actioned' and (v_message is null or v_message ~ '^[[:space:]]*$') then
    raise exception 'resolution_message_required';
  end if;
  if char_length(v_message) > 1000
    or (p_decision = 'reports_not_valid' and v_message is not null) then
    raise exception 'invalid_argument';
  end if;
  -- Authority -> post -> case -> cycle -> pending reports by ID -> notice.
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('admin','moderator','developer') then raise exception 'actor_not_moderator'; end if;
  select post_id into v_post_id from public.community_moderation_cases where id = p_case_id;
  if not found then raise exception 'case_not_found'; end if;
  select * into v_post from public.community_posts where id = v_post_id for update;
  v_exists := found;
  select * into v_case from public.community_moderation_cases where id = p_case_id for update;
  if not found or v_case.post_id <> v_post_id then raise exception 'case_not_found'; end if;
  if v_case.version <> p_expected_case_version then raise exception 'case_version_conflict'; end if;
  if (v_exists and (p_expected_post_version is null or v_post.version <> p_expected_post_version))
    or (not v_exists and p_expected_post_version is not null) then raise exception 'post_version_conflict'; end if;
  select * into v_cycle from public.community_moderation_cycles where id = p_cycle_id for update;
  if not found or v_cycle.case_id <> p_case_id or v_cycle.post_id <> v_post_id
    or v_cycle.cycle_number <> v_case.current_cycle or v_cycle.status <> 'pending'
    or v_case.status <> 'pending' then raise exception 'cycle_state_conflict'; end if;
  if exists(select 1 from public.community_moderation_decisions where cycle_id = p_cycle_id) then
    raise exception 'decision_already_exists';
  end if;
  if not v_exists and p_decision = 'content_actioned' then raise exception 'post_not_found'; end if;
  if v_exists and (v_post.status not in ('published','hidden','hidden_pending_review')
    or (v_post.status = 'hidden_pending_review' and v_post.quarantine_cycle_id is distinct from p_cycle_id)) then
    raise exception 'post_state_conflict';
  end if;
  perform id from public.community_post_reports where case_id = p_case_id and cycle_id = p_cycle_id
    and status in ('open','reviewing') order by id for update;
  v_now := clock_timestamp(); -- captured after waits, never a caller-controlled deadline
  v_before_status := case when v_exists then v_post.status else null end;
  v_before_version := case when v_exists then v_post.version else null end;
  v_changed := v_exists and (p_decision = 'content_actioned' or v_post.status = 'hidden_pending_review');
  insert into public.community_moderation_decisions
    (id,case_id,post_id,cycle_id,actor_user_id,decision,expected_case_version,
      expected_post_version,resulting_post_status,resolution_message,created_at)
    values(v_decision_id,p_case_id,v_post_id,p_cycle_id,p_actor_user_id,p_decision,
      p_expected_case_version,p_expected_post_version,
      case when not v_exists then null when p_decision = 'content_actioned' then 'removed_pending_purge'
        when v_post.status = 'hidden_pending_review' then 'published' else v_post.status end,
      case when p_decision = 'content_actioned' then v_message else null end,v_now);
  update public.community_post_reports set
    status = case when p_decision = 'content_actioned' then 'actioned' else 'dismissed' end,
    version = version + 1, resolved_by = p_actor_user_id, updated_at = v_now
    where case_id = p_case_id and cycle_id = p_cycle_id and status in ('open','reviewing');
  update public.community_moderation_cycles set status = 'closed', closure_kind = 'decision', closed_at = v_now
    where id = p_cycle_id;
  update public.community_moderation_cases set status = 'closed', closed_at = v_now,
    activity_at = v_now, version = version + 1 where id = p_case_id returning * into v_case;
  if v_exists and p_decision = 'content_actioned' then
    update public.community_posts set status = 'removed_pending_purge', quarantine_cycle_id = null,
      removal_decision_id = v_decision_id, removed_at = v_now, purge_after = v_now + interval '72 hours',
      version = version + 1, updated_at = v_now where id = v_post_id returning * into v_post;
  elsif v_exists and v_post.status = 'hidden_pending_review' then
    update public.community_posts set status = 'published', quarantine_cycle_id = null,
      version = version + 1, updated_at = v_now where id = v_post_id returning * into v_post;
  end if;
  if v_exists and p_decision = 'reports_not_valid' and v_post.status = 'published' then
    insert into public.community_moderation_author_notices(decision_id,owner_user_id,post_id,notice_type,created_at)
      values(v_decision_id,v_post.author_user_id,v_post_id,'reports_not_valid',v_now);
  end if;
  insert into public.moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action,metadata,created_at)
    values('human',p_actor_user_id,'community_moderation_case',p_case_id,
      case when p_decision = 'content_actioned' then 'content_actioned' else 'case_rejected' end,
      jsonb_build_object('post_id',v_post_id,'cycle_id',p_cycle_id,'decision_id',v_decision_id,
        'content_available',v_exists,'from_case_version',p_expected_case_version,'to_case_version',v_case.version,
        'from_post_status',v_before_status,'to_post_status',case when v_exists then v_post.status else null end,
        'from_post_version',v_before_version,'to_post_version',case when v_exists then v_post.version else null end),v_now);
  return jsonb_build_object('decisionId',v_decision_id,'caseId',p_case_id,'cycleId',p_cycle_id,
    'postId',v_post_id,'decision',p_decision,'caseVersion',v_case.version,
    'postStatus',case when v_exists then v_post.status else null end,
    'postVersion',case when v_exists then v_post.version else null end,
    'visibilityChanged',v_changed,'createdAt',v_now);
end;
$$;
alter function public.community_moderation_case_decide(uuid,uuid,uuid,integer,integer,text,text) owner to postgres;
revoke all on function public.community_moderation_case_decide(uuid,uuid,uuid,integer,integer,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.community_moderation_case_decide(uuid,uuid,uuid,integer,integer,text,text) to service_role;
