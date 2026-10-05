-- 9K-R2: future submissions only; no historical rewrite or retroactive quarantine.
-- Canonical writer locks post -> case -> pending reports ordered by id.
-- The post lock serializes all submissions and the current moderation/delete RPCs.
-- Historical duplicate rows are preserved; no global reporter/post unique constraint.
drop trigger community_post_reports_attach_case on public.community_post_reports;
revoke all on function public.community_post_report_create(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
-- Ordinary server code must use the RPC, not bypass its serialization with INSERT.
revoke insert on public.community_post_reports from service_role;

create function public.community_post_report_submit(
  p_reporter_user_id uuid, p_post_id uuid, p_reason text, p_detail text default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_post public.community_posts%rowtype;
  v_case public.community_moderation_cases%rowtype;
  v_cycle uuid;
  v_report public.community_post_reports%rowtype;
  v_count integer;
  v_duplicate boolean := false;
  v_changed boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_reporter_user_id is null or not exists
    (select 1 from auth.users where id = p_reporter_user_id) then
    raise exception 'unauthenticated';
  end if;
  if p_reason is null or p_reason not in
    ('spam', 'harassment', 'hate_speech', 'sexual_content', 'other') then
    raise exception 'invalid_reason';
  end if;
  if char_length(p_detail) > 1000 then raise exception 'detail_too_long'; end if;
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
      values (p_reporter_user_id, p_post_id, p_reason, p_detail, 'open', v_case.id, v_cycle)
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

-- Existing domain logic unchanged; HPR guard after post/owner lock, before media writes.
create or replace function public.community_post_save(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_text text,
  p_media jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_is_create boolean := p_post_id is null;
  v_post_id uuid;
  v_current_version integer;
  v_author uuid;
  v_media_count integer;
  v_distinct_asset_count integer;
  v_distinct_position_count integer;
  v_existing_media_asset_ids uuid[];
  v_incoming_asset_ids uuid[];
  v_new_asset_ids uuid[];
  v_missing_existing integer;
  v_final_media_count integer;
  v_final_video_count integer;
  v_post_json jsonb;
  v_media_json jsonb;
begin
  if p_actor_user_id is null then
    raise exception 'invalid_argument';
  end if;
  if not exists (select 1 from public.profiles where user_id = p_actor_user_id) then
    raise exception 'no_profile';
  end if;
  if p_media is null or jsonb_typeof(p_media) <> 'array' then
    raise exception 'invalid_argument';
  end if;

  v_media_count := jsonb_array_length(p_media);
  if v_media_count > 10 then
    raise exception 'too_many_media';
  end if;

  select count(*), count(distinct (elem->>'asset_id')::uuid)
    into v_media_count, v_distinct_asset_count
    from jsonb_array_elements(p_media) as elem;
  if v_media_count <> v_distinct_asset_count then
    raise exception 'duplicate_asset_id';
  end if;

  if v_media_count > 0 then
    select count(distinct (elem->>'position')::int) into v_distinct_position_count
      from jsonb_array_elements(p_media) as elem;
    if v_distinct_position_count <> v_media_count then
      raise exception 'invalid_positions';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_media) as elem
      where (elem->>'position')::int < 0 or (elem->>'position')::int >= v_media_count
    ) then
      raise exception 'invalid_positions';
    end if;
  end if;

  if v_is_create then
    v_post_id := gen_random_uuid();
    v_current_version := 0;
    v_existing_media_asset_ids := array[]::uuid[];
  else
    select id, version, author_user_id into v_post_id, v_current_version, v_author
      from public.community_posts
      where id = p_post_id
      for update;
    if not found then
      raise exception 'post_not_found';
    end if;
    if v_author <> p_actor_user_id then
      raise exception 'not_owner';
    end if;
    if exists (select 1 from public.community_posts where id = p_post_id and status = 'hidden_pending_review') then
      raise exception 'post_not_editable';
    end if;
    if p_expected_version is null or v_current_version <> p_expected_version then
      raise exception 'version_conflict';
    end if;

    select coalesce(array_agg(asset_id), array[]::uuid[]) into v_existing_media_asset_ids
      from public.community_post_media where post_id = v_post_id;
  end if;

  -- Ninguna media YA adjunta puede faltar en p_media: desadjuntar exige el flujo explícito.
  select count(*) into v_missing_existing
    from public.community_post_media cpm
    where cpm.post_id = v_post_id
      and not exists (
        select 1 from jsonb_array_elements(p_media) as elem
        where (elem->>'asset_id')::uuid = cpm.asset_id
      );
  if v_missing_existing > 0 then
    raise exception 'media_missing_existing';
  end if;

  select coalesce(array_agg((elem->>'asset_id')::uuid), array[]::uuid[]) into v_incoming_asset_ids
    from jsonb_array_elements(p_media) as elem;

  select coalesce(array_agg(a.id), array[]::uuid[]) into v_new_asset_ids
    from unnest(v_incoming_asset_ids) as a(id)
    where not (a.id = any(v_existing_media_asset_ids));

  if array_length(v_new_asset_ids, 1) > 0 then
    -- Bloquea los assets nuevos ANTES de comprobar su elegibilidad: dos guardados concurrentes
    -- intentando adjuntar el mismo asset recién-listo nunca pueden ganar ambos.
    perform 1 from public.media_assets where id = any(v_new_asset_ids) for update;

    if (select count(*) from public.media_assets where id = any(v_new_asset_ids))
        <> array_length(v_new_asset_ids, 1) then
      raise exception 'invalid_asset';
    end if;
    if exists (
      select 1 from public.media_assets where id = any(v_new_asset_ids) and domain <> 'community'
    ) then
      raise exception 'foreign_asset';
    end if;
    if exists (
      select 1 from public.media_assets where id = any(v_new_asset_ids) and status <> 'ready'
    ) then
      raise exception 'asset_not_ready';
    end if;
    if exists (
      select 1 from public.media_assets
      where id = any(v_new_asset_ids) and created_by is distinct from p_actor_user_id
    ) then
      raise exception 'foreign_asset';
    end if;
    if exists (
      select 1 from public.community_post_media where asset_id = any(v_new_asset_ids)
    ) then
      raise exception 'asset_already_attached';
    end if;
  end if;

  -- Invariante "texto o media" (sección producto congelada): evaluado con el estado FINAL de la
  -- galería (existente conservada + nueva) dentro de la MISMA transacción.
  v_final_media_count := coalesce(array_length(v_incoming_asset_ids, 1), 0);
  if (p_text is null or length(trim(p_text)) = 0) and v_final_media_count = 0 then
    raise exception 'empty_post';
  end if;

  -- Invariante nuevo (9J-3): como máximo 1 vídeo en el conjunto FINAL de media (existente
  -- conservada + nueva) — evaluado sobre TODOS los assets del post, no solo los nuevos, para que
  -- adjuntar un segundo vídeo en una edición posterior (con uno ya existente) también se rechace.
  if v_final_media_count > 0 then
    select count(*) into v_final_video_count
      from public.media_assets
      where id = any(v_incoming_asset_ids) and kind = 'video';
    if v_final_video_count > 1 then
      raise exception 'too_many_videos';
    end if;
  end if;

  if v_is_create then
    insert into public.community_posts (
      id, author_user_id, text, status, version, created_at, updated_at
    ) values (
      v_post_id, p_actor_user_id, p_text, 'published', 1, v_now, v_now
    );
  else
    update public.community_posts set
      text = p_text,
      version = v_current_version + 1,
      updated_at = v_now
    where id = v_post_id;
  end if;

  -- Actualiza posición de la media YA adjunta (el join con jsonb_array_elements no afecta filas
  -- para los asset_id todavía no adjuntos).
  update public.community_post_media cpm set
    position = (elem->>'position')::int
  from jsonb_array_elements(p_media) as elem
  where cpm.post_id = v_post_id
    and cpm.asset_id = (elem->>'asset_id')::uuid;

  set constraints public.community_post_media_position_unique deferred;

  insert into public.community_post_media (post_id, asset_id, position, created_at)
  select v_post_id, (elem->>'asset_id')::uuid, (elem->>'position')::int, v_now
  from jsonb_array_elements(p_media) as elem
  where (elem->>'asset_id')::uuid = any(v_new_asset_ids);

  select to_jsonb(cp) into v_post_json from public.community_posts cp where cp.id = v_post_id;
  select coalesce(jsonb_agg(to_jsonb(cpm) order by cpm.position), '[]'::jsonb) into v_media_json
    from public.community_post_media cpm where cpm.post_id = v_post_id;

  return jsonb_build_object('post', v_post_json, 'media', v_media_json);
end;
$$;

-- Existing domain logic unchanged; HPR guard after post/owner lock, before media writes.
create or replace function public.community_post_save_atomic(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_text text,
  p_media jsonb,
  p_removed_media_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_author uuid;
  v_version integer;
  v_removed_assets uuid[] := array[]::uuid[];
  v_cleanup_assets uuid[] := array[]::uuid[];
  v_result jsonb;
begin
  if p_actor_user_id is null or p_removed_media_ids is null
     or cardinality(p_removed_media_ids) > 10
     or exists (select 1 from unnest(p_removed_media_ids) as r(id) where r.id is null)
     or cardinality(p_removed_media_ids) <> (select count(distinct id) from unnest(p_removed_media_ids) as r(id))
     or p_media is null or jsonb_typeof(p_media) <> 'array' then
    raise exception 'invalid_argument';
  end if;
  if p_post_id is null then
    if cardinality(p_removed_media_ids) > 0 then
      raise exception 'invalid_argument';
    end if;
  else
    select author_user_id, version into v_author, v_version
      from public.community_posts where id = p_post_id for update;
    if not found then raise exception 'post_not_found'; end if;
    if v_author <> p_actor_user_id then raise exception 'not_owner'; end if;
    if exists (select 1 from public.community_posts where id = p_post_id and status = 'hidden_pending_review') then
      raise exception 'post_not_editable';
    end if;
    if p_expected_version is null or v_version <> p_expected_version then
      raise exception 'version_conflict';
    end if;

    perform 1 from public.community_post_media
      where post_id = p_post_id order by id for update;
    if (select count(*) from public.community_post_media
        where post_id = p_post_id and id = any(p_removed_media_ids))
        <> cardinality(p_removed_media_ids) then
      raise exception 'media_not_found';
    end if;
    if exists (
      select 1 from public.community_post_media m
      join jsonb_array_elements(p_media) as elem on m.asset_id = (elem->>'asset_id')::uuid
      where m.post_id = p_post_id and m.id = any(p_removed_media_ids)
    ) then
      raise exception 'invalid_argument';
    end if;
    select coalesce(array_agg(asset_id), array[]::uuid[]) into v_removed_assets
      from public.community_post_media where post_id = p_post_id and id = any(p_removed_media_ids);
  end if;

  -- Bloqueo de assets antes de cambiar asociaciones; orden estable para operaciones combinadas.
  perform 1 from public.media_assets a
    where a.id = any(v_removed_assets) or a.id in (
      select (elem->>'asset_id')::uuid from jsonb_array_elements(p_media) as elem
    ) order by a.id for update;

  -- Debe diferirse ANTES del UPDATE de posiciones del guardado delegado (intercambios).
  set constraints public.community_post_media_position_unique deferred;
  delete from public.community_post_media
    where post_id = p_post_id and id = any(p_removed_media_ids);

  -- La protección media_missing_existing sigue comprobando TODOS los adjuntos no retirados.
  -- Si falla este guardado o cualquier paso posterior, PostgreSQL revierte también el DELETE.
  v_result := public.community_post_save(
    p_actor_user_id, p_post_id, p_expected_version, p_text, p_media
  );

  -- UNIQUE(asset_id) impide referencias en varias publicaciones de Community. Se comprueban
  -- además ambas asociaciones conocidas antes de transicionar un asset subyacente compartido.
  with transitioned as (
    update public.media_assets a set status = 'deleting', updated_at = clock_timestamp()
      where a.id = any(v_removed_assets) and a.status = 'ready'
        and not exists (select 1 from public.community_post_media m where m.asset_id = a.id)
        and not exists (select 1 from public.cosplay_post_images i where i.asset_id = a.id)
      returning a.id
  ) select coalesce(array_agg(id), array[]::uuid[]) into v_cleanup_assets from transitioned;

  return v_result || jsonb_build_object('cleanup_asset_ids', to_jsonb(v_cleanup_assets));
end;
$$;

-- Existing domain logic unchanged; HPR guard after post/owner lock, before media writes.
create or replace function public.community_post_reorder_media(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_positions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_current_version integer;
  v_author uuid;
  v_existing_ids uuid[];
  v_incoming_ids uuid[];
  v_count integer;
  v_distinct_ids integer;
  v_distinct_positions integer;
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;
  if p_positions is null or jsonb_typeof(p_positions) <> 'array' then
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
    if exists (select 1 from public.community_posts where id = p_post_id and status = 'hidden_pending_review') then
      raise exception 'post_not_editable';
    end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select coalesce(array_agg(id), array[]::uuid[]) into v_existing_ids
    from public.community_post_media where post_id = p_post_id;

  select count(*), count(distinct (elem->>'media_id')::uuid),
         count(distinct (elem->>'position')::int)
    into v_count, v_distinct_ids, v_distinct_positions
    from jsonb_array_elements(p_positions) as elem;

  if v_count > 10 then
    raise exception 'too_many_media';
  end if;
  if v_count <> v_distinct_ids or v_count <> v_distinct_positions then
    raise exception 'invalid_positions';
  end if;
  if v_count <> coalesce(array_length(v_existing_ids, 1), 0) then
    raise exception 'media_missing_existing';
  end if;

  select coalesce(array_agg((elem->>'media_id')::uuid), array[]::uuid[]) into v_incoming_ids
    from jsonb_array_elements(p_positions) as elem;
  if exists (
    select 1 from unnest(v_existing_ids) as e(id) where not (e.id = any(v_incoming_ids))
  ) then
    raise exception 'media_missing_existing';
  end if;
  if v_count > 0 and exists (
    select 1 from jsonb_array_elements(p_positions) as elem
    where (elem->>'position')::int < 0 or (elem->>'position')::int >= v_count
  ) then
    raise exception 'invalid_positions';
  end if;

  set constraints public.community_post_media_position_unique deferred;

  update public.community_post_media cpm
    set position = (elem->>'position')::int
    from jsonb_array_elements(p_positions) as elem
    where cpm.post_id = p_post_id
      and cpm.id = (elem->>'media_id')::uuid;

  update public.community_posts
    set version = v_current_version + 1, updated_at = v_now
    where id = p_post_id;

  return jsonb_build_object('version', v_current_version + 1);
end;
$$;

-- Existing domain logic unchanged; HPR guard after post/owner lock, before media writes.
create or replace function public.community_post_detach_media(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_media_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_current_version integer;
  v_author uuid;
  v_text text;
  v_asset_id uuid;
  v_asset_status text;
  v_remaining_media integer;
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null
     or p_media_id is null then
    raise exception 'invalid_argument';
  end if;

  select version, author_user_id, text into v_current_version, v_author, v_text
    from public.community_posts where id = p_post_id for update;
  if not found then
    raise exception 'post_not_found';
  end if;
  if v_author <> p_actor_user_id then
    raise exception 'not_owner';
  end if;
    if exists (select 1 from public.community_posts where id = p_post_id and status = 'hidden_pending_review') then
      raise exception 'post_not_editable';
    end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select asset_id into v_asset_id
    from public.community_post_media
    where id = p_media_id and post_id = p_post_id;
  if not found then
    raise exception 'media_not_found';
  end if;

  select count(*) into v_remaining_media
    from public.community_post_media where post_id = p_post_id and id <> p_media_id;
  if v_remaining_media = 0 and (v_text is null or length(trim(v_text)) = 0) then
    raise exception 'empty_post';
  end if;

  delete from public.community_post_media where id = p_media_id;

  select status into v_asset_status from public.media_assets where id = v_asset_id for update;
  if found and v_asset_status = 'ready' then
    update public.media_assets set status = 'deleting', updated_at = v_now where id = v_asset_id;
  end if;

  update public.community_posts
    set version = v_current_version + 1, updated_at = v_now
    where id = p_post_id;

  return jsonb_build_object('asset_id', v_asset_id, 'version', v_current_version + 1);
end;
$$;
