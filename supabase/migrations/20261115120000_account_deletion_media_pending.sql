-- DEL-2 (corrección): la etapa media_gc ahora lleva a limpieza TAMBIÉN los archivos propios con una subida sin terminar
-- (reserved, uploaded, verifying, processing).
--
-- Defecto: account_deletion_stage_media solo re-marcaba como 'deleting' los propios en 'ready'/'failed'. Un archivo 'reserved'
-- (subida iniciada y nunca completada, p. ej. por un fallo de red o de CORS) contaba como pendiente pero nada lo limpiaba:
-- solo el barrido de abandonados (media_abandoned_sweep, no programado) lo haría tras horas, y la eliminación se quedaba en
-- cleanup_retry_pending hasta pasar a intervención manual.
--
-- Corrección: misma transición que usa media_abandoned_sweep (<estado pendiente> -> 'deleting', failure_code = NULL), que es la que
-- el GC existente (media-gc.ts) ya recoge. Es segura porque la barrera de la cuenta impide completar subidas (requireAuthenticated
-- falla cerrado) y el UPDATE del asset exige su estado actual. Solo afecta a archivos de ESTA cuenta (created_by) y de Community,
-- sin referencias en publicaciones de Community ni de Cosplay.
--
-- CREATE OR REPLACE conserva propietario y EXECUTE (solo service_role). Rollback:
--   supabase/rollbacks/20261115120000_account_deletion_media_pending.rollback.sql
create or replace function public.account_deletion_stage_media(p_request_id uuid, p_worker text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid; v_ids uuid[]; v_pending integer; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_user := public.account_deletion_assert_running(p_request_id, p_worker, 'media_gc');
  update public.media_assets a set status = 'deleting', failure_code = null, updated_at = v_now
   where a.created_by = v_user and a.domain = 'community'
     and a.status in ('ready', 'failed', 'reserved', 'uploaded', 'verifying', 'processing')
     and not exists (select 1 from public.community_post_media pm where pm.asset_id = a.id)
     and not exists (select 1 from public.cosplay_post_images ci where ci.asset_id = a.id);
  select media_asset_ids into v_ids from public.account_deletion_requests where id = p_request_id;
  select count(*) into v_pending from public.media_assets a
   where a.id = any (v_ids)
      or (a.created_by = v_user and a.domain = 'community'
          and not exists (select 1 from public.cosplay_post_images ci where ci.asset_id = a.id));
  return jsonb_build_object('pending', v_pending);
end;
$$;
