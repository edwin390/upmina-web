-- R4-A only: grouped decisions, retention metadata, notices, closed writers.
-- No backfill, author read/ack, restore, storage operation, expiry worker or strike.
alter table public.community_posts drop constraint community_posts_status_check;
alter table public.community_posts add constraint community_posts_status_check
  check (status in ('published','hidden_pending_review','hidden','removed_pending_purge'));
alter table public.community_moderation_decisions
  add column resolution_message text,
  add constraint community_moderation_decisions_post_id_id_unique unique(post_id,id);
alter table public.community_moderation_decisions
  drop constraint community_moderation_decisions_resulting_post_status_check;
alter table public.community_moderation_decisions
  add constraint community_moderation_decisions_resulting_post_status_check
    check (resulting_post_status in ('published','hidden_pending_review','hidden','removed_pending_purge')),
  add constraint community_moderation_decisions_resolution_check check (
    (decision = 'content_actioned' and resolution_message is not null
      and char_length(resolution_message) between 1 and 1000
      and resolution_message = btrim(resolution_message, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      and resolution_message !~ '^[[:space:]]*$'
      and resulting_post_status is not null and resulting_post_status = 'removed_pending_purge'
      and expected_post_version is not null)
    or (decision = 'reports_not_valid' and resolution_message is null
      and (resulting_post_status is null or resulting_post_status in ('published','hidden'))));
alter table public.community_posts
  add column removal_decision_id uuid,
  add column removed_at timestamptz,
  add column purge_after timestamptz,
  add constraint community_posts_removal_decision_fk foreign key(id,removal_decision_id)
    references public.community_moderation_decisions(post_id,id),
  add constraint community_posts_removal_fields_check check (
    (status = 'removed_pending_purge' and removal_decision_id is not null
      and removed_at is not null and purge_after is not null
      and purge_after = removed_at + interval '72 hours')
    or (status <> 'removed_pending_purge' and removal_decision_id is null
      and removed_at is null and purge_after is null));

create function public.community_removal_context_check()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from public.community_posts p
    join public.community_moderation_decisions d on d.id = p.removal_decision_id
    where p.id = new.id and (d.decision <> 'content_actioned'
      or d.resulting_post_status <> 'removed_pending_purge' or d.created_at <> p.removed_at)) then
    raise exception 'removal_context_inconsistent';
  end if;
  return null;
end;
$$;
alter function public.community_removal_context_check() owner to postgres;
revoke all on function public.community_removal_context_check() from public,anon,authenticated,service_role;
create constraint trigger community_posts_removal_context after insert or update on public.community_posts
  deferrable initially deferred for each row execute function public.community_removal_context_check();

alter table public.community_post_reports drop constraint community_post_reports_status_check,
  drop constraint community_post_reports_resolution_consistency;
alter table public.community_post_reports add constraint community_post_reports_status_check
  check(status in ('open','reviewing','resolved','dismissed','actioned')),
  add constraint community_post_reports_resolution_consistency check (
    (status in ('resolved','dismissed','actioned') and resolved_by is not null)
    or (status in ('open','reviewing') and resolved_by is null));

create table public.community_moderation_author_notices (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null unique references public.community_moderation_decisions(id),
  owner_user_id uuid not null,
  post_id uuid not null,
  notice_type text not null check(notice_type = 'reports_not_valid'),
  created_at timestamptz not null,
  seen_at timestamptz,
  foreign key(post_id,decision_id) references public.community_moderation_decisions(post_id,id),
  check(seen_at is null or seen_at >= created_at)
);
alter table public.community_moderation_author_notices owner to postgres;
alter table public.community_moderation_author_notices enable row level security;
alter table public.community_moderation_author_notices force row level security;
revoke all on public.community_moderation_author_notices from public,anon,authenticated,service_role;
grant select on public.community_moderation_author_notices to service_role;
-- Notice payload and historical owner must correspond to an actual published no-action decision.
create function public.community_moderation_notice_context_check()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.community_moderation_decisions d
    join public.community_moderation_cases c on c.id = d.case_id
    where d.id = new.decision_id and d.post_id = new.post_id
      and d.decision = 'reports_not_valid' and d.resulting_post_status = 'published'
      and c.target_author_user_id = new.owner_user_id and d.created_at = new.created_at) then
    raise exception 'notice_context_inconsistent';
  end if;
  return new;
end;
$$;
alter function public.community_moderation_notice_context_check() owner to postgres;
revoke all on function public.community_moderation_notice_context_check() from public,anon,authenticated,service_role;
create trigger community_moderation_notice_context before insert on public.community_moderation_author_notices
  for each row execute function public.community_moderation_notice_context_check();
create index community_moderation_author_notices_unseen_idx
  on public.community_moderation_author_notices(owner_user_id,post_id) where seen_at is null;
create index community_posts_purge_after_idx on public.community_posts(purge_after,id)
  where status = 'removed_pending_purge';

create function public.community_moderation_case_decide(
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

-- Old definitions remain historical; no API role can execute individual mutations.
revoke all on function public.community_moderation_action(uuid,uuid,text,integer,integer,text)
  from public,anon,authenticated,service_role;
revoke all on function public.community_post_report_set_status(uuid,uuid,text,text)
  from public,anon,authenticated,service_role;
revoke insert,update,delete on public.community_post_reports from public,anon,authenticated,service_role;


-- Existing 9J body; extend only the locked edit guard.
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
    if exists (select 1 from public.community_posts where id = p_post_id and status in ('hidden_pending_review','hidden','removed_pending_purge')) then
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


-- Existing 9J body; extend only the locked edit guard.
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
    if exists (select 1 from public.community_posts where id = p_post_id and status in ('hidden_pending_review','hidden','removed_pending_purge')) then
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


-- Existing 9J body; extend only the locked edit guard.
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
    if exists (select 1 from public.community_posts where id = p_post_id and status in ('hidden_pending_review','hidden','removed_pending_purge')) then
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


-- Existing 9J body; extend only the locked edit guard.
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
    if exists (select 1 from public.community_posts where id = p_post_id and status in ('hidden_pending_review','hidden','removed_pending_purge')) then
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


-- R3 additive allowlist: grouping/cursor/caps and opaque media references unchanged.
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
      'text', case when p_detail then p.text else left(p.text, 280) end,
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
    'media', case when p_detail and p.id is not null then coalesce((select jsonb_agg(to_jsonb(m) order by m.position)
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


-- Reaffirm the existing controlled Community entrypoints without opening new writers.
alter function public.community_post_save(uuid,uuid,integer,text,jsonb) owner to postgres;
revoke all on function public.community_post_save(uuid,uuid,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.community_post_save(uuid,uuid,integer,text,jsonb) to service_role;
alter function public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[]) owner to postgres;
revoke all on function public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[]) from public,anon,authenticated;
grant execute on function public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[]) to service_role;
alter function public.community_post_reorder_media(uuid,uuid,integer,jsonb) owner to postgres;
revoke all on function public.community_post_reorder_media(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.community_post_reorder_media(uuid,uuid,integer,jsonb) to service_role;
alter function public.community_post_detach_media(uuid,uuid,integer,uuid) owner to postgres;
revoke all on function public.community_post_detach_media(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.community_post_detach_media(uuid,uuid,integer,uuid) to service_role;
revoke insert(id,reporter_user_id,post_id,reason,detail,status,resolved_by,resolution_note,created_at,updated_at,version,case_id,cycle_id),update(id,reporter_user_id,post_id,reason,detail,status,resolved_by,resolution_note,created_at,updated_at,version,case_id,cycle_id) on public.community_post_reports from public,anon,authenticated,service_role;
