-- PHASE-3: cola de revisión de contenido (retenidas y ediciones pendientes). Forward-only; LOCAL, NO aplicada en ningún entorno.
--
-- Depende de 20261120120000 (held_for_review y ediciones pendientes). NO redefine ninguna función de Fase 2: añade dos
-- funciones solo para service_role que el handler del panel de moderación llama tras requireCapability("moderation"):
--   * community_content_review_read   lectura paginada (keyset) y por id, con contadores. Comprueba admin_roles en la BD.
--   * community_content_review_decide decide (aprobar/rechazar) llamando a las RPC de Fase 2 Y escribe la auditoría en la
--     MISMA transacción: o se registra la decisión con su auditoría o no cambia nada. Solo se audita lo que ocurre.
-- Auditoría: se amplía la lista cerrada de acciones de moderation_audit_log con cuatro valores humanos. target_type
-- 'community_post' (ya permitido); target_id = id de la publicación; metadata MÍNIMA (sin textos, URLs ni claves).

alter table public.moderation_audit_log drop constraint moderation_audit_log_action_check;
alter table public.moderation_audit_log add constraint moderation_audit_log_action_check
  check (action in (
    'report_status_changed', 'post_hidden', 'post_restored', 'post_quarantined', 'case_rejected',
    'content_actioned', 'strike_applied', 'strike_revoked', 'post_purged',
    'copyright_claim_review_started', 'copyright_claim_info_requested', 'copyright_claim_review_resumed',
    'copyright_claim_note_added', 'copyright_claim_dismissed', 'copyright_claim_withdrawn',
    'copyright_post_removed', 'copyright_notification_sent', 'copyright_notification_failed',
    'copyright_notice_token_reissued', 'copyright_appeal_submitted', 'copyright_appeal_accepted',
    'copyright_appeal_rejected', 'copyright_post_restored', 'copyright_post_purged',
    'content_hold_released', 'content_hold_rejected', 'content_edit_approved', 'content_edit_rejected'));

create function public.community_content_review_read(
  p_actor_user_id uuid,
  p_scope text,
  p_before_created timestamptz,
  p_before_id uuid,
  p_limit integer,
  p_item_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_rows jsonb;
  v_items jsonb;
  v_next jsonb := null;
  v_last jsonb;
begin
  if p_actor_user_id is null or p_scope is null or p_scope not in ('held', 'edits')
     or p_limit is null or p_limit < 1 or p_limit > 20
     or ((p_before_created is null) <> (p_before_id is null))
     or (p_item_id is not null and p_before_created is not null) then
    raise exception 'invalid_argument';
  end if;
  select role into v_role from public.admin_roles where user_id = p_actor_user_id;
  if v_role is null or v_role not in ('admin', 'moderator', 'developer') then
    raise exception 'actor_not_moderator';
  end if;

  if p_scope = 'held' then
    select coalesce(jsonb_agg(row_json order by created_at desc, id desc), '[]'::jsonb) into v_rows from (
      select p.created_at, p.id, jsonb_build_object(
        'kind', 'held_post', 'id', p.id, 'postId', p.id, 'version', p.version,
        'createdAt', p.created_at, 'text', p.text,
        'author', jsonb_build_object('username', f.username, 'displayName', f.display_name),
        'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'assetId', m.asset_id,
                                                               'position', m.position, 'isNew', false)
                                            order by m.position, m.id)
                           from public.community_post_media m where m.post_id = p.id), '[]'::jsonb)) as row_json
      from public.community_posts p
      left join public.profiles f on f.user_id = p.author_user_id
      where p.status = 'held_for_review'
        and (p_item_id is null or p.id = p_item_id)
        and (p_before_created is null or (p.created_at, p.id) < (p_before_created, p_before_id))
      order by p.created_at desc, p.id desc
      limit p_limit + 1) q;
  else
    select coalesce(jsonb_agg(row_json order by created_at desc, id desc), '[]'::jsonb) into v_rows from (
      select e.created_at, e.id, jsonb_build_object(
        'kind', 'pending_edit', 'id', e.id, 'editId', e.id, 'postId', e.post_id,
        'version', p.version, 'baseVersion', e.base_version, 'stale', (p.version <> e.base_version),
        'postStatus', p.status, 'requestedAt', e.created_at,
        'author', jsonb_build_object('username', f.username, 'displayName', f.display_name),
        'published', jsonb_build_object(
          'text', p.text,
          'media', coalesce((select jsonb_agg(jsonb_build_object('assetId', m.asset_id, 'position', m.position, 'isNew', false)
                                              order by m.position, m.id)
                             from public.community_post_media m where m.post_id = p.id), '[]'::jsonb)),
        'proposed', jsonb_build_object(
          'text', e.text,
          'media', coalesce((select jsonb_agg(jsonb_build_object('assetId', pm.asset_id, 'position', pm.position, 'isNew', pm.is_new)
                                              order by pm.position)
                             from public.community_post_pending_edit_media pm where pm.edit_id = e.id), '[]'::jsonb))
        ) as row_json
      from public.community_post_pending_edits e
      join public.community_posts p on p.id = e.post_id
      left join public.profiles f on f.user_id = e.author_user_id
      where e.status = 'pending'
        and (p_item_id is null or e.id = p_item_id)
        and (p_before_created is null or (e.created_at, e.id) < (p_before_created, p_before_id))
      order by e.created_at desc, e.id desc
      limit p_limit + 1) q;
  end if;

  if jsonb_array_length(v_rows) > p_limit then
    select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb) into v_items
      from jsonb_array_elements(v_rows) with ordinality as t(e, n) where t.n <= p_limit;
    v_last := v_items -> (p_limit - 1);
    v_next := jsonb_build_object(
      'createdAt', case p_scope when 'held' then v_last ->> 'createdAt' else v_last ->> 'requestedAt' end,
      'id', v_last ->> 'id');
  else
    v_items := v_rows;
  end if;

  return jsonb_build_object(
    'items', v_items,
    'next', v_next,
    'counts', jsonb_build_object(
      'held', (select count(*) from public.community_posts where status = 'held_for_review'),
      'edits', (select count(*) from public.community_post_pending_edits where status = 'pending')));
end;
$$;

create function public.community_content_review_decide(
  p_actor_user_id uuid,
  p_kind text,
  p_target_id uuid,
  p_expected_version integer,
  p_decision text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_post_id uuid;
  v_result jsonb;
  v_action text;
  v_meta jsonb;
begin
  if p_actor_user_id is null or p_target_id is null
     or p_kind is null or p_kind not in ('held_post', 'pending_edit')
     or p_decision is null or p_decision not in ('approve', 'reject')
     or (p_decision = 'approve' and p_expected_version is null)
     or (p_kind = 'held_post' and p_expected_version is null) then
    raise exception 'invalid_argument';
  end if;

  if p_kind = 'held_post' then
    v_post_id := p_target_id;
    if p_decision = 'approve' then
      v_result := public.community_post_hold_release(p_actor_user_id, p_target_id, p_expected_version);
      v_action := 'content_hold_released';
      v_meta := jsonb_build_object('kind', 'held_post', 'decision', 'approve',
                                   'from_version', p_expected_version, 'to_version', p_expected_version + 1);
    else
      v_result := public.community_post_hold_reject(p_actor_user_id, p_target_id, p_expected_version);
      v_action := 'content_hold_rejected';
      v_meta := jsonb_build_object('kind', 'held_post', 'decision', 'reject', 'from_version', p_expected_version);
    end if;
  else
    select post_id into v_post_id from public.community_post_pending_edits where id = p_target_id;
    if not found then raise exception 'pending_edit_not_found'; end if;
    if p_decision = 'approve' then
      v_result := public.community_post_pending_edit_approve(p_actor_user_id, p_target_id, p_expected_version);
      v_action := 'content_edit_approved';
      v_meta := jsonb_build_object('kind', 'pending_edit', 'decision', 'approve', 'edit_id', p_target_id,
                                   'from_version', p_expected_version, 'to_version', p_expected_version + 1);
    else
      v_result := public.community_post_pending_edit_reject(p_actor_user_id, p_target_id);
      v_action := 'content_edit_rejected';
      v_meta := jsonb_build_object('kind', 'pending_edit', 'decision', 'reject', 'edit_id', p_target_id);
    end if;
  end if;

  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata)
    values ('human', p_actor_user_id, 'community_post', v_post_id, v_action, v_meta);

  return jsonb_build_object('decision', p_decision, 'kind', p_kind, 'postId', v_post_id,
                            'result', v_result);
end;
$$;

alter function public.community_content_review_read(uuid,text,timestamptz,uuid,integer,uuid) owner to postgres;
revoke all on function public.community_content_review_read(uuid,text,timestamptz,uuid,integer,uuid) from public, anon, authenticated;
grant execute on function public.community_content_review_read(uuid,text,timestamptz,uuid,integer,uuid) to service_role;
alter function public.community_content_review_decide(uuid,text,uuid,integer,text) owner to postgres;
revoke all on function public.community_content_review_decide(uuid,text,uuid,integer,text) from public, anon, authenticated;
grant execute on function public.community_content_review_decide(uuid,text,uuid,integer,text) to service_role;
