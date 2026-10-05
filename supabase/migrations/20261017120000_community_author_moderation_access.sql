-- R4-C: owner application reads and acknowledgement only. No backfill/purge/media ACL changes.
create function public.community_author_posts_read(
  p_actor_user_id uuid, p_post_id uuid default null, p_profile_entry boolean default false
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_now timestamptz := clock_timestamp(); v_items jsonb; v_notice uuid;
begin
  if p_actor_user_id is null or p_profile_entry is null then raise exception 'invalid_argument'; end if;
  if not exists(select 1 from auth.users where id=p_actor_user_id) then raise exception 'unauthenticated'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'text',p.text,'status',p.status,'version',p.version,
    'createdAt',p.created_at,'updatedAt',p.updated_at,'likeCount',p.like_count,
    'author',jsonb_build_object('username',f.username,'displayName',f.display_name),
    'moderation',jsonb_build_object(
      'kind',case p.status when 'hidden_pending_review' then 'paused' when 'removed_pending_purge' then 'withdrawn' else 'none' end,
      'deadline',case when p.status='removed_pending_purge' then p.purge_after else null end,
      'message',case when p.status='removed_pending_purge' then d.resolution_message else null end),
    'media',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'assetId',m.asset_id,'position',m.position) order by m.position,m.id)
      from public.community_post_media m where m.post_id=p.id),'[]'::jsonb)
  ) order by p.created_at desc,p.id desc),'[]'::jsonb) into v_items
  from public.community_posts p join public.profiles f on f.user_id=p.author_user_id
  left join public.community_moderation_decisions d on d.id=p.removal_decision_id and d.post_id=p.id and d.decision='content_actioned'
  where p.author_user_id=p_actor_user_id and (p_post_id is null or p.id=p_post_id)
    and (p.status in ('published','hidden_pending_review')
      -- Preserve legacy own-list management of hidden; do not introduce hidden detail access.
      or (p.status='hidden' and p_post_id is null)
      or (p.status='removed_pending_purge' and v_now < p.purge_after and d.id is not null));
  if p_post_id is not null and p_profile_entry and exists(select 1 from public.community_posts
      where id=p_post_id and author_user_id=p_actor_user_id and status='published') then
    select n.id into v_notice from public.community_moderation_author_notices n
      join public.community_moderation_decisions d on d.id=n.decision_id and d.post_id=n.post_id
      where n.owner_user_id=p_actor_user_id and n.post_id=p_post_id and n.seen_at is null
        and n.notice_type='reports_not_valid' and d.decision='reports_not_valid'
        and d.resulting_post_status='published'
      order by n.created_at,n.id limit 1;
  end if;
  return jsonb_build_object('items',v_items,'serverNow',v_now,'noticeId',v_notice);
end;
$$;
alter function public.community_author_posts_read(uuid,uuid,boolean) owner to postgres;
revoke all on function public.community_author_posts_read(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.community_author_posts_read(uuid,uuid,boolean) to service_role;

create function public.community_author_notice_ack(p_actor_user_id uuid,p_post_id uuid,p_notice_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_notice public.community_moderation_author_notices%rowtype;
begin
  if p_actor_user_id is null or p_post_id is null or p_notice_id is null then raise exception 'invalid_argument'; end if;
  if not exists(select 1 from auth.users where id=p_actor_user_id) then raise exception 'unauthenticated'; end if;
  -- Same post-first discipline as Community writes; acknowledgement never locks a case/report.
  perform 1 from public.community_posts where id=p_post_id and author_user_id=p_actor_user_id
    and status='published' for share;
  if not found then raise exception 'not_found'; end if;
  select n.* into v_notice from public.community_moderation_author_notices n
    join public.community_moderation_decisions d on d.id=n.decision_id and d.post_id=n.post_id
    where n.id=p_notice_id and n.post_id=p_post_id and n.owner_user_id=p_actor_user_id
      and n.notice_type='reports_not_valid' and d.decision='reports_not_valid'
      and d.resulting_post_status='published' for update of n;
  if not found then raise exception 'not_found'; end if;
  if v_notice.seen_at is null then
    update public.community_moderation_author_notices set seen_at=clock_timestamp() where id=v_notice.id;
  end if;
  return jsonb_build_object('acknowledged',true);
end;
$$;
alter function public.community_author_notice_ack(uuid,uuid,uuid) owner to postgres;
revoke all on function public.community_author_notice_ack(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.community_author_notice_ack(uuid,uuid,uuid) to service_role;
