-- LOCAL ONLY: acquire / begin effective processing / administrative defer.
-- Apply atomically after 20261123. No budget tables, provider, scheduler or Community writes.
alter table public.community_shadow_jobs
  add column attempt_claim_token uuid,
  add column administrative_defer_reason text check (administrative_defer_reason in ('quota_exhausted','cooldown_active'));

-- Legacy claims already authorized an attempt. Preserve all consumed counts and in-flight tokens.
update public.community_shadow_jobs set attempt_claim_token=claim_token
  where state='processing' and attempts>0;
alter table public.community_shadow_jobs add constraint community_shadow_jobs_attempt_claim_check
  check (attempt_claim_token is null or (state='processing' and attempts>0 and claim_token is not null
    and attempt_claim_token=claim_token));

-- Existing capture, cancellation and maintenance also clear the authorization marker.
-- A local BEFORE trigger avoids changing any F4-A functions or their callers.
create function community_shadow_private.clear_attempt_claim() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.state <> 'processing' or new.claim_token is null or new.claim_token is distinct from old.claim_token then
    new.attempt_claim_token:=null;
  end if;
  return new;
end $$;
create trigger community_shadow_clear_attempt_claim before update on public.community_shadow_jobs
  for each row execute function community_shadow_private.clear_attempt_claim();

create function community_shadow_private.acquire(p_limit integer default 2, p_lease_seconds integer default 60)
returns setof public.community_shadow_jobs
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_limit is null or p_limit not between 1 and 10 or p_lease_seconds is null
    or p_lease_seconds not between 10 and 300 then raise exception 'invalid_argument'; end if;
  perform public.community_shadow_maintain(100);
  with due as (select j.id from public.community_shadow_jobs j where j.obsolete_at is null
      and j.state in ('queued','retry_wait','processing') and j.attempts >= 3
      and (j.lease_until is null or j.lease_until <= clock_timestamp()) order by j.id for update skip locked limit 100)
    update public.community_shadow_jobs j set state='failed',last_error_code='attempts_exhausted',snapshot_text=null,
      claim_token=null,lease_until=null,updated_at=clock_timestamp() from due where j.id=due.id;
  return query with due as (
    select j.id from public.community_shadow_jobs j where j.environment='dev' and j.obsolete_at is null
      and j.snapshot_expires_at > clock_timestamp() and j.retain_until > clock_timestamp() and j.attempts < 3
      and ((j.state in ('queued','retry_wait') and j.next_attempt_at <= clock_timestamp())
        or (j.state='processing' and j.lease_until <= clock_timestamp()))
      and community_shadow_private.is_current(j)
      order by j.next_attempt_at,j.created_at,j.id for update skip locked limit p_limit
  ) update public.community_shadow_jobs j set state='processing',attempt_claim_token=null,administrative_defer_reason=null,
    lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),claim_token=gen_random_uuid(),
    updated_at=clock_timestamp() from due where j.id=due.id returning j.*;
end $$;

-- New protocol: claim ownership without authorizing or consuming an effective attempt.
create function public.community_shadow_acquire(p_limit integer default 2, p_lease_seconds integer default 60)
returns setof public.community_shadow_jobs language sql security definer set search_path = pg_catalog, public as $$
  select * from community_shadow_private.acquire(p_limit,p_lease_seconds)
$$;

-- Legacy F4-B: the same signature still acquires AND starts atomically. This is not a free claim.
create or replace function public.community_shadow_claim(p_limit integer default 2, p_lease_seconds integer default 60)
returns setof public.community_shadow_jobs language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.community_shadow_jobs%rowtype;
begin
  for j in select * from community_shadow_private.acquire(p_limit,p_lease_seconds) loop
    update public.community_shadow_jobs q set attempts=q.attempts+1,attempt_claim_token=q.claim_token,
      updated_at=clock_timestamp() where q.id=j.id returning q.* into j;
    return next j;
  end loop;
end $$;

create function public.community_shadow_attempt_start(p_job_id uuid,p_claim_token uuid) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.community_shadow_jobs%rowtype;
begin
  if p_job_id is null or p_claim_token is null then raise exception 'invalid_argument'; end if;
  select * into j from public.community_shadow_jobs where id=p_job_id;
  if not found then return 'not_found'; end if;
  begin
    perform 1 from public.community_posts where id=j.post_id for share nowait;
    if not found then return 'not_found'; end if;
    select * into j from public.community_shadow_jobs where id=p_job_id for update nowait;
    if not found then return 'not_found'; end if;
  exception when lock_not_available then return 'busy'; end;
  if j.state <> 'processing' or j.claim_token <> p_claim_token or j.lease_until <= clock_timestamp()
    or j.snapshot_expires_at <= clock_timestamp() or j.retain_until <= clock_timestamp()
    then return 'stale_claim'; end if;
  if j.obsolete_at is not null or not community_shadow_private.is_current(j) then return 'obsolete'; end if;

  if j.attempt_claim_token=p_claim_token then return 'already_started'; end if;
  if j.attempts>=3 then
    update public.community_shadow_jobs set state='failed',last_error_code='attempts_exhausted',snapshot_text=null,
      claim_token=null,lease_until=null,updated_at=clock_timestamp() where id=j.id;
    return 'attempts_exhausted';
  end if;
  update public.community_shadow_jobs set attempts=attempts+1,attempt_claim_token=p_claim_token,
    administrative_defer_reason=null,updated_at=clock_timestamp() where id=j.id;
  return 'started';
end $$;

create function public.community_shadow_defer(p_job_id uuid,p_claim_token uuid,p_resume_at timestamptz,p_reason text)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.community_shadow_jobs%rowtype;
begin
  if p_resume_at is null or not isfinite(p_resume_at) or p_resume_at<=clock_timestamp()
    or p_resume_at>clock_timestamp()+interval '25 hours' or p_reason is null
    or p_reason not in ('quota_exhausted','cooldown_active') then raise exception 'invalid_deferral'; end if;

  if p_job_id is null or p_claim_token is null then raise exception 'invalid_argument'; end if;
  select * into j from public.community_shadow_jobs where id=p_job_id;
  if not found then return 'not_found'; end if;
  begin
    perform 1 from public.community_posts where id=j.post_id for share nowait;
    if not found then return 'not_found'; end if;
    select * into j from public.community_shadow_jobs where id=p_job_id for update nowait;
    if not found then return 'not_found'; end if;
  exception when lock_not_available then return 'busy'; end;
  if j.state <> 'processing' or j.claim_token <> p_claim_token or j.lease_until <= clock_timestamp()
    or j.snapshot_expires_at <= clock_timestamp() or j.retain_until <= clock_timestamp()
    then return 'stale_claim'; end if;
  if j.obsolete_at is not null or not community_shadow_private.is_current(j) then return 'obsolete'; end if;

  if p_resume_at>=least(j.snapshot_expires_at,j.retain_until) then
    update public.community_shadow_jobs set state='expired',snapshot_text=null,claim_token=null,lease_until=null,
      administrative_defer_reason=p_reason,updated_at=clock_timestamp() where id=j.id;
    return 'expired';
  end if;
  if j.attempts>=3 then
    update public.community_shadow_jobs set state='failed',last_error_code='attempts_exhausted',snapshot_text=null,
      claim_token=null,lease_until=null,administrative_defer_reason=p_reason,updated_at=clock_timestamp() where id=j.id;
    return 'attempts_exhausted';
  end if;
  update public.community_shadow_jobs set state='retry_wait',next_attempt_at=p_resume_at,
    claim_token=null,lease_until=null,last_error_code=null,administrative_defer_reason=p_reason,
    updated_at=clock_timestamp() where id=j.id;
  return 'deferred';
end $$;

create or replace function public.community_shadow_finish(p_job_id uuid, p_claim_token uuid, p_state text,
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
  if j.attempt_claim_token is distinct from p_claim_token then return 'attempt_not_started'; end if;
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

-- No table or column privileges are added. Preserve forced RLS, no policies, and private helpers.
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='community_shadow_private' and p.proname in ('acquire','clear_attempt_claim'))
      or (n.nspname='public' and p.proname in ('community_shadow_acquire','community_shadow_claim',
        'community_shadow_attempt_start','community_shadow_defer','community_shadow_finish'))
  loop
    execute format('alter function %s owner to postgres',f.signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end $$;
grant execute on function public.community_shadow_acquire(integer,integer), public.community_shadow_claim(integer,integer),
  public.community_shadow_attempt_start(uuid,uuid), public.community_shadow_defer(uuid,uuid,timestamptz,text),
  public.community_shadow_finish(uuid,uuid,text,jsonb,text,integer) to service_role;
comment on column public.community_shadow_jobs.attempts is
  'Monotonic effective processing authorizations (0..3), not acquisitions or provider requests. Legacy claim starts immediately. No refunds.';
comment on function public.community_shadow_defer(uuid,uuid,timestamptz,text) is
  'DEV administrative deferral: valid live claim only, bounded future UTC instant, never decrements attempts or extends snapshot TTL. Not a budget authority.';
