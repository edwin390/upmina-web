-- ROLLBACK de 20261110120000_copyright_removal_appeals.sql (NO es una migración: vive fuera de supabase/migrations para que
-- `db push` no lo aplique). Para usarlo, copiar a una migración NUEVA.
-- Se niega a ejecutarse si existe CUALQUIER retirada, apelación o fila de historial de la fase 2B: el historial es append-only y las
-- publicaciones ocultas por una retirada deberían restaurarse o eliminarse antes por el flujo normal. No toca community_posts,
-- media_assets, reportes ordinarios, casos, strikes ni la tabla de reclamaciones de la fase 2A (solo quita lo que 2B añadió).

do $$
begin
  if exists (select 1 from public.copyright_appeals)
     or exists (select 1 from public.copyright_claims
                 where removed_at is not null or status in ('removed', 'appeal_pending', 'restored', 'purged')
                    or appeal_token_hash is not null or notified_at is not null)
     or exists (select 1 from public.copyright_claim_events
                 where kind in ('removed', 'notified', 'notification_failed', 'token_reissued', 'appeal_submitted',
                                'appeal_accepted', 'appeal_rejected', 'restored', 'purged'))
     or exists (select 1 from public.moderation_audit_log
                 where action in ('copyright_post_removed', 'copyright_notification_sent', 'copyright_notification_failed',
                                  'copyright_notice_token_reissued', 'copyright_appeal_submitted', 'copyright_appeal_accepted',
                                  'copyright_appeal_rejected', 'copyright_post_restored', 'copyright_post_purged')) then
    raise exception 'rollback_blocked_removal_data_exists';
  end if;
end;
$$;

-- Funciones ordinarias de Community (definiciones originales, sin la comprobación de copyright).
create or replace function public.community_purge_due_posts(p_limit integer default 50)
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

create or replace function public.community_post_delete(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current_version integer;
  v_author uuid;
  v_asset_ids uuid[];
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;

  select version, author_user_id into v_current_version, v_author
    from public.community_posts where id = p_post_id for update;
  if not found then
    raise exception 'post_not_found';
  end if;
  if v_author <> p_actor_user_id then
    raise exception 'not_owner';
  end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select coalesce(array_agg(asset_id), array[]::uuid[]) into v_asset_ids
    from public.community_post_media where post_id = p_post_id;

  if array_length(v_asset_ids, 1) > 0 then
    update public.media_assets set status = 'deleting', updated_at = clock_timestamp()
      where id = any(v_asset_ids) and status = 'ready';
  end if;

  delete from public.community_posts where id = p_post_id;

  return jsonb_build_object('deleted_asset_ids', to_jsonb(v_asset_ids));
end;
$$;

drop trigger copyright_protect_post_removal on public.community_posts;
drop function public.copyright_protect_post_guard();
drop index public.copyright_claims_protected_post_idx;
drop function public.copyright_post_protected(uuid);

drop function public.copyright_claim_purge(uuid, uuid, integer, text, text);
drop function public.copyright_appeal_resolve(uuid, uuid, integer, text, text);
drop function public.copyright_appeal_submit(uuid, text, jsonb);
drop function public.copyright_appeal_context(uuid, text);
drop function public.copyright_claim_notice_record(uuid, uuid, text, boolean, text);
drop function public.copyright_claim_notice_context(uuid, uuid, text, text);
drop function public.copyright_claim_remove(uuid, uuid, integer, integer, text, text, text, integer);
drop function public.copyright_purge_blockers(public.copyright_claims, timestamptz);
drop table public.copyright_appeals;

-- Funciones de la fase 2A (definiciones originales).
create or replace function public.copyright_claims_read(
  p_actor_user_id uuid, p_scope text default 'open',
  p_before_created timestamptz default null, p_before_id uuid default null,
  p_claim_id uuid default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_items jsonb; v_count integer; v_next jsonb := null;
  c_page constant integer := 25;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is not null then
    select * into v_claim from public.copyright_claims where id = p_claim_id;
    if not found then raise exception 'claim_not_found'; end if;
    return jsonb_build_object('item', jsonb_build_object(
      'id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status, 'version', v_claim.version,
      'claimantName', v_claim.claimant_name, 'claimantEmail', v_claim.claimant_email,
      'organization', v_claim.claimant_organization, 'relationship', v_claim.relationship,
      'workDescription', v_claim.work_description, 'infringementDescription', v_claim.infringement_description,
      'evidenceUrls', to_jsonb(v_claim.evidence_urls), 'claimedPostUrl', v_claim.claimed_post_url,
      'postId', v_claim.post_id, 'postFound', v_claim.post_found,
      'postTextSnapshot', v_claim.post_text_snapshot, 'postMediaCount', v_claim.post_media_count,
      'currentPostStatus', (select p.status from public.community_posts p where p.id = v_claim.post_id),
      'statementVersion', v_claim.statement_version, 'signature', v_claim.signature,
      'createdAt', v_claim.created_at, 'updatedAt', v_claim.updated_at,
      'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'actorKind', e.actor_kind,
        'fromStatus', e.from_status, 'toStatus', e.to_status, 'note', e.note, 'createdAt', e.created_at)
        order by e.created_at, e.id) from public.copyright_claim_events e where e.claim_id = v_claim.id), '[]'::jsonb)));
  end if;
  if p_scope is null or p_scope not in ('open', 'closed') or (p_before_created is null) <> (p_before_id is null) then
    raise exception 'invalid_argument';
  end if;
  -- Una página de c_page + 1 filas (la última solo indica que hay más), con cursor por (created_at, id).
  if p_scope = 'open' then
    select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'reference', q.reference, 'status', q.status,
        'version', q.version, 'claimantName', q.claimant_name, 'relationship', q.relationship,
        'postFound', q.post_found, 'createdAt', q.created_at, 'updatedAt', q.updated_at) order by q.created_at, q.id)
        filter (where q.ord <= c_page), '[]'::jsonb),
      max(q.ord)
      into v_items, v_count
      from (select c.*, row_number() over (order by c.created_at, c.id) ord from (
              select * from public.copyright_claims
               where status in ('received', 'in_review', 'needs_info')
                 and (p_before_created is null or (created_at, id) > (p_before_created, p_before_id))
               order by created_at, id limit c_page + 1) c) q;
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'reference', q.reference, 'status', q.status,
        'version', q.version, 'claimantName', q.claimant_name, 'relationship', q.relationship,
        'postFound', q.post_found, 'createdAt', q.created_at, 'updatedAt', q.updated_at) order by q.created_at desc, q.id desc)
        filter (where q.ord <= c_page), '[]'::jsonb),
      max(q.ord)
      into v_items, v_count
      from (select c.*, row_number() over (order by c.created_at desc, c.id desc) ord from (
              select * from public.copyright_claims
               where status in ('dismissed', 'withdrawn')
                 and (p_before_created is null or (created_at, id) < (p_before_created, p_before_id))
               order by created_at desc, id desc limit c_page + 1) c) q;
  end if;
  if coalesce(v_count, 0) > c_page then
    v_next := jsonb_build_object('createdAt', v_items->(c_page - 1)->>'createdAt', 'id', v_items->(c_page - 1)->>'id');
  end if;
  return jsonb_build_object('items', v_items, 'next', v_next);
end;
$$;
alter function public.copyright_claims_read(uuid, text, timestamptz, uuid, uuid) owner to postgres;
revoke execute on function public.copyright_claims_read(uuid, text, timestamptz, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.copyright_claims_read(uuid, text, timestamptz, uuid, uuid) to service_role;

create or replace function public.copyright_claim_review(
  p_actor_user_id uuid, p_claim_id uuid, p_action text, p_expected_version integer, p_note text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_note text; v_from text; v_to text;
  v_kind text; v_audit text; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null or p_expected_version is null or p_expected_version < 1
     or p_action is null or p_action not in
       ('start_review', 'request_info', 'resume_review', 'dismiss', 'withdraw', 'add_note') then
    raise exception 'invalid_argument';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and not public.copyright_text_ok(v_note, 1, 1000) then raise exception 'invalid_argument'; end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  if v_claim.version <> p_expected_version then raise exception 'version_conflict'; end if;
  if v_claim.status in ('dismissed', 'withdrawn') then raise exception 'invalid_transition'; end if;
  if p_action in ('request_info', 'dismiss', 'withdraw', 'add_note') and v_note is null then raise exception 'note_required'; end if;

  if p_action = 'start_review' then
    if v_claim.status <> 'received' then raise exception 'invalid_transition'; end if;
    v_to := 'in_review'; v_kind := 'review_started'; v_audit := 'copyright_claim_review_started';
  elsif p_action = 'request_info' then
    if v_claim.status <> 'in_review' then raise exception 'invalid_transition'; end if;
    v_to := 'needs_info'; v_kind := 'info_requested'; v_audit := 'copyright_claim_info_requested';
  elsif p_action = 'resume_review' then
    if v_claim.status <> 'needs_info' then raise exception 'invalid_transition'; end if;
    v_to := 'in_review'; v_kind := 'review_resumed'; v_audit := 'copyright_claim_review_resumed';
  elsif p_action = 'dismiss' then
    v_to := 'dismissed'; v_kind := 'dismissed'; v_audit := 'copyright_claim_dismissed';
  elsif p_action = 'withdraw' then
    v_to := 'withdrawn'; v_kind := 'withdrawn'; v_audit := 'copyright_claim_withdrawn';
  else
    v_to := v_claim.status; v_kind := 'note'; v_audit := 'copyright_claim_note_added';
  end if;

  v_from := v_claim.status;
  update public.copyright_claims set status = v_to, version = version + 1, updated_at = v_now
    where id = v_claim.id returning * into v_claim;
  insert into public.copyright_claim_events
    (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, note, created_at)
    values (v_claim.id, v_kind, 'human', p_actor_user_id, v_from, v_to, v_note, v_now);
  -- Historial GENERAL de moderación: sin datos del reclamante ni texto de la nota (solo referencia y estados).
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_actor_user_id, 'copyright_claim', v_claim.id, v_audit,
      jsonb_build_object('reference', v_claim.reference, 'to_status', v_to, 'claim_version', v_claim.version), v_now);
  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status,
    'version', v_claim.version, 'updatedAt', v_claim.updated_at);
end;
$$;
alter function public.copyright_claim_review(uuid, uuid, text, integer, text) owner to postgres;
revoke execute on function public.copyright_claim_review(uuid, uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.copyright_claim_review(uuid, uuid, text, integer, text) to service_role;

drop index public.copyright_claims_appeal_token_idx;
alter table public.copyright_claims drop constraint copyright_claims_removal_check;
alter table public.copyright_claims
  drop column removal_reason, drop column removed_at, drop column removed_by, drop column removed_post_version,
  drop column removal_window_minutes, drop column appeal_token_hash, drop column notified_at, drop column notify_attempts,
  drop column notify_last_error, drop column appeal_deadline, drop column resolution_notice_pending,
  drop column resolution_notified_at, drop column restored_at, drop column purged_at, drop column purge_asset_ids;
alter table public.copyright_claims drop constraint copyright_claims_status_check;
alter table public.copyright_claims add constraint copyright_claims_status_check
  check (status in ('received', 'in_review', 'needs_info', 'dismissed', 'withdrawn'));

alter table public.copyright_claim_events drop constraint copyright_claim_events_kind_check;
alter table public.copyright_claim_events add constraint copyright_claim_events_kind_check check (kind in
  ('received', 'review_started', 'info_requested', 'review_resumed', 'note', 'dismissed', 'withdrawn'));

alter table public.moderation_audit_log drop constraint moderation_audit_log_action_check;
alter table public.moderation_audit_log add constraint moderation_audit_log_action_check check (action in (
  'report_status_changed', 'post_hidden', 'post_restored', 'post_quarantined', 'case_rejected',
  'content_actioned', 'strike_applied', 'strike_revoked', 'post_purged',
  'copyright_claim_review_started', 'copyright_claim_info_requested', 'copyright_claim_review_resumed',
  'copyright_claim_note_added', 'copyright_claim_dismissed', 'copyright_claim_withdrawn'));
