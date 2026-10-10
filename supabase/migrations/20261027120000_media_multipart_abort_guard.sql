-- 9K-R6 · Protección de sesiones multipart abandonadas (PROPUESTA — NO aplicada en ningún entorno).
--
-- Problema: una reserva multipart abandonada (pestaña cerrada, conexión perdida) conserva su
-- `multipart_upload_id`. El barrido la marca `deleting`, el GC borra claves y FINALIZA (borra la
-- fila): el identificador se pierde sin haber hecho AbortMultipartUpload y las partes ya subidas
-- quedan en R2 hasta la caducidad automática de R2.
--
-- Invariante nueva: una fila de media_assets con multipart_upload_id no nulo NO se puede borrar.
-- Solo el GC lo pone a NULL, y solo tras abortar la sesión en R2 con ESE identificador exacto.
--
--   1. community_asset_gc_objects          — misma firma; añade multipartUploadId / multipartKey.
--   2. community_asset_gc_multipart_cleared — NUEVA: limpia el identificador tras el aborto.
--   3. community_asset_gc_finalize         — misma firma; se niega a borrar con multipart pendiente.
--   4. media_assets_block_delete_open_multipart — BEFORE DELETE: barrera para cualquier otro camino.
--
-- Compatibilidad: no cambia columnas ni firmas. Un GC antiguo (sin esta lógica) ignora los campos
-- nuevos y su finalize devuelve 'multipart_pending' (reintento con backoff): nunca borra la fila.
-- Interacciones comprobadas: media_asset_variants cascada DESDE el asset (no hacia él);
-- created_by → auth.users es ON DELETE SET NULL (UPDATE, no DELETE); community_post_media y
-- cosplay_post_images son RESTRICT. Los únicos DELETE de media_assets son finalize, el cleanup
-- inline y el rollback de /api/media/reserve (ver docs/9K-R6-MULTIPART-ABANDON-GUARD.md).
-- Dependencias: 20261020 (cola GC), 20261026 (claves canónicas, que esta migración conserva).
-- Producción: NO aplicar hasta que DEV Testing la haya validado.

-- ---------------------------------------------------------------------------------------------
-- 1. community_asset_gc_objects: idéntica a 20261026 + datos de la sesión multipart
--    La sesión solo se devuelve si la clave del staging pasa el MISMO regex de propiedad; si hay
--    identificador pero la clave no es válida, cuenta como clave rechazada (el GC falla cerrado).
-- ---------------------------------------------------------------------------------------------
create or replace function public.community_asset_gc_objects(p_asset_id uuid, p_claim_token uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_a public.media_assets%rowtype;
  v_public_re text;
  v_private_re text;
  v_public text[];
  v_private text[];
  v_rejected integer;
  v_mp_id text;
  v_mp_key text;
begin
  if p_asset_id is null or p_claim_token is null then return jsonb_build_object('valid', false); end if;
  select * into v_a from public.media_assets
    where id = p_asset_id and status = 'deleting' and purge_claim_token = p_claim_token
      and purge_lease_until > clock_timestamp();
  if not found then return jsonb_build_object('valid', false); end if;
  v_public_re := case when v_a.domain = 'community'
    then '^community/' || v_a.id::text || '/(w(480|960|1600|2560)\.webp|original\.(mp4|mov|webm))$'
    else '^' || v_a.domain || '/' || v_a.id::text || '/w(480|960|1600|2560)\.webp$' end;
  v_private_re := '^(staging|objects)/' || v_a.domain || '/' || v_a.id::text
    || '/original\.(jpg|png|webp|heic|heif|avif|mp4|mov|webm)$';
  with pub as (
    select k from (
      select storage_key k from public.media_asset_variants where asset_id = v_a.id
      union select v_a.storage_key
      union select v_a.domain || '/' || v_a.id::text || '/w' || w || '.webp'
        from unnest(array['480','960','1600','2560']) w
      union select 'community/' || v_a.id::text || '/original.' || e
        from unnest(array['mp4','mov','webm']) e where v_a.domain = 'community'
    ) s where k is not null),
  priv as (select v_a.private_original_key k where v_a.private_original_key is not null)
  select
    coalesce((select array_agg(k order by k) from pub where k ~ v_public_re), array[]::text[]),
    coalesce((select array_agg(k order by k) from priv where k ~ v_private_re), array[]::text[]),
    (select count(*) from pub where k !~ v_public_re) + (select count(*) from priv where k !~ v_private_re)
  into v_public, v_private, v_rejected;

  if v_a.multipart_upload_id is not null then
    if v_a.private_original_key is not null and v_a.private_original_key ~ v_private_re
      and length(v_a.multipart_upload_id) between 1 and 2048 then
      v_mp_id := v_a.multipart_upload_id;
      v_mp_key := v_a.private_original_key;
    else
      v_rejected := v_rejected + 1;
    end if;
  end if;

  return jsonb_build_object('valid', true, 'assetId', v_a.id, 'domain', v_a.domain, 'kind', v_a.kind,
    'publicKeys', to_jsonb(v_public), 'privateKeys', to_jsonb(v_private), 'rejectedKeys', v_rejected,
    'multipartUploadId', to_jsonb(v_mp_id), 'multipartKey', to_jsonb(v_mp_key));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. community_asset_gc_multipart_cleared
--    Limpia el identificador SOLO si: la fila existe, está 'deleting', el claim_token coincide y su
--    lease sigue vivo, y el identificador guardado es EXACTAMENTE el que se abortó. Idempotente:
--    si el aborto funcionó pero esta llamada falló, el reintento (nuevo claim) vuelve a abortar
--    (NoSuchUpload = éxito) y obtiene 'cleared' o 'already_cleared'.
-- ---------------------------------------------------------------------------------------------
create function public.community_asset_gc_multipart_cleared(
  p_asset_id uuid, p_claim_token uuid, p_upload_id text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_a public.media_assets%rowtype;
begin
  if p_asset_id is null or p_claim_token is null or p_upload_id is null or p_upload_id = '' then
    raise exception 'invalid_argument';
  end if;
  select * into v_a from public.media_assets where id = p_asset_id for update;
  if not found then return jsonb_build_object('result', 'already_gone'); end if;
  if v_a.status <> 'deleting' or v_a.purge_claim_token is distinct from p_claim_token
    or v_a.purge_lease_until is null or v_a.purge_lease_until <= clock_timestamp() then
    return jsonb_build_object('result', 'invalid_claim');
  end if;
  if v_a.multipart_upload_id is null then return jsonb_build_object('result', 'already_cleared'); end if;
  if v_a.multipart_upload_id <> p_upload_id then
    return jsonb_build_object('result', 'upload_id_changed');
  end if;
  update public.media_assets set multipart_upload_id = null where id = p_asset_id;
  return jsonb_build_object('result', 'cleared');
end;
$$;
alter function public.community_asset_gc_multipart_cleared(uuid, uuid, text) owner to postgres;
revoke all on function public.community_asset_gc_multipart_cleared(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.community_asset_gc_multipart_cleared(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. community_asset_gc_finalize: idéntica a 20261020 + negativa con multipart pendiente
-- ---------------------------------------------------------------------------------------------
create or replace function public.community_asset_gc_finalize(p_asset_id uuid, p_claim_token uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  if p_asset_id is null or p_claim_token is null then raise exception 'invalid_argument'; end if;
  if exists (
    select 1 from public.media_assets
     where id = p_asset_id and status = 'deleting' and purge_claim_token = p_claim_token
       and multipart_upload_id is not null
  ) then
    perform public.community_asset_gc_fail(p_asset_id, p_claim_token, 'multipart_pending');
    return jsonb_build_object('result', 'multipart_pending');
  end if;
  begin
    delete from public.media_assets
     where id = p_asset_id and status = 'deleting' and purge_claim_token = p_claim_token
    returning id into v_id;
  exception when foreign_key_violation then
    perform public.community_asset_gc_fail(p_asset_id, p_claim_token, 'asset_referenced');
    return jsonb_build_object('result', 'blocked');
  end;
  if v_id is not null then return jsonb_build_object('result', 'deleted'); end if;
  if exists (select 1 from public.media_assets where id = p_asset_id)
    then return jsonb_build_object('result', 'invalid_claim'); end if;
  return jsonb_build_object('result', 'already_gone');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Barrera BEFORE DELETE: ningún camino (inline, rollback de reserve, SQL manual) puede borrar un
--    asset con una sesión multipart sin abortar. Una cascada hacia media_assets no existe (los
--    hijos cuelgan del asset, no al revés), así que solo afecta a DELETE directos.
-- ---------------------------------------------------------------------------------------------
create function public.media_assets_block_delete_open_multipart() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'media_asset_multipart_open' using errcode = '23001';
end;
$$;
alter function public.media_assets_block_delete_open_multipart() owner to postgres;
revoke all on function public.media_assets_block_delete_open_multipart()
  from public, anon, authenticated, service_role;

create trigger media_assets_block_delete_open_multipart
  before delete on public.media_assets
  for each row when (old.multipart_upload_id is not null)
  execute function public.media_assets_block_delete_open_multipart();
