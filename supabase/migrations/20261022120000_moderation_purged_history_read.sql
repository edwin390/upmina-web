-- 9K-R4-E4: purged moderation history becomes readable.
--
-- R4-E1 deliberately hid the system 'post_purged' audit row from community_moderation_cycle_read
-- until the case parser/UI knew the action. R4-E4 teaches both (parser allowlist + neutral label), so
-- the row is listed again. This is the ONLY change versus the 20261020120000 definition:
--   - "a.action <> 'post_purged'" is removed from the audit sub-select.
-- Everything else is identical: expired removed posts still expose no text and no media, a missing
-- post (physical purge) is still "post": null, and the audit projection still forwards ONLY
-- the post/report status transitions (never the row metadata: no post id, decision id or asset
-- counts reach the client).
--
-- Forward-only: 20261020120000 and 20261021120000 are untouched.

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
        from public.moderation_audit_log a where
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
