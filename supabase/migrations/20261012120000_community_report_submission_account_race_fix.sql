-- 9K-R2-FIX: forward-only reporter-account lifetime correction.
-- Canonical submission order: reporter auth row (KEY SHARE) -> post (UPDATE)
-- -> case (UPDATE) -> pending reports (UPDATE, ordered by id).
-- Keep the reporter identity stable through commit; never lock historical reporters.
-- Later account deletion affects future counts, not completed quarantine decisions.
-- No backfill, report rewrites, visibility transitions, or privilege expansion.

create or replace function public.community_post_report_submit(
  p_reporter_user_id uuid, p_post_id uuid, p_reason text, p_detail text default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_post public.community_posts%rowtype;
  v_case public.community_moderation_cases%rowtype;
  v_cycle uuid;
  v_report public.community_post_reports%rowtype;
  v_count integer;
  v_detail text;
  v_duplicate boolean := false;
  v_changed boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  -- Stabilize ONLY the current reporter. DELETE/key changes must wait until commit.
  -- Eligibility comes before the post lock, matching account-delete/FK cascade order.
  perform 1 from auth.users where id = p_reporter_user_id for key share;
  if not found then
    raise exception 'unauthenticated';
  end if;
  if p_reason is null or p_reason not in
    ('spam', 'harassment', 'hate_speech', 'sexual_content', 'other') then
    raise exception 'invalid_reason';
  end if;
  if char_length(p_detail) > 1000 then raise exception 'detail_too_long'; end if;
  -- Restore the historical storage normalization without broadening R2 input limits.
  v_detail := nullif(btrim(p_detail), '');
  select * into v_post from public.community_posts where id = p_post_id for update;
  if not found then raise exception 'post_not_found'; end if;
  if v_post.author_user_id = p_reporter_user_id then raise exception 'self_report'; end if;
  if v_post.status not in ('published', 'hidden_pending_review') then
    raise exception 'post_not_reportable';
  end if;
  insert into public.community_moderation_cases
    (post_id, target_author_user_id, author_identity, status)
    values (p_post_id, v_post.author_user_id, 'known', 'pending')
    on conflict (post_id) do nothing;
  select * into v_case from public.community_moderation_cases
    where post_id = p_post_id for update;
  if v_case.status = 'closed' then
    if v_post.status <> 'published' then raise exception 'case_cycle_inconsistent'; end if;
    update public.community_moderation_cases set status = 'pending',
      current_cycle = current_cycle + 1, opened_at = v_now, closed_at = null
      where id = v_case.id returning * into v_case;
  end if;
  insert into public.community_moderation_cycles
    (case_id, post_id, cycle_number, status, opened_at)
    values (v_case.id, p_post_id, v_case.current_cycle, 'pending', v_now)
    on conflict (case_id, cycle_number) do nothing;
  select id into v_cycle from public.community_moderation_cycles
    where case_id = v_case.id and cycle_number = v_case.current_cycle and status = 'pending';
  if v_cycle is null or (v_post.status = 'hidden_pending_review'
    and v_post.quarantine_cycle_id is distinct from v_cycle) then
    raise exception 'case_cycle_inconsistent';
  end if;
  perform id from public.community_post_reports
    where case_id = v_case.id and cycle_id = v_cycle
      and status in ('open', 'reviewing') order by id for update;
  select * into v_report from public.community_post_reports
    where case_id = v_case.id and cycle_id = v_cycle and reporter_user_id = p_reporter_user_id
      and status in ('open', 'reviewing') order by created_at, id limit 1;
  v_duplicate := found;
  if not v_duplicate then
    insert into public.community_post_reports
      (reporter_user_id, post_id, reason, detail, status, case_id, cycle_id)
      values (p_reporter_user_id, p_post_id, p_reason, v_detail, 'open', v_case.id, v_cycle)
      returning * into v_report;
    update public.community_moderation_cases set version = version + 1, activity_at = v_now
      where id = v_case.id returning * into v_case;
  end if;
  select count(distinct r.reporter_user_id) into v_count from public.community_post_reports r
    join auth.users u on u.id = r.reporter_user_id
    where r.case_id = v_case.id and r.cycle_id = v_cycle and r.status in ('open', 'reviewing')
      and r.reporter_user_id <> v_post.author_user_id;
  if not v_duplicate and v_count >= 3 and v_post.status = 'published' then
    update public.community_posts set status = 'hidden_pending_review',
      quarantine_cycle_id = v_cycle, version = version + 1, updated_at = v_now
      where id = p_post_id;
    insert into public.moderation_audit_log
      (actor_kind, actor_user_id, target_type, target_id, action, metadata)
      values ('system', null, 'community_post', p_post_id, 'post_quarantined',
        jsonb_build_object('post_id', p_post_id, 'case_id', v_case.id, 'cycle_id', v_cycle,
          'case_version', v_case.version, 'from_post_status', v_post.status,
          'to_post_status', 'hidden_pending_review', 'from_post_version', v_post.version,
          'to_post_version', v_post.version + 1, 'threshold', 3, 'distinct_reporter_count', v_count));
    v_post.status := 'hidden_pending_review';
    v_post.version := v_post.version + 1;
    v_changed := true;
  end if;
  return jsonb_build_object('reportId', v_report.id, 'reportStatus', v_report.status,
    'caseId', v_case.id, 'cycleId', v_cycle, 'caseVersion', v_case.version,
    'distinctReporterCount', v_count, 'alreadyReported', v_duplicate,
    'visibilityChanged', v_changed, 'postStatus', v_post.status, 'postVersion', v_post.version);
end;
$$;
alter function public.community_post_report_submit(uuid, uuid, text, text) owner to postgres;
revoke all on function public.community_post_report_submit(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.community_post_report_submit(uuid, uuid, text, text) to service_role;


