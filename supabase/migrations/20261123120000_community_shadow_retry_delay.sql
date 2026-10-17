-- Local-only retry contract extension. Apply transactionally after F4-A.
-- Input argument types define identity: remove the old signature, never leave an overload.
-- RESTRICT intentionally fails on unexpected catalog dependencies; do not use CASCADE.
drop function public.community_shadow_finish(uuid,uuid,text,jsonb,text) restrict;

create function public.community_shadow_finish(p_job_id uuid, p_claim_token uuid, p_state text,
  p_results jsonb default '[]', p_error_code text default null,
  p_retry_delay_seconds integer default null) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.community_shadow_jobs%rowtype; r jsonb; a uuid; n_text integer; n_images integer;
  ok_text integer; ok_images integer; videos integer; v_coverage jsonb; overall text;
  retry_floor integer; retry_delay integer; retry_at timestamptz;
begin
  if p_job_id is null or p_claim_token is null or p_state is null
    or p_state not in ('completed','partial','failed','retry_wait')
    or p_results is null or jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results)>11
    then raise exception 'invalid_argument'; end if;
  -- A delay is meaningful only for retry_wait; never accept negative/huge client scheduling values.
  if p_retry_delay_seconds is not null and (p_state <> 'retry_wait'
    or p_retry_delay_seconds not between 1 and 3600) then raise exception 'invalid_retry_delay'; end if;
  select * into j from public.community_shadow_jobs where id=p_job_id;
  if not found then return 'not_found'; end if;
  -- Canonical content lock order: parent post before queue job. Hold it through finalization,
  -- so a version change/human decision cannot commit between is_current and result insertion.
  -- Never wait while holding the parent lock for an already-busy job; return a retryable outcome.
  begin
    perform 1 from public.community_posts where id=j.post_id for share nowait;
    if not found then return 'not_found'; end if;
    select * into j from public.community_shadow_jobs where id=p_job_id for update nowait;
    if not found then return 'not_found'; end if;
  exception when lock_not_available then return 'busy';
  end;
  if j.state <> 'processing' or j.claim_token <> p_claim_token or j.lease_until <= clock_timestamp()
    or j.snapshot_expires_at <= clock_timestamp() or j.retain_until <= clock_timestamp()
    then return 'stale_claim'; end if;
  if j.obsolete_at is not null or not community_shadow_private.is_current(j) then return 'obsolete'; end if;
  -- Validate before inserting any component results. The third attempt still terminates as failed.
  if p_state='retry_wait' and j.attempts < 3 then
    retry_floor := least(300,5*(2^j.attempts)::integer);
    retry_delay := coalesce(p_retry_delay_seconds,retry_floor);
    if retry_delay < retry_floor then raise exception 'invalid_retry_delay'; end if;
    retry_at := clock_timestamp()+make_interval(secs=>retry_delay);
    if retry_at >= least(j.snapshot_expires_at,j.retain_until) then
      raise exception 'retry_after_expiry';
    end if;
  end if;
  -- All fields are allowlisted; raw provider errors, URLs, credentials and arbitrary metadata are refused.
  for r in select value from jsonb_array_elements(p_results) loop
    if jsonb_typeof(r)<>'object' or exists (select 1 from jsonb_object_keys(r) k where k not in
      ('component_kind','asset_id','model_requested','model_returned','provider_response_id','flagged',
       'categories','category_scores','category_applied_input_types','latency_ms','error_code','state'))
      or coalesce(r->>'component_kind','') not in ('text','image') then raise exception 'invalid_argument'; end if;
    a := (r->>'asset_id')::uuid;
    if (r->>'component_kind'='text' and (a is not null or j.snapshot_text is null))
      or (r->>'component_kind'='image' and (a is null or not j.assets @>
        jsonb_build_array(jsonb_build_object('asset_id',a,'kind','image')))) then raise exception 'invalid_argument'; end if;
    insert into public.community_shadow_results(job_id,component_kind,asset_id,component_hash,model_requested,
      model_returned,provider_response_id,flagged,categories,category_scores,category_applied_input_types,
      latency_ms,error_code,state)
    values(j.id,r->>'component_kind',a,community_shadow_private.fingerprint(
      case when a is null then j.snapshot_text end,case when a is null then '[]'::jsonb else
        jsonb_build_array(jsonb_build_object('asset_id',a,'kind','image','position',0)) end),
      r->>'model_requested',r->>'model_returned',r->>'provider_response_id',(r->>'flagged')::boolean,
      coalesce(r->'categories','{}'),coalesce(r->'category_scores','{}'),coalesce(r->'category_applied_input_types','{}'),
      (r->>'latency_ms')::integer,r->>'error_code',r->>'state');
  end loop;
  n_text := case when j.snapshot_text is null then 0 else 1 end;
  select count(*) filter (where value->>'kind'='image'),count(*) filter (where value->>'kind'='video')
    into n_images,videos from jsonb_array_elements(j.assets);
  select count(*) filter(where component_kind='text' and state='succeeded'),
    count(*) filter(where component_kind='image' and state='succeeded') into ok_text,ok_images
    from public.community_shadow_results where job_id=j.id;
  overall := case when n_text+n_images=0 and videos=0 then 'not_applicable'
    when n_text+n_images=0 then 'unsupported_video'
    when ok_text=n_text and ok_images=n_images and videos=0 then 'complete'
    when ok_text+ok_images>0 then 'partial' else 'failed' end;
  v_coverage := jsonb_build_object('overall',overall,
    'text',case when n_text=0 then 'not_applicable' when ok_text=1 then 'complete' else 'failed' end,
    'images',case when n_images=0 then 'not_applicable' when ok_images=n_images then 'complete'
      when ok_images>0 then 'partial' else 'failed' end,
    'video',case when videos>0 then 'unsupported_video' else 'not_applicable' end);
  if (p_state='completed' and overall not in ('complete','not_applicable'))
    or (p_state='partial' and overall not in ('partial','unsupported_video')) then raise exception 'invalid_coverage'; end if;
  if p_state='retry_wait' and j.attempts>=3 then p_state:='failed'; end if;
  -- Retry attempts replace results atomically; a failed call cannot leave a partial result set.
  if p_state='retry_wait' then delete from public.community_shadow_results where job_id=j.id; end if;
  update public.community_shadow_jobs set state=p_state,coverage=v_coverage,last_error_code=p_error_code,
    next_attempt_at=case when p_state='retry_wait' then retry_at else next_attempt_at end,
    snapshot_text=case when p_state='retry_wait' then snapshot_text else null end,
    claim_token=null,lease_until=null,updated_at=clock_timestamp() where id=j.id;
  return 'finished';
end $$;

alter function public.community_shadow_finish(uuid,uuid,text,jsonb,text,integer) owner to postgres;
revoke all on function public.community_shadow_finish(uuid,uuid,text,jsonb,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.community_shadow_finish(uuid,uuid,text,jsonb,text,integer) to service_role;
comment on function public.community_shadow_finish(uuid,uuid,text,jsonb,text,integer) is
  'DEV shadow only. Optional retry delay: exponential floor through 3600s, before snapshot expiry. No content effects. Five-argument callers retain defaults; no old overload.';
