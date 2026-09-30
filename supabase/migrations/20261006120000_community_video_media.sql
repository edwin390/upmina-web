-- Soporte de vídeo en Comunidad (Fase 9J-3): amplía media_assets (creada en
-- 20260930120000_cosplay_foundation.sql, ampliada en 20261001120000_cosplay_media_pipeline.sql —
-- ninguna de las dos se edita aquí) para admitir kind='video' además de 'image'. Mismo patrón que
-- 20261004120000_community_posts_media.sql amplió media_assets_domain_check: una migración nueva
-- que ensancha CHECK existentes, nunca reescribe la migración original.
--
-- Decisión de producto congelada (checkpoint 9J-3): SIN transcodificación. El vídeo validado se
-- almacena y sirve TAL CUAL — a diferencia de una imagen (que siempre pasa por el pipeline
-- canónico WebP de media-processing.ts y termina con hasta 4 media_asset_variants), un vídeo
-- listo tiene CERO filas en media_asset_variants: sus columnas canónicas (mime/width/height/
-- bytes/storage_key) describen directamente el objeto público original, copiado de
-- private/objects/ a public/ sin decodificar ni recomprimir (ver media-handlers.ts,
-- completeVideoAsset). Por eso el mismo grupo de columnas "canónicas juntas o ninguna"
-- (media_assets_canonical_fields_together, sin cambios aquí) sigue siendo válido para ambos kind.
--
-- Cosplay sigue siendo SOLO imagen: nada en esta migración toca su autorización (media-handlers.ts
-- solo permite kind='video' para domain='community', ver SUPPORTED_VIDEO_DOMAINS) ni afloja
-- ninguna regla existente de imagen — únicamente se AMPLÍAN listas cerradas para admitir un nuevo
-- valor, la validación real de qué domain puede usar qué kind vive en TypeScript (media-domain.ts)
-- y se re-verifica server-side en cada reserva.

alter table public.media_assets drop constraint media_assets_kind_check;
alter table public.media_assets add constraint media_assets_kind_check
  check (kind in ('image', 'video'));

alter table public.media_assets drop constraint media_assets_mime_check;
alter table public.media_assets add constraint media_assets_mime_check
  check (mime in ('image/webp', 'video/mp4', 'video/quicktime', 'video/webm'));

alter table public.media_assets drop constraint media_assets_source_mime_check;
alter table public.media_assets add constraint media_assets_source_mime_check
  check (source_mime is null or source_mime in (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif',
    'video/mp4', 'video/quicktime', 'video/webm'
  ));

-- 100 MiB (104857600): techo del vídeo original, mayor que el techo previo de imagen (60 MiB). La
-- aplicación (media-domain.ts validateReservationInput) sigue exigiendo el techo EXACTO por kind
-- (60 MiB imagen, 100 MiB vídeo) antes de que ninguna fila llegue a insertarse; este CHECK es solo
-- la cota de defensa en profundidad más amplia de las dos.
alter table public.media_assets drop constraint media_assets_source_bytes_check;
alter table public.media_assets add constraint media_assets_source_bytes_check
  check (source_bytes is null or (source_bytes > 0 and source_bytes <= 104857600));

-- bytes (canónico): para una imagen sigue siendo el WebP ya comprimido (≤8 MiB en la práctica,
-- sin cambio de comportamiento); para un vídeo es el ORIGINAL sin recomprimir, hasta 100 MiB.
alter table public.media_assets drop constraint media_assets_bytes_check;
alter table public.media_assets add constraint media_assets_bytes_check
  check (bytes > 0 and bytes <= 104857600);

-- duration_seconds: SOLO vídeo, metadata de UX (sección 10 del checkpoint: "do not require
-- duration as a security boundary") — nunca se usa para autorizar ni para validar tamaño/cuota.
-- NULL para imagen siempre; NULL también válido para un vídeo cuyo navegador de origen no pudo
-- leer la duración (nunca se inventa un valor).
alter table public.media_assets add column duration_seconds double precision;
alter table public.media_assets add constraint media_assets_duration_seconds_check
  check (duration_seconds is null or duration_seconds > 0);

comment on column public.media_assets.duration_seconds is
  'Duración en segundos, SOLO vídeo, declarada por el navegador de origen (nunca verificada server-side, nunca boundary de seguridad). NULL para imagen, o si el navegador no pudo leerla.';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- community_post_save: MISMA firma que 20261004120000_community_posts_media.sql, create or
-- replace (nunca se edita la migración original) — añade el único invariante de producto nuevo de
-- 9J-3: como máximo 1 vídeo por publicación (el máximo de 10 media totales YA estaba validado, sin
-- cambios). Se evalúa sobre v_incoming_asset_ids (el conjunto FINAL: existente conservada + nueva),
-- exactamente igual que el invariante "texto o media" ya evaluaba v_final_media_count.
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

comment on function public.community_post_save(uuid, uuid, integer, text, jsonb) is
  'Crea (p_post_id null) o actualiza (concurrencia optimista por version) una publicación de Comunidad y adjunta media NUEVA. Exige perfil de Comunidad existente (no_profile) y re-verifica author_user_id = p_actor_user_id bajo lock (not_owner). Nunca desadjunta (usar community_post_detach_media). Valida límite de 10 media totales, MÁXIMO 1 vídeo (9J-3, too_many_videos), posiciones contiguas, y el invariante "texto o media" con el estado final de la transacción (empty_post). SOLO service_role (EXECUTE).';

-- EXECUTE: sin cambios de grants (create or replace conserva los existentes), pero se repiten
-- explícitamente por claridad y para que esta migración sea autocontenida si algún día se audita
-- sola — mismo patrón que 20261004120000_community_posts_media.sql.
revoke all on function public.community_post_save(uuid, uuid, integer, text, jsonb) from public;
revoke execute on function public.community_post_save(uuid, uuid, integer, text, jsonb) from anon;
revoke execute on function public.community_post_save(uuid, uuid, integer, text, jsonb)
  from authenticated;
grant execute on function public.community_post_save(uuid, uuid, integer, text, jsonb)
  to service_role;
