-- DEV only. Fixed scope/model and 100 reserved component requests per UTC date.
-- Apply atomically after 20261124. No provider, scheduler or Community writes.
create table public.community_shadow_budget_control (
  scope text primary key check (scope='dev:omni-moderation-latest'),
  cooldown_until timestamptz check (isfinite(cooldown_until)),
  halted boolean not null default false
);
insert into public.community_shadow_budget_control(scope) values ('dev:omni-moderation-latest');
create table public.community_shadow_budget_days (
  utc_day date primary key,
  reserved integer not null default 0 check (reserved between 0 and 100)
);
create table public.community_shadow_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.community_shadow_jobs(id) on delete cascade,
  claim_token uuid not null,
  utc_day date not null references public.community_shadow_budget_days(utc_day),
  units integer not null check (units between 1 and 11),
  unique(job_id,claim_token)
);
alter table public.community_shadow_budget_control enable row level security;
alter table public.community_shadow_budget_control force row level security;
alter table public.community_shadow_budget_days enable row level security;
alter table public.community_shadow_budget_days force row level security;
alter table public.community_shadow_budget_reservations enable row level security;
alter table public.community_shadow_budget_reservations force row level security;
revoke all on public.community_shadow_budget_control, public.community_shadow_budget_days,
  public.community_shadow_budget_reservations from public,anon,authenticated,service_role;

-- Canonical lock order: parent -> job -> fixed budget control. No external I/O in SQL.
create function public.community_shadow_budget_reserve(p_job_id uuid,p_claim_token uuid,p_units integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.community_shadow_jobs%rowtype; c public.community_shadow_budget_control%rowtype;
  ticket public.community_shadow_budget_reservations%rowtype; d date; n integer; used integer;
begin
  if p_job_id is null or p_claim_token is null or p_units is null or p_units not between 1 and 11
    then raise exception 'invalid_argument'; end if;
  select * into j from public.community_shadow_jobs where id=p_job_id;
  if not found then return jsonb_build_object('status','not_found'); end if;
  begin
    perform 1 from public.community_posts where id=j.post_id for share nowait;
    if not found then return jsonb_build_object('status','not_found'); end if;
    select * into j from public.community_shadow_jobs where id=p_job_id for update nowait;
    if not found then return jsonb_build_object('status','not_found'); end if;
  exception when lock_not_available then return jsonb_build_object('status','busy'); end;
  if j.environment<>'dev' then return jsonb_build_object('status','invalid_scope'); end if;
  if j.state<>'processing' or j.claim_token<>p_claim_token or j.lease_until<=clock_timestamp()
    or j.snapshot_expires_at<=clock_timestamp() or j.retain_until<=clock_timestamp()
    or j.attempts>=3 or j.attempt_claim_token is not null then return jsonb_build_object('status','stale_claim'); end if;
  if j.obsolete_at is not null or not community_shadow_private.is_current(j)
    then return jsonb_build_object('status','obsolete'); end if;
  select count(*) into n from jsonb_array_elements(j.assets) a where a->>'kind'='image';
  n:=n+case when j.snapshot_text is null then 0 else 1 end;
  if n<>p_units then raise exception 'invalid_component_count'; end if;
  select * into c from public.community_shadow_budget_control where scope='dev:omni-moderation-latest' for update;
  if not found then raise exception 'budget_unavailable'; end if;
  -- A retry after an unknown commit outcome must never debit the same claim twice.
  -- The shared row lock may have waited beyond the lease or snapshot lifetime.
  if j.lease_until<=clock_timestamp() or j.snapshot_expires_at<=clock_timestamp() or j.retain_until<=clock_timestamp()
    then return jsonb_build_object('status','stale_claim'); end if;
  select * into ticket from public.community_shadow_budget_reservations where job_id=j.id and claim_token=p_claim_token;
  if c.halted or c.cooldown_until>clock_timestamp() then
    return jsonb_build_object('status','cooldown_active','retry_at',case when c.halted then j.snapshot_expires_at else c.cooldown_until end);
  end if;
  if ticket.id is not null then return jsonb_build_object('status','reserved','reservation_id',ticket.id,'units',ticket.units); end if;
  d:=(clock_timestamp() at time zone 'UTC')::date;
  insert into public.community_shadow_budget_days(utc_day) values(d) on conflict do nothing;
  update public.community_shadow_budget_days set reserved=reserved+n where utc_day=d and reserved+n<=100 returning reserved into used;
  if not found then return jsonb_build_object('status','quota_exhausted',
    'retry_at',(d+1)::timestamp at time zone 'UTC'); end if;
  insert into public.community_shadow_budget_reservations(job_id,claim_token,utc_day,units)
    values(j.id,p_claim_token,d,n) returning * into ticket;
  return jsonb_build_object('status','reserved','reservation_id',ticket.id,'units',n);
end $$;

-- Reservation is not revocable, but every subsequent component checks shared cooldown and current claim.
create function public.community_shadow_budget_check(p_job_id uuid,p_claim_token uuid,p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.community_shadow_jobs%rowtype; c public.community_shadow_budget_control%rowtype;
begin
  if p_job_id is null or p_claim_token is null or p_reservation_id is null then raise exception 'invalid_argument'; end if;
  select * into j from public.community_shadow_jobs where id=p_job_id;
  if not found then return jsonb_build_object('status','not_found'); end if;
  begin
    perform 1 from public.community_posts where id=j.post_id for share nowait;
    if not found then return jsonb_build_object('status','not_found'); end if;
    select * into j from public.community_shadow_jobs where id=p_job_id for update nowait;
    if not found then return jsonb_build_object('status','not_found'); end if;
  exception when lock_not_available then return jsonb_build_object('status','busy'); end;
  if j.environment<>'dev' then return jsonb_build_object('status','invalid_scope'); end if;
  if j.state<>'processing' or j.claim_token<>p_claim_token or j.attempt_claim_token is distinct from p_claim_token
    or j.lease_until<=clock_timestamp() or j.snapshot_expires_at<=clock_timestamp() or j.retain_until<=clock_timestamp()
    then return jsonb_build_object('status','stale_claim'); end if;
  if j.obsolete_at is not null or not community_shadow_private.is_current(j) then return jsonb_build_object('status','obsolete'); end if;
  if not exists(select 1 from public.community_shadow_budget_reservations where id=p_reservation_id and job_id=j.id and claim_token=p_claim_token)
    then return jsonb_build_object('status','stale_claim'); end if;
  select * into c from public.community_shadow_budget_control where scope='dev:omni-moderation-latest' for update;
  if not found then raise exception 'budget_unavailable'; end if;
  if j.lease_until<=clock_timestamp() or j.snapshot_expires_at<=clock_timestamp() or j.retain_until<=clock_timestamp()
    then return jsonb_build_object('status','stale_claim'); end if;
  if c.halted or c.cooldown_until>clock_timestamp() then return jsonb_build_object('status','cooldown_active',
    'retry_at',case when c.halted then j.snapshot_expires_at else c.cooldown_until end); end if;
  return jsonb_build_object('status','allowed');
end $$;

-- Positive Retry-After seconds; beyond seven days, halt safely instead of shortening the wait.
-- No RPC can shorten cooldown, clear halt, choose another scope or increase the daily cap.
create function public.community_shadow_budget_cooldown(p_retry_after_seconds bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare c public.community_shadow_budget_control%rowtype;
begin
  if p_retry_after_seconds is null or p_retry_after_seconds<1 then raise exception 'invalid_cooldown'; end if;
  select * into c from public.community_shadow_budget_control where scope='dev:omni-moderation-latest' for update;
  if not found then raise exception 'budget_unavailable'; end if;
  update public.community_shadow_budget_control set
    halted=halted or p_retry_after_seconds>604800,
    cooldown_until=case when p_retry_after_seconds>604800 then cooldown_until else
      greatest(cooldown_until,clock_timestamp()+make_interval(secs=>p_retry_after_seconds::integer)) end
    where scope=c.scope returning * into c;
  return jsonb_build_object('status','cooldown_active','retry_at',c.cooldown_until,'halted',c.halted);
end $$;

alter table public.community_shadow_budget_control owner to postgres;
alter table public.community_shadow_budget_days owner to postgres;
alter table public.community_shadow_budget_reservations owner to postgres;
alter function public.community_shadow_budget_reserve(uuid,uuid,integer) owner to postgres;
alter function public.community_shadow_budget_check(uuid,uuid,uuid) owner to postgres;
alter function public.community_shadow_budget_cooldown(bigint) owner to postgres;
revoke all on function public.community_shadow_budget_reserve(uuid,uuid,integer),
  public.community_shadow_budget_check(uuid,uuid,uuid),public.community_shadow_budget_cooldown(bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.community_shadow_budget_reserve(uuid,uuid,integer),
  public.community_shadow_budget_check(uuid,uuid,uuid),public.community_shadow_budget_cooldown(bigint) to service_role;
