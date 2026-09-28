-- Fundación de backend del editor ADMIN de Cosplay (Fase 9I-3, checkpoint 2). Migración NUEVA:
-- no edita 20260930120000_cosplay_foundation.sql ni 20261001120000_cosplay_media_pipeline.sql.
--
-- Decisiones de producto congeladas para este checkpoint (ver el checkpoint completo):
--   - NO se añade media_assets.post_id: un asset READY puede existir temporalmente sin adjuntar.
--   - Borrado de publicaciones: DURO (cosplay_post_images cascada, igual que 9I-1).
--   - Límite de fotos por publicación: 20 (draft 0-20, publicar exige 1-20).
--   - Adjuntar un asset exige: domain='cosplay' + status='ready' + created_by=ADMIN actor +
--     no adjunto ya a otra publicación (UNIQUE(asset_id) es defensa en profundidad, no la única).
--   - Concurrencia optimista con cosplay_posts.version (ya existía la columna desde 9I-1, sin usar).
--   - Auditoría append-only mínima para acciones destructivas (borrar publicación, desadjuntar
--     imagen), sin URLs/claves de storage/tokens — sobrevive al borrado duro de la publicación.
--
-- Por qué RPC SECURITY DEFINER (y no varias llamadas .from() sueltas desde TypeScript): a
-- diferencia de admin_roles (Bloque 9B), esta migración NO revoca los grants directos de
-- service_role sobre cosplay_posts/cosplay_post_images/media_assets (siguen siendo los mismos
-- grants de 9I-1/9I-2) — las lecturas simples siguen yendo por .from() normal. Pero guardar/
-- publicar, reordenar, desadjuntar y borrar SÍ necesitan atomicidad real entre varias tablas
-- (post + imágenes + auditoría, o el intercambio temporal de `position` bajo el UNIQUE
-- diferible ya definido en 9I-1) que llamadas independientes de PostgREST no pueden garantizar.
-- Mismo patrón que 20260928120000_admin_team_member_management.sql: función plpgsql, search_path
-- fijo, revoke de EXECUTE a todos salvo service_role, el actor se re-verifica ADMIN dentro de la
-- función (nunca se confía en que el backend ya lo comprobó).

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Auditoría append-only de acciones destructivas de Cosplay.

-- SIN FK a cosplay_posts/auth.users a propósito: debe sobrevivir tanto al borrado duro de la
-- publicación como a la desaparición futura de la cuenta. Solo metadata editorial MÍNIMA
-- (title_es/slug/asset_id) — nunca URLs, claves de storage, tokens ni el cuerpo completo.
create table public.cosplay_admin_audit_log (
  id              uuid primary key default gen_random_uuid(),
  actor_user_id   uuid not null,
  post_id         uuid not null,
  action          text not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  constraint cosplay_admin_audit_log_action_check
    check (action in ('post_deleted', 'media_detached'))
);

comment on table public.cosplay_admin_audit_log is
  'Historial append-only de acciones destructivas de Cosplay (borrar publicación, desadjuntar imagen). Sin FK: sobrevive al borrado duro de la publicación y a la desaparición de la cuenta. Solo escriben las RPC SECURITY DEFINER de este archivo. Sin acceso directo para ningún rol de API.';
comment on column public.cosplay_admin_audit_log.actor_user_id is
  'ADMIN que realizó la operación (verificado por requireCapability + reconfirmado bajo lock en la RPC). Sin FK.';
comment on column public.cosplay_admin_audit_log.post_id is
  'Publicación afectada. Sin FK: sigue siendo legible aunque la publicación ya no exista.';
comment on column public.cosplay_admin_audit_log.metadata is
  'Metadata editorial MÍNIMA (p. ej. title_es/slug al borrar, asset_id al desadjuntar). Nunca URLs, claves de storage, tokens ni el cuerpo completo de la publicación.';

alter table public.cosplay_admin_audit_log enable row level security;
alter table public.cosplay_admin_audit_log force row level security;

-- Inmutabilidad: UPDATE, DELETE y TRUNCATE siempre fallan (mismo patrón que admin_team_audit).
create or replace function public.cosplay_admin_audit_log_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'cosplay_admin_audit_log_immutable' using errcode = '23001';
end;
$$;

create trigger cosplay_admin_audit_log_no_update_delete
  before update or delete on public.cosplay_admin_audit_log
  for each row execute function public.cosplay_admin_audit_log_immutable();

create trigger cosplay_admin_audit_log_no_truncate
  before truncate on public.cosplay_admin_audit_log
  for each statement execute function public.cosplay_admin_audit_log_immutable();

-- Ningún rol de API toca la tabla directamente; solo el owner, a través de las RPC definer.
revoke all privileges on table public.cosplay_admin_audit_log from public;
revoke all privileges on table public.cosplay_admin_audit_log from anon;
revoke all privileges on table public.cosplay_admin_audit_log from authenticated;
revoke all privileges on table public.cosplay_admin_audit_log from service_role;

revoke all on function public.cosplay_admin_audit_log_immutable()
  from public, anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2. cosplay_admin_save_post: crea O actualiza una publicación (borrador o publicar) y adjunta
-- imágenes NUEVAS a la galería, todo en una transacción. Nunca desadjunta: quitar una imagen
-- existente exige SIEMPRE cosplay_admin_detach_image (sección F del checkpoint) — si el llamador
-- omite una imagen ya adjunta en p_images, la función falla (images_missing_existing) en vez de
-- interpretarlo como una intención de borrado implícita.
create or replace function public.cosplay_admin_save_post(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_status text,
  p_slug text,
  p_title_es text,
  p_title_en text,
  p_title_de text,
  p_description_es text,
  p_description_en text,
  p_description_de text,
  p_character_name text,
  p_series text,
  p_event text,
  p_shot_on date,
  p_photographer_credit text,
  p_images jsonb
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
  v_current_status text;
  v_current_slug text;
  v_current_published_at timestamptz;
  v_current_version integer;
  v_final_slug text;
  v_published_at timestamptz;
  v_image_count integer;
  v_distinct_asset_count integer;
  v_distinct_position_count integer;
  v_cover_count integer;
  v_existing_image_ids uuid[];
  v_incoming_asset_ids uuid[];
  v_new_asset_ids uuid[];
  v_missing_existing integer;
  v_ready_count integer;
  v_missing_alt integer;
  v_post_json jsonb;
  v_images_json jsonb;
begin
  if p_actor_user_id is null then
    raise exception 'invalid_argument';
  end if;
  if not exists (
    select 1 from public.admin_roles where user_id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'actor_not_admin';
  end if;

  if p_status not in ('draft', 'published') then
    raise exception 'invalid_argument';
  end if;
  if p_title_es is null or length(trim(p_title_es)) = 0 then
    raise exception 'missing_title_es';
  end if;
  if p_images is null or jsonb_typeof(p_images) <> 'array' then
    raise exception 'invalid_argument';
  end if;

  v_image_count := jsonb_array_length(p_images);
  if v_image_count > 20 then
    raise exception 'too_many_photos';
  end if;

  select count(*), count(distinct (elem->>'asset_id')::uuid)
    into v_image_count, v_distinct_asset_count
    from jsonb_array_elements(p_images) as elem;
  if v_image_count <> v_distinct_asset_count then
    raise exception 'duplicate_asset_id';
  end if;

  if v_image_count > 0 then
    select count(distinct (elem->>'position')::int) into v_distinct_position_count
      from jsonb_array_elements(p_images) as elem;
    if v_distinct_position_count <> v_image_count then
      raise exception 'invalid_positions';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_images) as elem
      where (elem->>'position')::int < 0 or (elem->>'position')::int >= v_image_count
    ) then
      raise exception 'invalid_positions';
    end if;
  end if;

  select count(*) into v_cover_count
    from jsonb_array_elements(p_images) as elem
    where coalesce((elem->>'is_cover')::boolean, false);
  if v_cover_count > 1 then
    raise exception 'multiple_covers';
  end if;

  if v_is_create then
    v_post_id := gen_random_uuid();
    v_current_status := 'draft';
    v_current_slug := null;
    v_current_published_at := null;
    v_current_version := 0;
    v_existing_image_ids := array[]::uuid[];
  else
    select id, status, slug, published_at, version
      into v_post_id, v_current_status, v_current_slug, v_current_published_at, v_current_version
      from public.cosplay_posts
      where id = p_post_id
      for update;
    if not found then
      raise exception 'post_not_found';
    end if;
    if p_expected_version is null or v_current_version <> p_expected_version then
      raise exception 'version_conflict';
    end if;
    if v_current_status = 'published' and p_status = 'draft' then
      raise exception 'unpublish_not_supported';
    end if;

    select coalesce(array_agg(asset_id), array[]::uuid[]) into v_existing_image_ids
      from public.cosplay_post_images where post_id = v_post_id;
  end if;

  -- Slug: inmutable tras la primera publicación (contrato ya existente, 9I-1). El llamador ya
  -- resolvió colisiones (slugify + generateUniqueSlug) para un borrador o una creación nueva.
  v_final_slug := case when v_current_status = 'published' then v_current_slug else p_slug end;
  if v_final_slug is null or length(trim(v_final_slug)) = 0 then
    raise exception 'invalid_argument';
  end if;

  -- Ninguna imagen YA adjunta puede faltar en p_images: desadjuntar exige el flujo explícito.
  select count(*) into v_missing_existing
    from public.cosplay_post_images cpi
    where cpi.post_id = v_post_id
      and not exists (
        select 1 from jsonb_array_elements(p_images) as elem
        where (elem->>'asset_id')::uuid = cpi.asset_id
      );
  if v_missing_existing > 0 then
    raise exception 'images_missing_existing';
  end if;

  select coalesce(array_agg((elem->>'asset_id')::uuid), array[]::uuid[]) into v_incoming_asset_ids
    from jsonb_array_elements(p_images) as elem;

  select coalesce(array_agg(a.id), array[]::uuid[]) into v_new_asset_ids
    from unnest(v_incoming_asset_ids) as a(id)
    where not (a.id = any(v_existing_image_ids));

  if array_length(v_new_asset_ids, 1) > 0 then
    -- Bloquea los assets nuevos ANTES de comprobar su elegibilidad: dos guardados concurrentes
    -- intentando adjuntar el mismo asset recién-listo nunca pueden ganar ambos.
    perform 1 from public.media_assets where id = any(v_new_asset_ids) for update;

    if (select count(*) from public.media_assets where id = any(v_new_asset_ids))
        <> array_length(v_new_asset_ids, 1) then
      raise exception 'invalid_asset';
    end if;
    if exists (
      select 1 from public.media_assets where id = any(v_new_asset_ids) and domain <> 'cosplay'
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
      select 1 from public.cosplay_post_images where asset_id = any(v_new_asset_ids)
    ) then
      raise exception 'asset_already_attached';
    end if;
  end if;

  if v_is_create then
    insert into public.cosplay_posts (
      id, slug, status, title_es, title_en, title_de,
      description_es, description_en, description_de,
      character_name, series, event, shot_on, photographer_credit,
      version, created_by, updated_by, created_at, updated_at, published_at
    ) values (
      v_post_id, v_final_slug, p_status, p_title_es, p_title_en, p_title_de,
      p_description_es, p_description_en, p_description_de,
      p_character_name, p_series, p_event, p_shot_on, p_photographer_credit,
      1, p_actor_user_id, p_actor_user_id, v_now, v_now,
      case when p_status = 'published' then v_now else null end
    );
  else
    v_published_at := case
      when p_status = 'published' and v_current_published_at is null then v_now
      else v_current_published_at
    end;
    update public.cosplay_posts set
      slug = v_final_slug,
      status = p_status,
      title_es = p_title_es, title_en = p_title_en, title_de = p_title_de,
      description_es = p_description_es, description_en = p_description_en,
      description_de = p_description_de,
      character_name = p_character_name, series = p_series, event = p_event,
      shot_on = p_shot_on, photographer_credit = p_photographer_credit,
      version = v_current_version + 1,
      updated_by = p_actor_user_id,
      updated_at = v_now,
      published_at = v_published_at
    where id = v_post_id;
  end if;

  -- Actualiza metadata/posición de las imágenes YA adjuntas (el join con jsonb_array_elements
  -- simplemente no afecta filas para los asset_id todavía no adjuntos).
  update public.cosplay_post_images cpi set
    position = (elem->>'position')::int,
    is_cover = coalesce((elem->>'is_cover')::boolean, false),
    decorative = coalesce((elem->>'decorative')::boolean, false),
    alt_es = elem->>'alt_es', alt_en = elem->>'alt_en', alt_de = elem->>'alt_de',
    caption_es = elem->>'caption_es', caption_en = elem->>'caption_en',
    caption_de = elem->>'caption_de'
  from jsonb_array_elements(p_images) as elem
  where cpi.post_id = v_post_id
    and cpi.asset_id = (elem->>'asset_id')::uuid;

  -- El UNIQUE (post_id, position) es DEFERRABLE INITIALLY IMMEDIATE (9I-1): diferirlo permite que
  -- el UPDATE de arriba y el INSERT de abajo puedan pisar temporalmente posiciones ya usadas
  -- dentro de esta misma transacción (p. ej. reordenar al mismo tiempo que se adjunta).
  set constraints public.cosplay_post_images_position_unique deferred;

  insert into public.cosplay_post_images (
    post_id, asset_id, position, is_cover, decorative,
    alt_es, alt_en, alt_de, caption_es, caption_en, caption_de, created_at
  )
  select v_post_id, (elem->>'asset_id')::uuid, (elem->>'position')::int,
    coalesce((elem->>'is_cover')::boolean, false), coalesce((elem->>'decorative')::boolean, false),
    elem->>'alt_es', elem->>'alt_en', elem->>'alt_de',
    elem->>'caption_es', elem->>'caption_en', elem->>'caption_de', v_now
  from jsonb_array_elements(p_images) as elem
  where (elem->>'asset_id')::uuid = any(v_new_asset_ids);

  -- Requisitos de "listo para publicar" (mismos códigos que validatePublishReadiness en
  -- cosplay-domain.ts, reevaluados en SQL porque dependen del estado FINAL de la galería dentro
  -- de la MISMA transacción): al menos 1 imagen ready, exactamente 1 portada ready, alt_es en
  -- toda imagen ready no decorativa. Si algo falla aquí, TODA la transacción se revierte: nunca
  -- queda un guardado a medias.
  if p_status = 'published' then
    select count(*) into v_ready_count
      from public.cosplay_post_images cpi
      join public.media_assets ma on ma.id = cpi.asset_id
      where cpi.post_id = v_post_id and ma.status = 'ready';
    if v_ready_count = 0 then
      raise exception 'no_ready_images';
    end if;

    select count(*) into v_cover_count
      from public.cosplay_post_images cpi
      join public.media_assets ma on ma.id = cpi.asset_id
      where cpi.post_id = v_post_id and ma.status = 'ready' and cpi.is_cover;
    if v_cover_count = 0 then
      raise exception 'no_cover';
    end if;
    if v_cover_count > 1 then
      raise exception 'multiple_covers';
    end if;

    select count(*) into v_missing_alt
      from public.cosplay_post_images cpi
      join public.media_assets ma on ma.id = cpi.asset_id
      where cpi.post_id = v_post_id and ma.status = 'ready'
        and not cpi.decorative
        and (cpi.alt_es is null or length(trim(cpi.alt_es)) = 0);
    if v_missing_alt > 0 then
      raise exception 'missing_alt_es';
    end if;
  end if;

  select to_jsonb(cp) into v_post_json from public.cosplay_posts cp where cp.id = v_post_id;
  select coalesce(jsonb_agg(to_jsonb(cpi) order by cpi.position), '[]'::jsonb) into v_images_json
    from public.cosplay_post_images cpi where cpi.post_id = v_post_id;

  return jsonb_build_object('post', v_post_json, 'images', v_images_json);
end;
$$;

comment on function public.cosplay_admin_save_post(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text, text, text, date, text, jsonb
) is
  'Crea (p_post_id null) o actualiza (con concurrencia optimista por version) una publicación de Cosplay y adjunta imágenes NUEVAS a su galería. Nunca desadjunta (usar cosplay_admin_detach_image). Valida límite de 20 fotos, posiciones contiguas, portada única, y — si p_status=published — los requisitos de validatePublishReadiness. SOLO service_role (EXECUTE).';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 3. cosplay_admin_reorder_images: reordena atómicamente el conjunto EXISTENTE de imágenes de una
-- publicación (nunca adjunta ni desadjunta). Producto: mover arriba/abajo, no arrastrar-soltar,
-- pero el backend acepta cualquier permutación completa y válida del conjunto actual.
create or replace function public.cosplay_admin_reorder_images(
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
  v_existing_ids uuid[];
  v_incoming_ids uuid[];
  v_count integer;
  v_distinct_ids integer;
  v_distinct_positions integer;
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;
  if not exists (
    select 1 from public.admin_roles where user_id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'actor_not_admin';
  end if;
  if p_positions is null or jsonb_typeof(p_positions) <> 'array' then
    raise exception 'invalid_argument';
  end if;

  select version into v_current_version
    from public.cosplay_posts where id = p_post_id for update;
  if not found then
    raise exception 'post_not_found';
  end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select coalesce(array_agg(id), array[]::uuid[]) into v_existing_ids
    from public.cosplay_post_images where post_id = p_post_id;

  select count(*), count(distinct (elem->>'image_id')::uuid),
         count(distinct (elem->>'position')::int)
    into v_count, v_distinct_ids, v_distinct_positions
    from jsonb_array_elements(p_positions) as elem;

  if v_count > 20 then
    raise exception 'too_many_photos';
  end if;
  if v_count <> v_distinct_ids or v_count <> v_distinct_positions then
    raise exception 'invalid_positions';
  end if;
  if v_count <> coalesce(array_length(v_existing_ids, 1), 0) then
    raise exception 'images_missing_existing';
  end if;

  select coalesce(array_agg((elem->>'image_id')::uuid), array[]::uuid[]) into v_incoming_ids
    from jsonb_array_elements(p_positions) as elem;
  if exists (
    select 1 from unnest(v_existing_ids) as e(id) where not (e.id = any(v_incoming_ids))
  ) then
    raise exception 'images_missing_existing';
  end if;
  if v_count > 0 and exists (
    select 1 from jsonb_array_elements(p_positions) as elem
    where (elem->>'position')::int < 0 or (elem->>'position')::int >= v_count
  ) then
    raise exception 'invalid_positions';
  end if;

  set constraints public.cosplay_post_images_position_unique deferred;

  update public.cosplay_post_images cpi
    set position = (elem->>'position')::int
    from jsonb_array_elements(p_positions) as elem
    where cpi.post_id = p_post_id
      and cpi.id = (elem->>'image_id')::uuid;

  update public.cosplay_posts
    set version = v_current_version + 1, updated_by = p_actor_user_id, updated_at = v_now
    where id = p_post_id;

  return jsonb_build_object('version', v_current_version + 1);
end;
$$;

comment on function public.cosplay_admin_reorder_images(uuid, uuid, integer, jsonb) is
  'Reordena atómicamente el conjunto EXISTENTE de cosplay_post_images de una publicación (mismo conjunto completo, solo posiciones nuevas). Usa SET CONSTRAINTS ... DEFERRED sobre cosplay_post_images_position_unique para permitir un intercambio de posiciones dentro de la misma transacción. SOLO service_role (EXECUTE).';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 4. cosplay_admin_detach_image: desadjunta UNA imagen (borra la fila de galería) y transiciona
-- su media_asset a 'deleting'. NO toca R2: el backend TypeScript limpia las variantes públicas y
-- el original privado residual DESPUÉS, con las primitivas ya existentes de r2-client.ts, y solo
-- borra la fila de media_assets tras confirmar esa limpieza (ver cosplay-media-lifecycle.ts).
create or replace function public.cosplay_admin_detach_image(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_image_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_current_version integer;
  v_asset_id uuid;
  v_asset_status text;
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null
     or p_image_id is null then
    raise exception 'invalid_argument';
  end if;
  if not exists (
    select 1 from public.admin_roles where user_id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'actor_not_admin';
  end if;

  select version into v_current_version
    from public.cosplay_posts where id = p_post_id for update;
  if not found then
    raise exception 'post_not_found';
  end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select asset_id into v_asset_id
    from public.cosplay_post_images
    where id = p_image_id and post_id = p_post_id;
  if not found then
    raise exception 'image_not_found';
  end if;

  insert into public.cosplay_admin_audit_log (actor_user_id, post_id, action, metadata, created_at)
    values (p_actor_user_id, p_post_id, 'media_detached',
            jsonb_build_object('asset_id', v_asset_id), v_now);

  delete from public.cosplay_post_images where id = p_image_id;

  select status into v_asset_status from public.media_assets where id = v_asset_id for update;
  if found and v_asset_status = 'ready' then
    update public.media_assets set status = 'deleting', updated_at = v_now where id = v_asset_id;
  end if;

  update public.cosplay_posts
    set version = v_current_version + 1, updated_by = p_actor_user_id, updated_at = v_now
    where id = p_post_id;

  return jsonb_build_object('asset_id', v_asset_id, 'version', v_current_version + 1);
end;
$$;

comment on function public.cosplay_admin_detach_image(uuid, uuid, integer, uuid) is
  'Desadjunta UNA imagen de una publicación (borra su fila de cosplay_post_images) y transiciona su media_asset a status=deleting si estaba ready. Audita (media_detached). NO toca R2: eso lo hace el backend TypeScript después, con las primitivas existentes, solo borrando la fila de media_assets tras confirmar la limpieza. SOLO service_role (EXECUTE).';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 5. cosplay_admin_delete_post: borrado DURO de una publicación completa. Audita ANTES de borrar
-- (misma transacción); transiciona sus media_assets ready a 'deleting'; el borrado de
-- cosplay_posts cascada sobre cosplay_post_images (9I-1). La limpieza de R2 y el borrado final de
-- media_assets ocurren después, en TypeScript, con la misma primitiva que el detach.
create or replace function public.cosplay_admin_delete_post(
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
  v_title_es text;
  v_slug text;
  v_asset_ids uuid[];
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;
  if not exists (
    select 1 from public.admin_roles where user_id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'actor_not_admin';
  end if;

  select version, title_es, slug into v_current_version, v_title_es, v_slug
    from public.cosplay_posts where id = p_post_id for update;
  if not found then
    raise exception 'post_not_found';
  end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select coalesce(array_agg(asset_id), array[]::uuid[]) into v_asset_ids
    from public.cosplay_post_images where post_id = p_post_id;

  insert into public.cosplay_admin_audit_log (actor_user_id, post_id, action, metadata, created_at)
    values (p_actor_user_id, p_post_id, 'post_deleted',
            jsonb_build_object('title_es', v_title_es, 'slug', v_slug), clock_timestamp());

  if array_length(v_asset_ids, 1) > 0 then
    update public.media_assets set status = 'deleting', updated_at = clock_timestamp()
      where id = any(v_asset_ids) and status = 'ready';
  end if;

  delete from public.cosplay_posts where id = p_post_id;

  return jsonb_build_object('deleted_asset_ids', to_jsonb(v_asset_ids));
end;
$$;

comment on function public.cosplay_admin_delete_post(uuid, uuid, integer) is
  'Borrado DURO de una publicación de Cosplay. Audita (post_deleted) ANTES de borrar, en la misma transacción; transiciona sus media_assets ready a deleting; el DELETE cascada sobre cosplay_post_images. Devuelve deleted_asset_ids para que TypeScript limpie R2 y borre media_assets después. SOLO service_role (EXECUTE).';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 6. EXECUTE: solo service_role, nunca anon/authenticated (mismo patrón que el resto de RPC
-- privilegiadas del proyecto).

revoke all on function public.cosplay_admin_save_post(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text, text, text, date, text, jsonb
) from public;
revoke execute on function public.cosplay_admin_save_post(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text, text, text, date, text, jsonb
) from anon;
revoke execute on function public.cosplay_admin_save_post(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text, text, text, date, text, jsonb
) from authenticated;
grant execute on function public.cosplay_admin_save_post(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text, text, text, date, text, jsonb
) to service_role;

revoke all on function public.cosplay_admin_reorder_images(uuid, uuid, integer, jsonb)
  from public;
revoke execute on function public.cosplay_admin_reorder_images(uuid, uuid, integer, jsonb)
  from anon;
revoke execute on function public.cosplay_admin_reorder_images(uuid, uuid, integer, jsonb)
  from authenticated;
grant execute on function public.cosplay_admin_reorder_images(uuid, uuid, integer, jsonb)
  to service_role;

revoke all on function public.cosplay_admin_detach_image(uuid, uuid, integer, uuid) from public;
revoke execute on function public.cosplay_admin_detach_image(uuid, uuid, integer, uuid)
  from anon;
revoke execute on function public.cosplay_admin_detach_image(uuid, uuid, integer, uuid)
  from authenticated;
grant execute on function public.cosplay_admin_detach_image(uuid, uuid, integer, uuid)
  to service_role;

revoke all on function public.cosplay_admin_delete_post(uuid, uuid, integer) from public;
revoke execute on function public.cosplay_admin_delete_post(uuid, uuid, integer) from anon;
revoke execute on function public.cosplay_admin_delete_post(uuid, uuid, integer)
  from authenticated;
grant execute on function public.cosplay_admin_delete_post(uuid, uuid, integer)
  to service_role;
