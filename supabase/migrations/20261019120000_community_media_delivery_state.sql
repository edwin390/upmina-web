-- R4-D1: read-only delivery classification for Community media. Server-to-server only (service_role).
-- Returns a minimal semantic projection; never owner, post id, report/case/decision data or storage keys.
create function public.community_media_delivery_state(p_asset_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_domain text; v_status text; v_post_status text; v_purge_after timestamptz; v_attached boolean;
  v_denied constant jsonb := jsonb_build_object('exists',false,'domain',null,'delivery','denied','privateUntil',null);
begin
  if p_asset_id is null then raise exception 'invalid_argument'; end if;
  select a.domain, a.status into v_domain, v_status from public.media_assets a where a.id = p_asset_id;
  -- Missing assets and any non-Community domain are indistinguishable from each other.
  if not found or v_domain is distinct from 'community' then return v_denied; end if;
  -- Only fully processed assets can be delivered; reserved/processing/failed/deleting never are.
  if v_status is distinct from 'ready' then
    return jsonb_build_object('exists',true,'domain','community','delivery','denied','privateUntil',null);
  end if;
  select true, p.status, p.purge_after into v_attached, v_post_status, v_purge_after
    from public.community_post_media m join public.community_posts p on p.id = m.post_id
    where m.asset_id = p_asset_id;
  if not coalesce(v_attached, false) then
    -- Ready but not attached yet (editor preview): never public; only a creator-preview capability.
    return jsonb_build_object('exists',true,'domain','community','delivery','private','privateUntil',null);
  end if;
  if v_post_status = 'published' then
    return jsonb_build_object('exists',true,'domain','community','delivery','public','privateUntil',null);
  elsif v_post_status = 'hidden_pending_review' then
    return jsonb_build_object('exists',true,'domain','community','delivery','private','privateUntil',null);
  elsif v_post_status = 'removed_pending_purge' and v_purge_after is not null and v_now < v_purge_after then
    return jsonb_build_object('exists',true,'domain','community','delivery','private','privateUntil',v_purge_after);
  end if;
  return jsonb_build_object('exists',true,'domain','community','delivery','denied','privateUntil',null);
end;
$$;
alter function public.community_media_delivery_state(uuid) owner to postgres;
revoke all on function public.community_media_delivery_state(uuid) from public, anon, authenticated;
grant execute on function public.community_media_delivery_state(uuid) to service_role;
