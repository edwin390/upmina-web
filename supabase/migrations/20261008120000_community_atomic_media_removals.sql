-- 9J-FIX8.3: retiradas explícitas dentro del mismo guardado/versionado.
-- Nombre distinto evita sobrecargas ambiguas en PostgREST y conserva intactas las RPC antiguas.
-- Se delegan TODAS las validaciones del estado final a community_post_save (9J-3).
create function public.community_post_save_atomic(
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

revoke all on function public.community_post_save_atomic(uuid, uuid, integer, text, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.community_post_save_atomic(uuid, uuid, integer, text, jsonb, uuid[]) to service_role;
