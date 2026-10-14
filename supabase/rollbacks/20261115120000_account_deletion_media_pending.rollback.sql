-- Rollback de 20261115120000_account_deletion_media_pending.sql: restaura la versión de 20261113120000 (solo ready/failed).
-- Efecto: las eliminaciones con subidas reservadas vuelven a depender del barrido de abandonados. No toca datos.
create or replace function public.account_deletion_stage_media(p_request_id uuid, p_worker text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid; v_ids uuid[]; v_pending integer; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_user := public.account_deletion_assert_running(p_request_id, p_worker, 'media_gc');
  update public.media_assets a set status = 'deleting', updated_at = v_now
   where a.created_by = v_user and a.domain = 'community' and a.status in ('ready', 'failed')
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
