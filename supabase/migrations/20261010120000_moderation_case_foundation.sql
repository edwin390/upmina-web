-- 9K-R1: structure only. No threshold, grouped mutation, strike or posting restriction.
-- Legacy closed cycles are explicitly NOT human decisions in the new product model.
create table public.community_moderation_cases (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null unique,
  target_author_user_id uuid,
  author_identity text not null check (author_identity in ('known', 'unavailable')),
  status text not null check (status in ('pending', 'closed')),
  current_cycle integer not null default 1 check (current_cycle >= 1),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  opened_at timestamptz not null default now(),
  activity_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, post_id),
  check ((author_identity = 'known' and target_author_user_id is not null)
    or (author_identity = 'unavailable' and target_author_user_id is null)),
  check ((status = 'pending' and closed_at is null) or (status = 'closed' and closed_at is not null))
);
comment on table public.community_moderation_cases is
  'One durable case per post identity; no FK to post/auth.users, so deletion preserves history. closed does not imply a confirmed decision.';
comment on column public.community_moderation_cases.author_identity is
  'unavailable means the deleted target author could not be recovered authoritatively; never invent an identity.';

create table public.community_moderation_cycles (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  post_id uuid not null,
  cycle_number integer not null check (cycle_number >= 1),
  status text not null check (status in ('pending', 'closed')),
  closure_kind text check (closure_kind in ('legacy', 'decision')),
  opened_at timestamptz not null,
  closed_at timestamptz,
  unique (case_id, cycle_number),
  unique (case_id, post_id, id),
  unique (post_id, id),
  foreign key (case_id, post_id) references public.community_moderation_cases(id, post_id),
  check ((status = 'pending' and closure_kind is null and closed_at is null)
    or (status = 'closed' and closure_kind is not null and closed_at is not null))
);
alter table public.community_moderation_cases add constraint community_moderation_cases_current_cycle_fk
  foreign key (id, current_cycle) references public.community_moderation_cycles(case_id, cycle_number)
  deferrable initially deferred;

create table public.community_moderation_decisions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  post_id uuid not null,
  cycle_id uuid not null unique,
  actor_user_id uuid not null,
  decision text not null check (decision in ('reports_not_valid', 'content_actioned')),
  expected_case_version integer not null check (expected_case_version >= 1),
  expected_post_version integer check (expected_post_version >= 1),
  resulting_post_status text check (resulting_post_status in ('published', 'hidden_pending_review', 'hidden')),
  note text check (char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  foreign key (case_id, post_id, cycle_id) references public.community_moderation_cycles(case_id, post_id, id)
);
comment on table public.community_moderation_decisions is
  'Immutable human decisions for one explicit cycle. R1 creates no decisions and exposes no decision mutation RPC.';

-- Deterministic identifiers make the backfill reproducible. All old reports belong to
-- one explicitly legacy cycle; timestamps cannot reconstruct previous review cycles.
insert into public.community_moderation_cases
  (id, post_id, target_author_user_id, author_identity, status, created_at, opened_at, activity_at, closed_at)
select md5('moderation-case:' || r.post_id::text)::uuid, r.post_id, p.author_user_id,
  case when p.author_user_id is null then 'unavailable' else 'known' end,
  case when bool_or(r.status in ('open', 'reviewing')) then 'pending' else 'closed' end,
  min(r.created_at), min(r.created_at), max(r.updated_at),
  case when bool_or(r.status in ('open', 'reviewing')) then null else max(r.updated_at) end
from public.community_post_reports r left join public.community_posts p on p.id = r.post_id
group by r.post_id, p.author_user_id
on conflict (post_id) do nothing;

insert into public.community_moderation_cycles
  (id, case_id, post_id, cycle_number, status, closure_kind, opened_at, closed_at)
select md5('moderation-cycle:1:' || c.post_id::text)::uuid, c.id, c.post_id, 1, c.status,
  case when c.status = 'closed' then 'legacy' else null end, c.opened_at, c.closed_at
from public.community_moderation_cases c
on conflict (case_id, cycle_number) do nothing;
-- Flush the circular FK events before subsequent DDL in the migration transaction.
set constraints community_moderation_cases_current_cycle_fk immediate;
set constraints community_moderation_cases_current_cycle_fk deferred;

alter table public.community_post_reports add column case_id uuid, add column cycle_id uuid;
update public.community_post_reports r set case_id = c.id, cycle_id = y.id
from public.community_moderation_cases c join public.community_moderation_cycles y
  on y.case_id = c.id and y.cycle_number = 1
where r.post_id = c.post_id;
alter table public.community_post_reports
  alter column case_id set not null, alter column cycle_id set not null,
  add constraint community_post_reports_case_cycle_fk foreign key (case_id, post_id, cycle_id)
    references public.community_moderation_cycles(case_id, post_id, id);
create index community_post_reports_cycle_status_reporter_idx
  on public.community_post_reports (case_id, cycle_id, status, reporter_user_id);
create index community_moderation_cases_status_activity_idx
  on public.community_moderation_cases (status, activity_at desc, id desc);

alter table public.community_posts drop constraint community_posts_status_check;
alter table public.community_posts add constraint community_posts_status_check
  check (status in ('published', 'hidden_pending_review', 'hidden'));
alter table public.community_posts add column quarantine_cycle_id uuid,
  add constraint community_posts_quarantine_cycle_fk foreign key (id, quarantine_cycle_id)
    references public.community_moderation_cycles(post_id, id),
  add constraint community_posts_quarantine_attribution_check check
    ((status = 'hidden_pending_review' and quarantine_cycle_id is not null)
      or (status <> 'hidden_pending_review' and quarantine_cycle_id is null));
comment on column public.community_posts.quarantine_cycle_id is
  'Exact preventive quarantine attribution; composite FK binds cycle to this post. R1 does not set it or quarantine content.';

-- ADD COLUMN default preserves immutable old audit rows without UPDATE or disabling triggers.
alter table public.moderation_audit_log add column actor_kind text not null default 'human',
  alter column actor_user_id drop not null,
  add constraint moderation_audit_log_actor_check check
    ((actor_kind = 'human' and actor_user_id is not null)
      or (actor_kind = 'system' and actor_user_id is null));
alter table public.moderation_audit_log drop constraint moderation_audit_log_target_type_check,
  drop constraint moderation_audit_log_action_check;
alter table public.moderation_audit_log add constraint moderation_audit_log_target_type_check
  check (target_type in ('community_post_report', 'community_post', 'community_moderation_case', 'community_user_strike')),
  add constraint moderation_audit_log_action_check check
    (action in ('report_status_changed', 'post_hidden', 'post_restored', 'post_quarantined',
      'case_rejected', 'content_actioned', 'strike_applied', 'strike_revoked')),
  add constraint moderation_audit_log_system_action_check check
    ((actor_kind = 'system' and action = 'post_quarantined' and target_type = 'community_post')
      or (actor_kind = 'human' and action <> 'post_quarantined'));

-- Only insert compatibility is needed: old report RPC still inserts the same fields.
-- Lock order: post -> case; no report-set decision or threshold is implemented here.
create function public.community_report_case_attach()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_author uuid;
  v_case public.community_moderation_cases%rowtype;
  v_cycle uuid;
  v_now timestamptz := clock_timestamp();
begin
  select author_user_id into v_author from public.community_posts where id = new.post_id for update;
  if not found then raise exception 'post_not_found'; end if;
  if new.case_id is not null or new.cycle_id is not null then
    raise exception 'report_case_assignment_server_only';
  end if;
  insert into public.community_moderation_cases
    (post_id, target_author_user_id, author_identity, status, created_at, opened_at, activity_at)
    values (new.post_id, v_author, 'known', 'pending', v_now, v_now, v_now)
    on conflict (post_id) do nothing;
  select * into v_case from public.community_moderation_cases where post_id = new.post_id for update;
  if v_case.status = 'closed' then
    update public.community_moderation_cases set status = 'pending', current_cycle = current_cycle + 1,
      opened_at = v_now, closed_at = null where id = v_case.id returning * into v_case;
  end if;
  insert into public.community_moderation_cycles (case_id, post_id, cycle_number, status, opened_at)
    values (v_case.id, new.post_id, v_case.current_cycle, 'pending', v_now)
    on conflict (case_id, cycle_number) do nothing;
  select id into v_cycle from public.community_moderation_cycles
    where case_id = v_case.id and cycle_number = v_case.current_cycle and status = 'pending';
  if v_cycle is null then raise exception 'case_cycle_inconsistent'; end if;
  new.case_id := v_case.id;
  new.cycle_id := v_cycle;
  update public.community_moderation_cases set version = version + 1, activity_at = v_now where id = v_case.id;
  return new;
end;
$$;
revoke all on function public.community_report_case_attach() from public, anon, authenticated, service_role;
create trigger community_post_reports_attach_case before insert on public.community_post_reports
  for each row execute function public.community_report_case_attach();

create function public.community_moderation_history_immutable()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if tg_table_name = 'community_moderation_cycles' and tg_op = 'UPDATE' then
    if old.status = 'pending' and new.id = old.id and new.case_id = old.case_id
      and new.post_id = old.post_id and new.cycle_number = old.cycle_number
      and new.opened_at = old.opened_at then
      return new;
    end if;
  end if;
  raise exception 'community_moderation_history_immutable' using errcode = '23001';
end;
$$;
revoke all on function public.community_moderation_history_immutable() from public, anon, authenticated, service_role;
create trigger community_moderation_cycles_history before update or delete on public.community_moderation_cycles
  for each row execute function public.community_moderation_history_immutable();
create trigger community_moderation_cycles_no_truncate before truncate on public.community_moderation_cycles
  for each statement execute function public.community_moderation_history_immutable();
create trigger community_moderation_decisions_history before update or delete on public.community_moderation_decisions
  for each row execute function public.community_moderation_history_immutable();
create trigger community_moderation_decisions_no_truncate before truncate on public.community_moderation_decisions
  for each statement execute function public.community_moderation_history_immutable();

-- Deferred checks permit a future RPC to close cycle/header and insert its decision
-- in any statement order, but never commit a contradictory historical context.
create function public.community_moderation_context_check()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_case_id uuid;
begin
  if tg_table_name = 'community_moderation_cases' then v_case_id := new.id;
  else v_case_id := new.case_id; end if;
  if exists (select 1 from public.community_moderation_cases c
    join public.community_moderation_cycles y on y.case_id = c.id and y.cycle_number = c.current_cycle
    where c.id = v_case_id and c.status <> y.status) then
    raise exception 'case_cycle_state_inconsistent';
  end if;
  if exists (select 1 from public.community_moderation_cycles y
    left join public.community_moderation_decisions d on d.cycle_id = y.id
    where y.case_id = v_case_id and
      ((y.closure_kind = 'decision' and d.id is null)
        or (d.id is not null and (y.status <> 'closed' or y.closure_kind <> 'decision')))) then
    raise exception 'cycle_decision_inconsistent';
  end if;
  if exists (select 1 from public.community_posts p
    join public.community_moderation_cycles y on y.id = p.quarantine_cycle_id
    join public.community_moderation_cases c on c.id = y.case_id
    where c.id = v_case_id and (y.status <> 'pending' or y.cycle_number <> c.current_cycle)) then
    raise exception 'quarantine_cycle_not_current';
  end if;
  return null;
end;
$$;
revoke all on function public.community_moderation_context_check() from public, anon, authenticated, service_role;
create constraint trigger community_moderation_cases_context after insert or update on public.community_moderation_cases
  deferrable initially deferred for each row execute function public.community_moderation_context_check();
create constraint trigger community_moderation_cycles_context after insert or update on public.community_moderation_cycles
  deferrable initially deferred for each row execute function public.community_moderation_context_check();
create constraint trigger community_moderation_decisions_context after insert on public.community_moderation_decisions
  deferrable initially deferred for each row execute function public.community_moderation_context_check();

create function public.community_quarantine_context_check()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from public.community_posts p
    join public.community_moderation_cycles y on y.id = p.quarantine_cycle_id
    join public.community_moderation_cases c on c.id = y.case_id
    where p.id = new.id and (y.status <> 'pending' or y.cycle_number <> c.current_cycle)) then
    raise exception 'quarantine_cycle_not_current';
  end if;
  return null;
end;
$$;
revoke all on function public.community_quarantine_context_check() from public, anon, authenticated, service_role;
create constraint trigger community_posts_quarantine_context after insert or update on public.community_posts
  deferrable initially deferred for each row execute function public.community_quarantine_context_check();

alter table public.community_moderation_cases enable row level security;
alter table public.community_moderation_cases force row level security;
alter table public.community_moderation_cycles enable row level security;
alter table public.community_moderation_cycles force row level security;
alter table public.community_moderation_decisions enable row level security;
alter table public.community_moderation_decisions force row level security;
revoke all on public.community_moderation_cases, public.community_moderation_cycles,
  public.community_moderation_decisions from public, anon, authenticated, service_role;
grant select on public.community_moderation_cases, public.community_moderation_cycles,
  public.community_moderation_decisions to service_role;
