-- R5-S1 (PROPUESTA, NO APLICADA): limpieza segura de medios abandonados. Forward-only.
--
-- Estado: pendiente de revisión. NO se ha ejecutado en DEV ni en Production. Nada de lo que define
-- este archivo se programa: no registra ningún job de pg_cron ni se invoca desde
-- community_media_purge_tick().
-- Aplicarlo no cambia el comportamiento hasta que otro bloque invoque las funciones.
--
-- Reutiliza la cola GC existente (media_assets.status = 'deleting', R4-E1/E2): estas funciones solo
-- MARCAN assets como 'deleting'. El borrado físico en R2 y el borrado de la fila siguen siendo del
-- motor GC (reintentos, backoff, lease), que conserva fila y claves hasta confirmar R2.
--
--   1. community_media_asset_discard  — descarte voluntario de un asset 'ready' propio y sin
--                                       referencias (POST /api/media/abort sobre un ready).
--   2. media_abandoned_sweep          — barrido de assets abandonados con edad mínima, reclamación
--                                       idempotente y revalidación bajo lock.
--   3. community_asset_gc_objects     — misma firma; añade las claves canónicas posibles del asset
--                                       para no dejar variantes subidas a R2 sin fila en BD.
--   0. media_assets_touch_activity    — trigger: refresca updated_at en CADA cambio de estado. El
--                                       pipeline no lo hacía (en DEV updated_at == created_at en
--                                       todas las filas), así que no había reloj de actividad.
--
-- Dependencias: 20261004 (community_post_media), 20261006 (video), 20261020 (cola GC purge_*).
-- Es independiente de 20261023–20261025 (strikes / account authority): puede aplicarse antes o
-- después. Orden recomendado en DEV: 20261023, 20261024, 20261025 y por último esta.
-- Producción: NO aplicar hasta que DEV Testing la haya validado.

-- ---------------------------------------------------------------------------------------------
-- 0. Reloj de actividad. Solo se dispara cuando CAMBIA el estado (reserved → uploaded → verifying →
--    processing → ready, failed → uploaded en un reintento, → deleting). No se dispara con las
--    escrituras del GC (claim/fail/lease), que no cambian el estado, para no alterar el orden de la
--    cola. Las filas históricas conservan su updated_at (== created_at): para ellas el reloj es la
--    creación, que es el criterio conservador.
-- ---------------------------------------------------------------------------------------------
create function public.media_assets_touch_activity() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
alter function public.media_assets_touch_activity() owner to postgres;
revoke all on function public.media_assets_touch_activity()
  from public, anon, authenticated, service_role;

create trigger media_assets_touch_activity
  before update on public.media_assets
  for each row when (old.status is distinct from new.status)
  execute function public.media_assets_touch_activity();

-- ---------------------------------------------------------------------------------------------
-- 1. Descarte voluntario de un asset ready sin publicación
--    Bloquea la fila del asset ANTES de mirar referencias. community_post_save y
--    community_post_save_atomic bloquean los assets nuevos FOR UPDATE y exigen status='ready': si
--    el guardado gana, aquí se ve la referencia ('referenced'); si el descarte gana, el guardado
--    falla porque el asset ya no está 'ready'. No hay ventana intermedia.
-- ---------------------------------------------------------------------------------------------
create function public.community_media_asset_discard(p_asset_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_a public.media_assets%rowtype;
begin
  if p_asset_id is null or p_actor_user_id is null then raise exception 'invalid_argument'; end if;

  select * into v_a from public.media_assets where id = p_asset_id for update;
  -- Ajeno e inexistente son indistinguibles para el llamador.
  if not found or v_a.domain <> 'community' or v_a.created_by is distinct from p_actor_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_a.status = 'deleting' then return jsonb_build_object('result', 'already_deleting'); end if;
  if v_a.status <> 'ready' then return jsonb_build_object('result', 'not_ready'); end if;
  if exists (select 1 from public.community_post_media m where m.asset_id = v_a.id)
    or exists (select 1 from public.cosplay_post_images i where i.asset_id = v_a.id) then
    return jsonb_build_object('result', 'referenced');
  end if;

  update public.media_assets
     set status = 'deleting', failure_code = null, updated_at = clock_timestamp()
   where id = v_a.id;
  return jsonb_build_object('result', 'marked');
end;
$$;
alter function public.community_media_asset_discard(uuid, uuid) owner to postgres;
revoke all on function public.community_media_asset_discard(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.community_media_asset_discard(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Barrido de abandonados (NO programado)
--    La edad se mide desde updated_at, el reloj de actividad que mantiene el trigger de arriba: un
--    ready cuenta desde que LLEGÓ a ready, y un failed reintentado o un asset en procesado cuentan
--    desde su última transición (nunca desde la reserva original). Mínimos duros para que un
--    argumento erróneo no pueda reclamar trabajo en curso:
--      ready   >= 6 h  (defecto 72 h: un editor abierto con medios ya subidos; si caducara, el
--                       guardado falla con media_not_ready y se vuelve a subir: sin pérdida de
--                       contenido publicado)
--      pending >= 2 h  (defecto 24 h: reserved/uploaded/verifying/processing; un vídeo de 100 MB
--                       subiendo y procesando termina en minutos)
--      failed  >= 6 h  (defecto 72 h: el usuario puede reintentar failed → uploaded)
--    No se añade heartbeat/lease de cliente: sería un endpoint nuevo y la ventana de 72 h tras la
--    última actividad de pipeline ya cubre la edición normal.
--    Un ready solo es elegible sin ninguna referencia en community_post_media NI cosplay_post_images.
--    Los ready de Cosplay quedan fuera salvo p_include_cosplay_ready = true (la galería de Cosplay
--    es curada por ADMIN: un ready sin publicar puede ser material preparado, no abandono).
--    Idempotente: solo toca filas en estados elegibles; las ya 'deleting' no se vuelven a tocar.
-- ---------------------------------------------------------------------------------------------
create function public.media_abandoned_sweep(
  p_ready_min_age interval default interval '72 hours',
  p_pending_min_age interval default interval '24 hours',
  p_failed_min_age interval default interval '72 hours',
  p_limit integer default 50,
  p_include_cosplay_ready boolean default false
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_cand record;
  v_a public.media_assets%rowtype;
  v_ready integer := 0;
  v_pending integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
begin
  if p_ready_min_age is null or p_pending_min_age is null or p_failed_min_age is null
    or p_limit is null or p_include_cosplay_ready is null
    or p_ready_min_age < interval '6 hours'
    or p_pending_min_age < interval '2 hours'
    or p_failed_min_age < interval '6 hours'
    or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_argument';
  end if;

  for v_cand in
    select a.id from public.media_assets a
     where a.domain in ('community', 'cosplay')
       and (
         (a.status = 'ready' and a.updated_at <= v_now - p_ready_min_age
           and (a.domain = 'community' or p_include_cosplay_ready)
           -- Excluir los referenciados EN LA SELECCIÓN: si no, los ready ya publicados (los más
           -- numerosos y antiguos) agotarían el límite y los abandonados nunca llegarían a ser
           -- candidatos. La revalidación bajo lock de abajo sigue siendo la barrera autoritativa.
           and not exists (select 1 from public.community_post_media m where m.asset_id = a.id)
           and not exists (select 1 from public.cosplay_post_images i where i.asset_id = a.id))
         or (a.status in ('reserved', 'uploaded', 'verifying', 'processing')
           and a.updated_at <= v_now - p_pending_min_age)
         or (a.status = 'failed' and a.updated_at <= v_now - p_failed_min_age))
     order by a.updated_at, a.id
     limit p_limit
     for update skip locked
  loop
    -- Revalidación bajo lock: el estado y las referencias pudieron cambiar desde la selección.
    select * into v_a from public.media_assets where id = v_cand.id for update;
    if not found or v_a.status = 'deleting' then v_skipped := v_skipped + 1; continue; end if;
    if v_a.status = 'ready' and (
      exists (select 1 from public.community_post_media m where m.asset_id = v_a.id)
      or exists (select 1 from public.cosplay_post_images i where i.asset_id = v_a.id)) then
      v_skipped := v_skipped + 1; continue;
    end if;

    update public.media_assets
       set status = 'deleting', failure_code = null, updated_at = v_now
     where id = v_a.id;
    if v_a.status = 'ready' then v_ready := v_ready + 1;
    elsif v_a.status = 'failed' then v_failed := v_failed + 1;
    else v_pending := v_pending + 1; end if;
  end loop;

  return jsonb_build_object('readyMarked', v_ready, 'pendingMarked', v_pending,
    'failedMarked', v_failed, 'skipped', v_skipped, 'serverNow', v_now);
end;
$$;
alter function public.media_abandoned_sweep(interval, interval, interval, integer, boolean)
  owner to postgres;
revoke all on function public.media_abandoned_sweep(interval, interval, interval, integer, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.media_abandoned_sweep(interval, interval, interval, integer, boolean)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Claves del GC: además de las filas del asset (variantes + storage_key), las claves canónicas
--    que el pipeline PUEDE haber escrito en R2 antes de registrar la fila (las variantes se suben
--    antes del INSERT en media_asset_variants). Borrar una clave inexistente es un éxito
--    idempotente. Todas llevan el id del asset y pasan el mismo regex de propiedad.
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
  return jsonb_build_object('valid', true, 'assetId', v_a.id, 'domain', v_a.domain, 'kind', v_a.kind,
    'publicKeys', to_jsonb(v_public), 'privateKeys', to_jsonb(v_private), 'rejectedKeys', v_rejected);
end;
$$;
