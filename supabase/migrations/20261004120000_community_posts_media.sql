-- Fundación de publicaciones de Comunidad (Fase 9J-1C): contenido propiedad del USUARIO (no
-- ADMIN), gestionado desde /account, no desde /community (que en este checkpoint sigue sin
-- controles de creación — ver el checkpoint). Solo imágenes: kind sigue siendo 'image' en
-- media_assets, sin vídeo todavía.
--
-- Mismo patrón de seguridad que el resto de tablas privilegiadas del proyecto (profiles,
-- cosplay_posts, media_assets): RLS activado y FORZADO, CERO policies para anon/authenticated,
-- acceso exclusivo service_role. A diferencia de profiles (que SÍ tiene una policy SELECT
-- pública), community_posts/community_post_media NO exponen ninguna policy en este checkpoint:
-- no existe todavía ningún endpoint de lectura pública (9J-1C no implementa el feed de
-- /community ni el perfil público /@username) — cuando ese endpoint llegue, leerá con
-- service_role y filtrará status='published' en servidor, igual que /api/content ya hace con
-- Cosplay, así que no hace falta anticipar una policy que nadie usa todavía.
--
-- Mutación exclusivamente vía RPC SECURITY DEFINER (community_post_save/_reorder_media/
-- _detach_media/_delete), que RE-VERIFICAN que el actor es el AUTOR de la publicación bajo lock
-- —nunca ADMIN: a diferencia de cosplay_admin_*, estas RPC comprueban author_user_id =
-- p_actor_user_id, no admin_roles. Mismo motivo que cosplay_admin_save_post para usar RPC en vez
-- de varias llamadas .from() sueltas: atomicidad real entre community_posts + community_post_media
-- (crear/editar + adjuntar en una transacción, o el intercambio de `position` bajo el UNIQUE
-- diferible al reordenar).
--
-- `status` existe desde ya (published/hidden) para que una futura moderación pueda ocultar una
-- publicación SIN borrarla — pero ninguna RPC de este checkpoint la pone a 'hidden': todo lo que
-- se crea aquí nace 'published', y la moderación en sí queda fuera de alcance (ver el checkpoint).

create table public.community_posts (
  id               uuid primary key default gen_random_uuid(),
  author_user_id   uuid not null references auth.users(id) on delete cascade,
  text             text,
  status           text not null default 'published',
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint community_posts_status_check check (status in ('published', 'hidden')),
  constraint community_posts_version_check check (version >= 1),
  constraint community_posts_text_length check (text is null or char_length(text) between 1 and 2000),
  constraint community_posts_text_not_blank check (text is null or btrim(text) <> '')
);

comment on table public.community_posts is
  'Publicaciones de Comunidad, propiedad del usuario autor (no ADMIN). Creadas/editadas/borradas SOLO desde /account, vía las RPC community_post_*. Acceso exclusivo server-side (service_role); sin policy pública en este checkpoint (9J-1C no implementa lectura pública).';
comment on column public.community_posts.author_user_id is
  'Autor verificado por JWT (requireAuthenticated), nunca confiado del body. ON DELETE CASCADE: la publicación desaparece con la cuenta.';
comment on column public.community_posts.text is
  'Texto opcional en código-fuente del usuario (sin traducción editorial). NULL = ausente; texto solo-espacios se normaliza a NULL en la capa de aplicación (community-post-fields.ts) antes de llegar aquí. Máximo 2000 code points.';
comment on column public.community_posts.status is
  'published (todas las publicaciones de este checkpoint) u hidden (reservado para una futura moderación, sin implementar aquí). No confundir con el borrado propio del autor, que es DURO (ver community_post_delete).';
comment on column public.community_posts.version is
  'Concurrencia optimista, mismo patrón que cosplay_posts.version: cada escritura la incrementa; una edición/reordenación con version desfasada se rechaza (version_conflict).';

alter table public.community_posts enable row level security;
alter table public.community_posts force row level security;

revoke all on table public.community_posts from public;
revoke all on table public.community_posts from anon;
revoke all on table public.community_posts from authenticated;
revoke all on table public.community_posts from service_role;
grant select, insert, update, delete on table public.community_posts to service_role;

-- "Listar mis publicaciones" (más recientes primero).
create index community_posts_by_author on public.community_posts (author_user_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- community_post_media: asociación de galería entre una publicación de Comunidad y un
-- media_asset, con orden explícito. Sin alt/caption/is_cover editorial (a diferencia de
-- cosplay_post_images): Comunidad no tiene un flujo editorial ADMIN, y el checkpoint congela
-- "no translated alt/caption fields, no Cosplay editorial metadata" — estructuralmente
-- agnóstica de tipo (solo post_id/asset_id/position) para que un futuro asset de vídeo pueda
-- referenciar la misma relación sin rediseño de esquema.
--
-- `asset_id` es UNIQUE (igual que cosplay_post_images): un media_asset pertenece a lo sumo a
-- UNA publicación de Comunidad, nunca se reutiliza entre galerías. FK ON DELETE RESTRICT: borrar
-- media_assets mientras una publicación lo referencia falla de forma visible — el flujo correcto
-- es primero desadjuntar (community_post_detach_media). `post_id` ON DELETE CASCADE: el borrado
-- del autor es DURO (ver community_post_delete), así que sus asociaciones de galería desaparecen
-- con la publicación (los media_assets referenciados quedan huérfanos de galería, transicionados
-- a 'deleting' por la misma RPC, y se limpian en R2 después con attemptMediaAssetCleanup —
-- reutilizada TAL CUAL de cosplay-media-lifecycle.ts, que ya es agnóstica de domain).
create table public.community_post_media (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.community_posts(id) on delete cascade,
  asset_id      uuid not null references public.media_assets(id) on delete restrict,
  position      integer not null,
  created_at    timestamptz not null default now(),

  constraint community_post_media_asset_unique unique (asset_id),
  constraint community_post_media_position_check check (position >= 0),
  -- Igual que cosplay_post_images_position_unique: DEFERRABLE permite `set constraints ... deferred`
  -- en community_post_reorder_media/community_post_save para intercambiar posiciones dentro de la
  -- misma transacción.
  constraint community_post_media_position_unique
    unique (post_id, position) deferrable initially immediate
);

comment on table public.community_post_media is
  'Asociación de galería: qué media_asset pertenece a qué publicación de Comunidad, en qué orden. Sin metadata editorial (alt/caption/is_cover) — a diferencia de cosplay_post_images, Comunidad no tiene flujo ADMIN. Estructuralmente agnóstica de tipo: un futuro asset de vídeo reutilizaría esta misma relación. Acceso exclusivo server-side (service_role).';
comment on column public.community_post_media.asset_id is
  'UNIQUE: un media_asset pertenece a lo sumo a una publicación de Comunidad. FK ON DELETE RESTRICT: no se puede borrar el media_asset mientras esta fila exista.';

alter table public.community_post_media enable row level security;
alter table public.community_post_media force row level security;

revoke all on table public.community_post_media from public;
revoke all on table public.community_post_media from anon;
revoke all on table public.community_post_media from authenticated;
revoke all on table public.community_post_media from service_role;
grant select, insert, update, delete on table public.community_post_media to service_role;

create index community_post_media_gallery_order on public.community_post_media (post_id, position);

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- media_assets.domain: ensancha el CHECK existente (creado 'cosplay'-only en
-- 20260930120000_cosplay_foundation.sql) para admitir también 'community' — mismo patrón que
-- 20260926120000_admin_team_roles_invariants.sql ensanchó admin_roles_role_check. kind/mime
-- siguen sin tocarse: kind='image' y mime='image/webp' siguen siendo las únicas listas cerradas
-- (sin vídeo en este checkpoint, para ningún domain).
alter table public.media_assets drop constraint media_assets_domain_check;
alter table public.media_assets add constraint media_assets_domain_check
  check (domain in ('cosplay', 'community'));

comment on column public.media_assets.domain is
  'Módulo dueño de la fila: cosplay o community (9J-1C ensanchó la lista original, solo-cosplay). Cada domain tiene su propia autorización de reserva/subida (ver media-handlers.ts): cosplay exige cosplay_admin+MFA; community exige solo autenticación + perfil de Comunidad existente.';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1. community_post_save: crea (p_post_id null) o actualiza (concurrencia optimista por version)
-- una publicación y adjunta media NUEVA. Nunca desadjunta (usar community_post_detach_media) — si
-- el llamador omite una fila de media ya adjunta en p_media, la función falla
-- (media_missing_existing), igual que cosplay_admin_save_post con sus imágenes.
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

comment on function public.community_post_save(uuid, uuid, integer, text, jsonb) is
  'Crea (p_post_id null) o actualiza (concurrencia optimista por version) una publicación de Comunidad y adjunta media NUEVA. Exige perfil de Comunidad existente (no_profile) y re-verifica author_user_id = p_actor_user_id bajo lock (not_owner) — nunca admin_roles. Nunca desadjunta (usar community_post_detach_media). Valida límite de 10 media, posiciones contiguas, y el invariante "texto o media" con el estado final de la transacción (empty_post). SOLO service_role (EXECUTE).';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2. community_post_reorder_media: reordena atómicamente el conjunto EXISTENTE de media de una
-- publicación (nunca adjunta ni desadjunta).
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

comment on function public.community_post_reorder_media(uuid, uuid, integer, jsonb) is
  'Reordena atómicamente el conjunto EXISTENTE de community_post_media de una publicación (mismo conjunto completo, solo posiciones nuevas). Re-verifica author_user_id = p_actor_user_id bajo lock. SOLO service_role (EXECUTE).';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 3. community_post_detach_media: desadjunta UNA media (borra la fila de galería) y transiciona
-- su media_asset a 'deleting' si estaba ready. Rechaza dejar la publicación vacía (empty_post) si
-- esa era su última media y no tiene texto. NO toca R2: el backend TypeScript limpia después con
-- attemptMediaAssetCleanup (cosplay-media-lifecycle.ts, ya agnóstica de domain, reutilizada TAL CUAL).
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

comment on function public.community_post_detach_media(uuid, uuid, integer, uuid) is
  'Desadjunta UNA media de una publicación propia (borra su fila de community_post_media) y transiciona su media_asset a status=deleting si estaba ready. Rechaza dejar la publicación sin texto ni media (empty_post). Re-verifica author_user_id bajo lock. NO toca R2: eso lo hace el backend TypeScript después con attemptMediaAssetCleanup. SOLO service_role (EXECUTE).';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 4. community_post_delete: borrado DURO de una publicación propia completa (el borrado del autor
-- NO es moderación — ver el checkpoint). Transiciona sus media_assets ready a 'deleting'; el
-- borrado de community_posts cascada sobre community_post_media. La limpieza de R2 y el borrado
-- final de media_assets ocurren después, en TypeScript, con attemptMediaAssetCleanup.
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

comment on function public.community_post_delete(uuid, uuid, integer) is
  'Borrado DURO de una publicación de Comunidad propia (el borrado del autor no es moderación). Re-verifica author_user_id bajo lock. Transiciona sus media_assets ready a deleting; el DELETE cascada sobre community_post_media. Devuelve deleted_asset_ids para que TypeScript limpie R2 y borre media_assets después. SOLO service_role (EXECUTE).';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 5. EXECUTE: solo service_role, nunca anon/authenticated (mismo patrón que las RPC de Cosplay).

revoke all on function public.community_post_save(uuid, uuid, integer, text, jsonb) from public;
revoke execute on function public.community_post_save(uuid, uuid, integer, text, jsonb) from anon;
revoke execute on function public.community_post_save(uuid, uuid, integer, text, jsonb)
  from authenticated;
grant execute on function public.community_post_save(uuid, uuid, integer, text, jsonb)
  to service_role;

revoke all on function public.community_post_reorder_media(uuid, uuid, integer, jsonb)
  from public;
revoke execute on function public.community_post_reorder_media(uuid, uuid, integer, jsonb)
  from anon;
revoke execute on function public.community_post_reorder_media(uuid, uuid, integer, jsonb)
  from authenticated;
grant execute on function public.community_post_reorder_media(uuid, uuid, integer, jsonb)
  to service_role;

revoke all on function public.community_post_detach_media(uuid, uuid, integer, uuid) from public;
revoke execute on function public.community_post_detach_media(uuid, uuid, integer, uuid)
  from anon;
revoke execute on function public.community_post_detach_media(uuid, uuid, integer, uuid)
  from authenticated;
grant execute on function public.community_post_detach_media(uuid, uuid, integer, uuid)
  to service_role;

revoke all on function public.community_post_delete(uuid, uuid, integer) from public;
revoke execute on function public.community_post_delete(uuid, uuid, integer) from anon;
revoke execute on function public.community_post_delete(uuid, uuid, integer) from authenticated;
grant execute on function public.community_post_delete(uuid, uuid, integer) to service_role;
