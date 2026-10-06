-- R4-E1: database foundation for the Community physical purge lifecycle. Forward-only.
-- Scope: DB only. No R2 deletion, no endpoint, no scheduler (E2/E3). Nothing here deletes bytes.
--
-- Model (decided in R4-E0):
--   * purge_after is the irreversible LOGICAL boundary: at/after it the post is inaccessible
--     everywhere (restore ends, moderator text/media refs hidden), independent of physical GC.
--   * community_purge_due_posts() turns an expired removed post into "post row deleted + its
--     exclusive assets marked deleting + post_purged audit" in ONE transaction. Moderation history
--     (case/cycle/decision/reports/audit/notices) has no FK to community_posts and survives.
--   * media_assets rows in status='deleting' ARE the GC queue (same state owner-delete and Cosplay
--     already produce). The columns below add lease/attempt state; no jobs table.
--   * The GC claim never accepts keys from the caller; object keys are derived server-side from the
--     claimed asset and shape-validated (community_asset_gc_objects).

-- ---------------------------------------------------------------------------------------------
-- 1. GC state on media_assets (operationally meaningful only while status = 'deleting')
-- ---------------------------------------------------------------------------------------------
alter table public.media_assets
  add column purge_claim_token uuid,
  add column purge_lease_until timestamptz,
  add column purge_attempts integer not null default 0,
  add column purge_next_attempt_at timestamptz,
  add column purge_last_error_class text;

alter table public.media_assets
  add constraint media_assets_purge_attempts_check check (purge_attempts >= 0),
  add constraint media_assets_purge_lease_pair check
    ((purge_claim_token is null) = (purge_lease_until is null)),
  add constraint media_assets_purge_error_class_format check
    (purge_last_error_class is null or purge_last_error_class ~ '^[a-z0-9_]{1,40}$'),
  add constraint media_assets_purge_state_only_when_deleting check
    (status = 'deleting'
      or (purge_claim_token is null and purge_lease_until is null
        and purge_next_attempt_at is null and purge_last_error_class is null
        and purge_attempts = 0));

create index media_assets_gc_queue_idx
  on public.media_assets (purge_next_attempt_at nulls first, updated_at, id)
  where status = 'deleting';

-- ---------------------------------------------------------------------------------------------
-- 2. Audit: allow the system actor to record post_purged (minimal operational metadata only)
-- ---------------------------------------------------------------------------------------------
alter table public.moderation_audit_log
  drop constraint moderation_audit_log_action_check,
  drop constraint moderation_audit_log_system_action_check;
alter table public.moderation_audit_log
  add constraint moderation_audit_log_action_check check (action in (
    'report_status_changed','post_hidden','post_restored','post_quarantined','case_rejected',
    'content_actioned','strike_applied','strike_revoked','post_purged')),
  add constraint moderation_audit_log_system_action_check check (
    (actor_kind = 'system' and target_type = 'community_post'
      and action in ('post_quarantined','post_purged'))
    or (actor_kind = 'human' and action not in ('post_quarantined','post_purged')));

-- ---------------------------------------------------------------------------------------------
-- 3. The single definition of the logical boundary: due when purge_after <= now.
--    Pure predicate; it can never purge anything by itself. Callers pass the DB clock.
-- ---------------------------------------------------------------------------------------------
create function public.community_purge_due(p_purge_after timestamptz, p_now timestamptz)
returns boolean language sql immutable
set search_path = pg_catalog, public as $$
  select p_purge_after is not null and p_now is not null and p_purge_after <= p_now;
$$;
alter function public.community_purge_due(timestamptz, timestamptz) owner to postgres;
revoke all on function public.community_purge_due(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.community_purge_due(timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Purge transaction. The time authority is the database clock; there is no "now" parameter.
-- ---------------------------------------------------------------------------------------------
create function public.community_purge_due_posts(p_limit integer default 50)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_cand record;
  v_post public.community_posts%rowtype;
  v_asset_ids uuid[];
  v_marked uuid[];
  v_purged integer := 0;
  v_marked_total integer := 0;
  v_retained_total integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then raise exception 'invalid_argument'; end if;
  for v_cand in
    select id from public.community_posts
    where status = 'removed_pending_purge' and purge_after <= v_now
    order by purge_after, id
    limit p_limit
    for update skip locked
  loop
    -- Revalidate under the row lock: state, decision link and boundary.
    select * into v_post from public.community_posts where id = v_cand.id for update;
    if not found
      or v_post.status <> 'removed_pending_purge'
      or v_post.removal_decision_id is null
      or not public.community_purge_due(v_post.purge_after, v_now) then
      continue;
    end if;

    select coalesce(array_agg(pm.asset_id order by pm.position, pm.id), array[]::uuid[])
      into v_asset_ids from public.community_post_media pm where pm.post_id = v_post.id;

    -- Only assets used exclusively by THIS community post become deleting. community_post_media
    -- is unique per asset; the cosplay/domain guards protect against any foreign reuse.
    with marked as (
      update public.media_assets a
         set status = 'deleting', updated_at = v_now
       where a.id = any(v_asset_ids)
         and a.status = 'ready'
         and a.domain = 'community'
         and not exists (select 1 from public.cosplay_post_images ci where ci.asset_id = a.id)
         and not exists (select 1 from public.community_post_media o
                          where o.asset_id = a.id and o.post_id <> v_post.id)
      returning a.id)
    select coalesce(array_agg(id), array[]::uuid[]) into v_marked from marked;

    delete from public.community_posts where id = v_post.id; -- cascades post_media and likes

    insert into public.moderation_audit_log
      (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
      values ('system', null, 'community_post', v_post.id, 'post_purged',
        jsonb_build_object('post_id', v_post.id, 'removal_decision_id', v_post.removal_decision_id,
          'assets_marked', cardinality(v_marked),
          'assets_retained', cardinality(v_asset_ids) - cardinality(v_marked),
          'purged_at', v_now), v_now);

    v_purged := v_purged + 1;
    v_marked_total := v_marked_total + cardinality(v_marked);
    v_retained_total := v_retained_total + (cardinality(v_asset_ids) - cardinality(v_marked));
  end loop;
  return jsonb_build_object('purged', v_purged, 'assetsMarked', v_marked_total,
    'assetsRetained', v_retained_total, 'serverNow', v_now);
end;
$$;
alter function public.community_purge_due_posts(integer) owner to postgres;
revoke all on function public.community_purge_due_posts(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.community_purge_due_posts(integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. GC queue: claim / objects / finalize / fail / backlog
-- ---------------------------------------------------------------------------------------------
create function public.community_asset_gc_claim(
  p_limit integer default 20, p_lease_seconds integer default 300
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_rows jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100
    or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid_argument';
  end if;
  with picked as (
    select id from public.media_assets
    where status = 'deleting'
      and (purge_next_attempt_at is null or purge_next_attempt_at <= v_now)
      and (purge_lease_until is null or purge_lease_until <= v_now)
    order by purge_next_attempt_at nulls first, updated_at, id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.media_assets a
       set purge_claim_token = gen_random_uuid(),
           purge_lease_until = v_now + make_interval(secs => p_lease_seconds)
      from picked
     where a.id = picked.id
    returning a.id, a.domain, a.kind, a.purge_claim_token, a.purge_lease_until, a.purge_attempts)
  select coalesce(jsonb_agg(jsonb_build_object('assetId', id, 'domain', domain, 'kind', kind,
    'claimToken', purge_claim_token, 'leaseUntil', purge_lease_until, 'attempts', purge_attempts)
    order by id), '[]'::jsonb) into v_rows from claimed;
  return jsonb_build_object('claimed', v_rows, 'serverNow', v_now);
end;
$$;
alter function public.community_asset_gc_claim(integer, integer) owner to postgres;
revoke all on function public.community_asset_gc_claim(integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.community_asset_gc_claim(integer, integer) to service_role;

-- Object keys belonging to a CLAIMED asset, derived from its own rows and shape-validated against
-- the asset id and domain. Keys that do not match are never returned (only counted), so a caller
-- (E2) can only ever delete objects that provably belong to this asset. Requires a live lease.
create function public.community_asset_gc_objects(p_asset_id uuid, p_claim_token uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_a public.media_assets%rowtype;
  v_public_re text;
  v_private_re text;
  v_public text[];
  v_private text[];
  v_rejected integer;
begin
  if p_asset_id is null or p_claim_token is null then return jsonb_build_object('valid', false); end if;
  select * into v_a from public.media_assets
    where id = p_asset_id and status = 'deleting' and purge_claim_token = p_claim_token
      and purge_lease_until > clock_timestamp();
  if not found then return jsonb_build_object('valid', false); end if;
  v_public_re := case when v_a.domain = 'community'
    then '^community/' || v_a.id::text || '/(w(480|960|1600|2560)\.webp|original\.(mp4|mov|webm))$'
    else '^' || v_a.domain || '/' || v_a.id::text || '/w(480|960|1600|2560)\.webp$' end;
  v_private_re := '^(staging|objects)/' || v_a.domain || '/' || v_a.id::text
    || '/original\.(jpg|png|webp|heic|heif|avif|mp4|mov|webm)$';
  with pub as (
    select k from (select storage_key k from public.media_asset_variants where asset_id = v_a.id
      union select v_a.storage_key) s where k is not null),
  priv as (select v_a.private_original_key k where v_a.private_original_key is not null)
  select
    coalesce((select array_agg(k order by k) from pub where k ~ v_public_re), array[]::text[]),
    coalesce((select array_agg(k order by k) from priv where k ~ v_private_re), array[]::text[]),
    (select count(*) from pub where k !~ v_public_re) + (select count(*) from priv where k !~ v_private_re)
  into v_public, v_private, v_rejected;
  return jsonb_build_object('valid', true, 'assetId', v_a.id, 'domain', v_a.domain, 'kind', v_a.kind,
    'publicKeys', to_jsonb(v_public), 'privateKeys', to_jsonb(v_private), 'rejectedKeys', v_rejected);
end;
$$;
alter function public.community_asset_gc_objects(uuid, uuid) owner to postgres;
revoke all on function public.community_asset_gc_objects(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.community_asset_gc_objects(uuid, uuid) to service_role;

-- Finalization needs the matching token, not a live lease: R2 deletes are idempotent, and a token
-- that has been replaced by a later claim can never finalize.
create function public.community_asset_gc_finalize(p_asset_id uuid, p_claim_token uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  if p_asset_id is null or p_claim_token is null then raise exception 'invalid_argument'; end if;
  begin
    delete from public.media_assets
     where id = p_asset_id and status = 'deleting' and purge_claim_token = p_claim_token
    returning id into v_id;
  exception when foreign_key_violation then
    perform public.community_asset_gc_fail(p_asset_id, p_claim_token, 'asset_referenced');
    return jsonb_build_object('result', 'blocked');
  end;
  if v_id is not null then return jsonb_build_object('result', 'deleted'); end if;
  if exists (select 1 from public.media_assets where id = p_asset_id)
    then return jsonb_build_object('result', 'invalid_claim'); end if;
  return jsonb_build_object('result', 'already_gone');
end;
$$;
alter function public.community_asset_gc_finalize(uuid, uuid) owner to postgres;
revoke all on function public.community_asset_gc_finalize(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.community_asset_gc_finalize(uuid, uuid) to service_role;

-- Backoff: 60 s doubling per attempt, capped at 6 h. Never abandons: attempts >= 10 is only a signal.
create function public.community_asset_gc_fail(
  p_asset_id uuid, p_claim_token uuid, p_error_class text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_class text := case when p_error_class ~ '^[a-z0-9_]{1,40}$' then p_error_class else 'unclassified' end;
  v_attempts integer;
  v_next timestamptz;
begin
  if p_asset_id is null or p_claim_token is null then raise exception 'invalid_argument'; end if;
  update public.media_assets a
     set purge_attempts = a.purge_attempts + 1,
         purge_claim_token = null,
         purge_lease_until = null,
         purge_last_error_class = v_class,
         purge_next_attempt_at = v_now + make_interval(
           secs => least(21600, 60 * power(2, least(a.purge_attempts, 9)))::integer)
   where a.id = p_asset_id and a.status = 'deleting' and a.purge_claim_token = p_claim_token
  returning a.purge_attempts, a.purge_next_attempt_at into v_attempts, v_next;
  if found then
    return jsonb_build_object('result', 'retry_scheduled', 'attempts', v_attempts, 'nextAttemptAt', v_next);
  end if;
  if exists (select 1 from public.media_assets where id = p_asset_id)
    then return jsonb_build_object('result', 'invalid_claim'); end if;
  return jsonb_build_object('result', 'already_gone');
end;
$$;
alter function public.community_asset_gc_fail(uuid, uuid, text) owner to postgres;
revoke all on function public.community_asset_gc_fail(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.community_asset_gc_fail(uuid, uuid, text) to service_role;

create function public.media_gc_backlog() returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'deleting', count(*),
    'eligibleNow', count(*) filter (where e.eligible),
    'retrying', count(*) filter (where purge_attempts > 0),
    'attemptsAtLeast10', count(*) filter (where purge_attempts >= 10),
    'oldestDeletingAt', min(updated_at),
    'oldestEligibleAt', min(updated_at) filter (where e.eligible),
    'serverNow', clock_timestamp())
  from public.media_assets a
  cross join lateral (select (purge_next_attempt_at is null or purge_next_attempt_at <= clock_timestamp())
    and (purge_lease_until is null or purge_lease_until <= clock_timestamp()) as eligible) e
  where a.status = 'deleting';
$$;
alter function public.media_gc_backlog() owner to postgres;
revoke all on function public.media_gc_backlog() from public, anon, authenticated, service_role;
grant execute on function public.media_gc_backlog() to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Logical expiry for moderators: at/after purge_after an expired removed post exposes no text
--    and no media references (media delivery already denies them). Metadata/history stays.
--    post_purged audit rows are not listed until the case UI/parser knows the action (E4).
-- ---------------------------------------------------------------------------------------------
create or replace function public.community_moderation_cycle_read(p_cycle_id uuid, p_detail boolean)
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
      'text', case when (p.status = 'removed_pending_purge' and public.community_purge_due(p.purge_after, clock_timestamp())) then null when p_detail then p.text else left(p.text, 280) end,
      'status', p.status, 'version', p.version, 'updatedAt', p.updated_at,
      'authorUsername', pr.username, 'quarantineCycleId', p.quarantine_cycle_id, 'removalDecisionId', p.removal_decision_id,
      'removedAt', p.removed_at, 'purgeAfter', p.purge_after) end,
    'decision', (select jsonb_build_object('decisionId',d.id,'result',d.decision,
      'resolutionMessage',d.resolution_message,'createdAt',d.created_at)
      from public.community_moderation_decisions d where d.cycle_id = y.id),
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
    'media', case when p_detail and p.id is not null and not (p.status = 'removed_pending_purge' and public.community_purge_due(p.purge_after, clock_timestamp())) then coalesce((select jsonb_agg(to_jsonb(m) order by m.position)
      from (select pm.id, pm.position, a.id as "assetId"
        from public.community_post_media pm join public.media_assets a on a.id = pm.asset_id
        where pm.post_id = p.id order by pm.position limit 10) m), '[]'::jsonb) else '[]'::jsonb end,
    'audit', case when p_detail then coalesce((select jsonb_agg(to_jsonb(a) order by a."createdAt" desc, a.id desc)
      from (select a.id, a.action, a.actor_kind as "actorKind", a.created_at as "createdAt",
        jsonb_build_object('fromPostStatus', a.metadata->'from_post_status',
          'toPostStatus', a.metadata->'to_post_status',
          'fromReportStatus', coalesce(a.metadata->'from_report_status', a.metadata->'from_status'),
          'toReportStatus', coalesce(a.metadata->'to_report_status', a.metadata->'to_status')) as states
        from public.moderation_audit_log a where a.action <> 'post_purged' and
          ((a.target_type = 'community_post' and a.target_id = c.post_id)
          or (a.target_type = 'community_moderation_case' and a.target_id = c.id)
          or (a.target_type = 'community_post_report' and exists
            (select 1 from public.community_post_reports r where r.id = a.target_id and r.cycle_id = y.id)))
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
