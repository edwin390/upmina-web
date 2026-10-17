-- F4-A: LOCAL ONLY. No provider, scheduler, moderation decisions or network operations.
-- Logical environment is deliberately fixed to DEV. Production requires a separate reviewed configuration.
-- Deferred triggers observe final transaction state, including save_atomic's reverted validation subtransaction.
create schema community_shadow_private;
revoke all on schema community_shadow_private from public, anon, authenticated, service_role;

create function community_shadow_private.valid_assets(a jsonb) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(a) <> 'array' then false else
    jsonb_array_length(a) between 0 and 10
    and not exists (select 1 from jsonb_array_elements(a) with ordinality x(e,n)
      where jsonb_typeof(e) <> 'object' or (select count(*) from jsonb_object_keys(e)) <> 3
        or coalesce(e->>'asset_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(e->>'kind','') not in ('image','video')
        or e->'position' is distinct from to_jsonb(n-1))
    and (select count(distinct e->>'asset_id') from jsonb_array_elements(a) e) = jsonb_array_length(a)
  end
$$;

create function community_shadow_private.valid_coverage(c jsonb) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(c) <> 'object' then false else
    (select count(*) from jsonb_object_keys(c)) = 4
    and c ?& array['overall','text','images','video']
    and not exists (select 1 from jsonb_each(c) x(k,v) where v <> 'null'::jsonb
      and (jsonb_typeof(v) <> 'string' or v #>> '{}' not in
        ('complete','partial','unsupported_video','failed','not_applicable')))
    and (c->'text' = 'null' or c->>'text' in ('complete','failed','not_applicable'))
    and (c->'images' = 'null' or c->>'images' in ('complete','partial','failed','not_applicable'))
    and (c->'video' = 'null' or c->>'video' in ('unsupported_video','not_applicable'))
  end
$$;

create table public.community_shadow_jobs (
  id uuid primary key default gen_random_uuid(),
  environment text not null default 'dev' check (environment = 'dev'),
  target_kind text not null check (target_kind in ('post','pending_edit')),
  post_id uuid not null references public.community_posts(id) on delete cascade,
  edit_id uuid references public.community_post_pending_edits(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version >= 1),
  base_version integer,
  snapshot_text text check (char_length(snapshot_text) between 1 and 2000
    and snapshot_text = normalize(btrim(snapshot_text), NFC)),
  assets jsonb not null check (community_shadow_private.valid_assets(assets)),
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  preprocessing_version text not null default 'community-webp-v1' check (preprocessing_version = 'community-webp-v1'),
  config_revision text not null default 'shadow-v1' check (config_revision ~ '^[a-zA-Z0-9._-]{1,64}$'),
  state text not null default 'queued' check (state in
    ('queued','processing','retry_wait','completed','partial','failed','cancelled','expired')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_until timestamptz,
  claim_token uuid,
  coverage jsonb not null default '{"overall":null,"text":null,"images":null,"video":null}',
  last_error_code text check (last_error_code in ('provider_timeout','provider_rate_limit',
    'provider_unavailable','invalid_input','auth_unavailable','asset_unavailable','internal_failure','attempts_exhausted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp(),
  snapshot_expires_at timestamptz not null,
  retain_until timestamptz not null default now() + interval '30 days',
  obsolete_at timestamptz,
  obsolete_reason text check (obsolete_reason in ('version_changed','edit_closed','asset_unavailable')),
  check ((target_kind = 'post' and edit_id is null and base_version is null)
    or (target_kind = 'pending_edit' and edit_id is not null and base_version = version)),
  check ((state = 'processing' and lease_until is not null and claim_token is not null)
    or (state <> 'processing' and lease_until is null and claim_token is null)),
  check ((obsolete_at is null) = (obsolete_reason is null)),
  check (snapshot_expires_at <= created_at + interval '24 hours'),
  check (retain_until <= created_at + interval '30 days'),
  check (community_shadow_private.valid_coverage(coverage)),
  check (state <> 'completed' or coalesce(coverage->>'overall' in ('complete','not_applicable'), false)),
  unique nulls not distinct (environment, target_kind, post_id, edit_id, version, snapshot_hash, config_revision)
);

create index community_shadow_jobs_due on public.community_shadow_jobs(next_attempt_at, created_at, id)
  where state in ('queued','retry_wait','processing') and obsolete_at is null;
create index community_shadow_jobs_author on public.community_shadow_jobs(author_user_id);
create index community_shadow_jobs_post on public.community_shadow_jobs(post_id);
create index community_shadow_jobs_edit on public.community_shadow_jobs(edit_id) where edit_id is not null;
create index community_shadow_jobs_expiry on public.community_shadow_jobs(snapshot_expires_at);
create index community_shadow_jobs_retention on public.community_shadow_jobs(retain_until);
create index community_shadow_jobs_assets on public.community_shadow_jobs using gin(assets jsonb_path_ops);

create function community_shadow_private.valid_categories(c jsonb, scores boolean) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(c) <> 'object' then false else
    not exists (select 1 from jsonb_each(c) x(k,v)
      where k not in ('harassment','harassment/threatening','hate','hate/threatening','illicit','illicit/violent',
        'self-harm','self-harm/intent','self-harm/instructions','sexual','sexual/minors','violence','violence/graphic')
      or case when scores then
        case when jsonb_typeof(v) <> 'number' then true else (v::text)::numeric not between 0 and 1 end
        else jsonb_typeof(v) <> 'boolean' and v <> 'null'::jsonb end)
  end
$$;
create function community_shadow_private.valid_input_types(c jsonb) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(c) <> 'object' then false else
    not exists (select 1 from jsonb_each(c) x(k,v)
      where not community_shadow_private.valid_categories(jsonb_build_object(k, true), false)
      or case when jsonb_typeof(v) <> 'array' then true else
        jsonb_array_length(v) > 2
        or (select count(distinct a) from jsonb_array_elements(v) a) <> jsonb_array_length(v)
        or exists (select 1 from jsonb_array_elements(v) a
          where a not in ('"text"'::jsonb,'"image"'::jsonb)
          or (a = '"image"'::jsonb and k in ('harassment','harassment/threatening','hate','hate/threatening',
            'illicit','illicit/violent','sexual/minors'))) end)
  end
$$;

create table public.community_shadow_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.community_shadow_jobs(id) on delete cascade,
  component_kind text not null check (component_kind in ('text','image')),
  asset_id uuid references public.media_assets(id) on delete cascade,
  component_hash text not null check (component_hash ~ '^[0-9a-f]{64}$'),
  model_requested text not null check (model_requested ~ '^[a-zA-Z0-9._-]{1,128}$'),
  model_returned text check (model_returned ~ '^[a-zA-Z0-9._-]{1,128}$'),
  provider_response_id text check (provider_response_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  flagged boolean,
  categories jsonb not null default '{}' check (community_shadow_private.valid_categories(categories, false)),
  category_scores jsonb not null default '{}' check (community_shadow_private.valid_categories(category_scores, true)),
  category_applied_input_types jsonb not null default '{}' check
    (community_shadow_private.valid_input_types(category_applied_input_types)),
  latency_ms integer check (latency_ms between 0 and 300000),
  error_code text check (error_code in ('provider_timeout','provider_rate_limit','provider_unavailable',
    'invalid_input','auth_unavailable','asset_unavailable','internal_failure')),
  state text not null check (state in ('succeeded','failed')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((component_kind = 'text' and asset_id is null) or (component_kind = 'image' and asset_id is not null)),
  check ((state = 'succeeded' and flagged is not null and model_returned is not null
    and provider_response_id is not null and error_code is null)
    or (state = 'failed' and flagged is null and error_code is not null and model_returned is null
      and provider_response_id is null and categories = '{}' and category_scores = '{}'
      and category_applied_input_types = '{}')),
  unique nulls not distinct (job_id, component_kind, asset_id)
);
create index community_shadow_results_asset on public.community_shadow_results(asset_id) where asset_id is not null;
alter table public.community_shadow_jobs enable row level security;
alter table public.community_shadow_jobs force row level security;
alter table public.community_shadow_results enable row level security;
alter table public.community_shadow_results force row level security;
revoke all on public.community_shadow_jobs, public.community_shadow_results from public, anon, authenticated, service_role;

-- The descriptor hash is NOT a hash of image bytes. Bytes/preprocessing evaluation belongs to F4-B.
create function community_shadow_private.fingerprint(t text, a jsonb) returns text
language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(jsonb_build_object('text', nullif(normalize(btrim(t), NFC), ''),
    'assets', a, 'preprocessing', 'community-webp-v1')::text, 'UTF8')), 'hex')
$$;

create function community_shadow_private.current_snapshot(k text, target uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare p public.community_posts%rowtype; e public.community_post_pending_edits%rowtype;
  a jsonb; t text; source_time timestamptz; ready boolean;
begin
  if k = 'post' then
    select * into p from public.community_posts where id = target;
    if not found or p.status not in ('published','held_for_review') then return null; end if;
    t := p.text; source_time := p.updated_at;
    select coalesce(jsonb_agg(jsonb_build_object('asset_id', m.asset_id, 'kind', x.kind,
      'position', m.position) order by m.position), '[]'), coalesce(bool_and(x.status = 'ready'
        and x.domain = 'community' and x.created_by is not distinct from p.author_user_id), true)
      into a, ready from public.community_post_media m join public.media_assets x on x.id = m.asset_id
      where m.post_id = p.id;
  elsif k = 'pending_edit' then
    select * into e from public.community_post_pending_edits where id = target and status = 'pending';
    if not found then return null; end if;
    select * into p from public.community_posts where id = e.post_id;
    if not found or p.status <> 'published' or p.version <> e.base_version then return null; end if;
    t := e.text; source_time := e.created_at;
    select coalesce(jsonb_agg(jsonb_build_object('asset_id', m.asset_id, 'kind', x.kind,
      'position', m.position) order by m.position), '[]'), coalesce(bool_and(x.status = 'ready'
        and x.domain = 'community' and x.created_by is not distinct from p.author_user_id), true)
      into a, ready from public.community_post_pending_edit_media m join public.media_assets x on x.id = m.asset_id
      where m.edit_id = e.id;
    if jsonb_array_length(a) <> e.media_count then return null; end if;
  else return null;
  end if;
  if not ready then return null; end if;
  t := nullif(normalize(btrim(t), NFC), '');
  return jsonb_build_object('post_id', p.id, 'edit_id', e.id, 'author', p.author_user_id,
    'version', p.version, 'text', t, 'assets', a, 'hash', community_shadow_private.fingerprint(t,a),
    'expires', least(source_time + interval '24 hours', now() + interval '24 hours'));
end $$;

create function community_shadow_private.is_current(j public.community_shadow_jobs) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((s->>'version')::integer = j.version and s->>'hash' = j.snapshot_hash, false)
  from (select community_shadow_private.current_snapshot(j.target_kind, coalesce(j.edit_id,j.post_id)) s) q
$$;

create function community_shadow_private.capture(k text, target uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public set lock_timeout = '100ms' as $$
declare s jsonb; inserted integer;
begin
  -- Capture failures roll back only this block. Parent content failures are never swallowed here.
  -- Serialize only shadow capture for this target, without waiting on another capture's UNIQUE insertion.
  if not pg_try_advisory_xact_lock(hashtextextended('upmina.community_shadow:' || k || ':' || target::text,0)) then
    return false;
  end if;
  s := community_shadow_private.current_snapshot(k,target);
  -- NOWAIT is deliberate: lock_timeout alone can lose to a shorter parent statement_timeout.
  with locked as materialized (select j.id from public.community_shadow_jobs j
    where j.target_kind = k and coalesce(j.edit_id,j.post_id) = target and j.obsolete_at is null
      and (s is null or j.version <> (s->>'version')::integer or j.snapshot_hash <> s->>'hash') for update nowait)
  update public.community_shadow_jobs j set obsolete_at = clock_timestamp(),
    obsolete_reason = case when k = 'pending_edit' and s is null and not exists
      (select 1 from public.community_post_pending_edits e where e.id=target and e.status='pending')
      then 'edit_closed' else 'version_changed' end,
    state = case when state in ('queued','processing','retry_wait') then 'cancelled' else state end,
    snapshot_text = null, lease_until = null, claim_token = null, updated_at = clock_timestamp()
    from locked where j.id = locked.id;
  if s is null or (s->>'expires')::timestamptz <= clock_timestamp() then return false; end if;
  if exists (select 1 from public.community_shadow_jobs j where j.environment='dev' and j.target_kind=k
    and j.post_id=(s->>'post_id')::uuid and j.edit_id is not distinct from (s->>'edit_id')::uuid
    and j.version=(s->>'version')::integer and j.snapshot_hash=s->>'hash' and j.config_revision='shadow-v1') then
    return false;
  end if;
  insert into public.community_shadow_jobs(target_kind, post_id, edit_id, author_user_id, version, base_version,
    snapshot_text, assets, snapshot_hash, snapshot_expires_at)
    values (k,(s->>'post_id')::uuid,(s->>'edit_id')::uuid,(s->>'author')::uuid,(s->>'version')::integer,
      case when k = 'pending_edit' then (s->>'version')::integer end,s->>'text',s->'assets',s->>'hash',
      (s->>'expires')::timestamptz) on conflict do nothing;
  get diagnostics inserted = row_count;
  return inserted = 1;
exception when others then
  -- No SQLERRM, content, object keys or identifiers. Server log only; no human audit mutation.
  raise warning 'community_shadow_capture_failed sqlstate=%', sqlstate;
  return false;
end $$;

create function community_shadow_private.capture_trigger() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare target uuid; k text;
begin
  if tg_table_name = 'community_posts' then
    target := new.id; k := 'post';
  elsif tg_table_name = 'community_post_media' then
    target := case when tg_op = 'DELETE' then old.post_id else new.post_id end; k := 'post';
  elsif tg_table_name = 'community_post_pending_edits' then
    target := new.id; k := 'pending_edit';
  else
    target := case when tg_op = 'DELETE' then old.edit_id else new.edit_id end; k := 'pending_edit';
  end if;
  perform community_shadow_private.capture(k,target);
  -- A post version/status change can obsolete a still-pending proposal too.
  if k = 'post' then
    perform community_shadow_private.capture('pending_edit',e.id)
      from public.community_post_pending_edits e where e.post_id = target and e.status = 'pending';
  end if;
  return null;
exception when others then
  raise warning 'community_shadow_capture_failed sqlstate=%', sqlstate;
  return null;
end $$;

create constraint trigger community_shadow_post_capture after insert or update on public.community_posts
  deferrable initially deferred for each row execute function community_shadow_private.capture_trigger();
create constraint trigger community_shadow_media_capture after insert or update or delete on public.community_post_media
  deferrable initially deferred for each row execute function community_shadow_private.capture_trigger();
create constraint trigger community_shadow_edit_capture after insert or update on public.community_post_pending_edits
  deferrable initially deferred for each row execute function community_shadow_private.capture_trigger();
create constraint trigger community_shadow_edit_media_capture after insert or update or delete on public.community_post_pending_edit_media
  deferrable initially deferred for each row execute function community_shadow_private.capture_trigger();

-- No FK from snapshots to assets: shadow must not hold up physical GC. On physical deletion,
-- erase the whole affected observation (including results), leaving no dangling asset IDs.
create function community_shadow_private.asset_lifecycle() returns trigger
language plpgsql security definer set search_path = pg_catalog, public set lock_timeout = '100ms' as $$
begin
  if tg_op = 'DELETE' then
    delete from public.community_shadow_jobs where assets @> jsonb_build_array(jsonb_build_object('asset_id',old.id));
    return old;
  end if;
  if old.status = 'ready' and new.status <> 'ready' then
    begin
      with locked as materialized (select id from public.community_shadow_jobs
        where obsolete_at is null and assets @> jsonb_build_array(jsonb_build_object('asset_id',new.id)) for update nowait)
      update public.community_shadow_jobs j set obsolete_at = clock_timestamp(), obsolete_reason = 'asset_unavailable',
        state = case when j.state in ('queued','processing','retry_wait') then 'cancelled' else j.state end,
        snapshot_text = null, lease_until = null, claim_token = null, updated_at = clock_timestamp()
        from locked where j.id=locked.id;
    exception when others then
      -- Status transitions are part of ordinary content saves too: never abort those for shadow.
      raise warning 'community_shadow_invalidation_failed sqlstate=%', sqlstate;
    end;
  end if;
  return new;
end $$;
create trigger community_shadow_asset_delete before delete on public.media_assets
  for each row execute function community_shadow_private.asset_lifecycle();
create trigger community_shadow_asset_status after update of status on public.media_assets
  for each row when (old.status is distinct from new.status) execute function community_shadow_private.asset_lifecycle();

create function public.community_shadow_maintain(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare scrubbed integer; removed integer;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_argument'; end if;
  with due as (select id from public.community_shadow_jobs where snapshot_expires_at <= clock_timestamp()
      and (snapshot_text is not null or state in ('queued','processing','retry_wait'))
      order by snapshot_expires_at,id for update skip locked limit p_limit)
    update public.community_shadow_jobs j set snapshot_text = null,
      state = case when state in ('queued','processing','retry_wait') then 'expired' else state end,
      lease_until = null, claim_token = null, updated_at = clock_timestamp() from due where j.id = due.id;
  get diagnostics scrubbed = row_count;
  with due as (select id from public.community_shadow_jobs where retain_until <= clock_timestamp()
      order by retain_until,id for update skip locked limit p_limit)
    delete from public.community_shadow_jobs j using due where j.id = due.id;
  get diagnostics removed = row_count;
  return jsonb_build_object('scrubbed',scrubbed,'removed',removed);
end $$;

create function public.community_shadow_reconcile(p_limit integer default 20) returns integer
language plpgsql security definer set search_path = pg_catalog, public as $$
declare r record; captured integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_argument'; end if;
  -- Only CURRENT snapshots, last 24h. Cannot recover vanished intermediate versions.
  for r in select q.k,q.id from (
    select 'post'::text k, p.id, p.updated_at ts from public.community_posts p
      where p.status in ('published','held_for_review') and p.updated_at > clock_timestamp()-interval '24 hours'
    union all select 'pending_edit', e.id, e.created_at from public.community_post_pending_edits e
      where e.status='pending' and e.created_at > clock_timestamp()-interval '24 hours'
    ) q cross join lateral (select community_shadow_private.current_snapshot(q.k,q.id) s) snapshot
    where snapshot.s is not null and (snapshot.s->>'expires')::timestamptz > clock_timestamp()
      and not exists (select 1 from public.community_shadow_jobs j where j.target_kind=q.k
        and coalesce(j.edit_id,j.post_id)=q.id and j.version=(snapshot.s->>'version')::integer
        and j.snapshot_hash=snapshot.s->>'hash' and j.config_revision='shadow-v1')
    order by q.ts,q.id limit p_limit
  loop
    if community_shadow_private.capture(r.k,r.id) then captured := captured+1; end if;
  end loop;
  return captured;
end $$;

create function public.community_shadow_claim(p_limit integer default 2, p_lease_seconds integer default 60)
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
  ) update public.community_shadow_jobs j set state='processing',attempts=j.attempts+1,
    lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),claim_token=gen_random_uuid(),
    updated_at=clock_timestamp() from due where j.id=due.id returning j.*;
end $$;

create function public.community_shadow_finish(p_job_id uuid, p_claim_token uuid, p_state text,
  p_results jsonb default '[]', p_error_code text default null) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.community_shadow_jobs%rowtype; r jsonb; a uuid; n_text integer; n_images integer;
  ok_text integer; ok_images integer; videos integer; v_coverage jsonb; overall text;
begin
  if p_job_id is null or p_claim_token is null or p_state is null
    or p_state not in ('completed','partial','failed','retry_wait')
    or p_results is null or jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results)>11
    then raise exception 'invalid_argument'; end if;
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
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,5*(2^j.attempts)::integer)),
    snapshot_text=case when p_state='retry_wait' then snapshot_text else null end,
    claim_token=null,lease_until=null,updated_at=clock_timestamp() where id=j.id;
  return 'finished';
end $$;

-- All helpers are uncallable by API roles. Only these bounded queue RPCs are exposed to service_role.
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='community_shadow_private' or (n.nspname='public' and p.proname in
      ('community_shadow_maintain','community_shadow_reconcile','community_shadow_claim','community_shadow_finish'))
  loop
    execute format('alter function %s owner to postgres',f.signature);
    execute format('revoke all on function %s from public, anon, authenticated, service_role',f.signature);
  end loop;
end $$;
grant execute on function public.community_shadow_maintain(integer), public.community_shadow_reconcile(integer),
  public.community_shadow_claim(integer,integer), public.community_shadow_finish(uuid,uuid,text,jsonb,text) to service_role;

comment on table public.community_shadow_jobs is
  'F4-A DEV observations only. No network or moderation effects. Snapshot text expires after 24h; bounded maintain scrubs it. No scheduler installed.';
comment on function public.community_shadow_reconcile(integer) is
  'Bounded recovery of current snapshots from last 24h only; cannot reconstruct lost intermediate versions or resurrect expired text.';
