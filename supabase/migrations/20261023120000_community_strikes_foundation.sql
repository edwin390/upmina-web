-- 9K-R5-B: strike foundation (DATABASE ONLY).
--
-- A strike is a durable, human-issued sanction attached to ONE moderation decision (Procede /
-- content_actioned). This migration adds the table, its immutability, the authoritative apply /
-- revoke primitives, the current-restriction read and the case-level strike state read.
--
-- NOT in this migration (R5-C onward): any change to the Community post writers
-- (community_post_save, community_post_save_atomic, community_post_reorder_media,
-- community_post_detach_media, community_post_delete), media handlers, HTTP handlers or UI. Nothing
-- here changes what an author can do today; it only creates the state the writers will consult.
--
-- Product contract (final):
--   * level = min(NON-REVOKED strikes of the user + 1, 3). Natural expiry of a sanction does NOT
--     remove a strike from escalation; only revocation does.
--   * level 1 = 14 days, level 2 = 1 calendar month (UTC), level 3 = permanent. The deadline is
--     computed here at issuance, persisted, and never recomputed.
--   * a decision can produce at most ONE strike forever (UNIQUE decision_id, revoked or not).
--   * apply: moderator / developer / admin. revoke: developer / admin only, and never the actor who
--     applied that same strike. (Recent MFA is enforced by the HTTP layer; the DB revalidates the
--     CURRENT role.)
--   * the strike references the moderation history (case / cycle / decision), never community_posts:
--     the post purge (R4-E) must stay possible and a strike stays valid after the post is gone.
--
-- LOCK ORDER (canonical, acyclic). Every statement that takes more than one of these locks takes
-- them in this order:
--     admin_roles(share) -> profiles(author) -> community_posts -> community_moderation_cases
--       -> community_moderation_cycles -> reports / decisions / notices -> community_user_strikes
--   * community_moderation_case_decide (R4-B, unchanged):  admin_roles -> post -> case -> cycle -> ...
--     It never locks profiles, so it cannot invert against anything below.
--   * community_strike_apply:  admin_roles(share) -> profiles(author, NO KEY UPDATE) -> case(share)
--     -> cycle(share) -> strikes insert -> audit insert. It does NOT lock the post: it only reads
--     IMMUTABLE history (the decision row and a closed cycle never change), so the post lock would
--     add nothing, and skipping it is what lets a strike be applied after the physical purge.
--   * community_strike_revoke: admin_roles(share) -> profiles(author, NO KEY UPDATE) -> strike(update)
--     -> audit insert.
--   * future writers (R5-C):  profiles(author, FOR SHARE) -> community_posts(update) -> ...
--     They read the restriction under the profile share lock, so an apply/revoke (which holds the
--     profile row NO KEY UPDATE until commit) is serialized with every create/edit of that author.
--   NO KEY UPDATE (not UPDATE) on the profile row: it conflicts with FOR SHARE (writers) and with
--   other NO KEY UPDATEs (apply/revoke/profile edits) but NOT with the FOR KEY SHARE that foreign-key
--   checks (likes, reports) take, so strikes never stall unrelated inserts.
--   True multi-session behaviour cannot be proven in PGlite; it belongs to the Testing smoke (R5-F).
--
-- Forward-only: 20261020120000, 20261021120000 and 20261022120000 are untouched.

-- ---------------------------------------------------------------------------------------------
-- 1. Referential anchor: allow a strike to bind decision + case + cycle + post in ONE foreign key.
--    decisions.id is already the primary key, so this unique constraint is trivially satisfied by
--    existing rows and only adds the index the composite FK needs. No row is read or changed.
-- ---------------------------------------------------------------------------------------------
alter table public.community_moderation_decisions
  add constraint community_moderation_decisions_full_ref_unique
  unique (id, case_id, post_id, cycle_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------------------------------
create table public.community_user_strikes (
  id uuid primary key default gen_random_uuid(),
  -- No FK to auth.users / profiles (same as community_moderation_cases.target_author_user_id and
  -- decisions.actor_user_id): the strike must survive account deletion and never block it.
  user_id uuid not null,
  case_id uuid not null,
  cycle_id uuid not null,
  decision_id uuid not null,
  -- No FK to community_posts BY DESIGN: the post purge deletes that row.
  post_id uuid not null,
  level smallint not null,
  reason text not null,
  applied_by uuid not null,
  sanction_starts_at timestamptz not null,
  sanction_ends_at timestamptz,
  permanent boolean not null,
  created_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revocation_reason text,
  -- One strike per decision FOREVER, revoked or not.
  constraint community_user_strikes_decision_unique unique (decision_id),
  -- Cross-case / cross-cycle / cross-post forgery is impossible: decision, case, post and cycle must
  -- be exactly the ones recorded together in the immutable decision row.
  constraint community_user_strikes_decision_fk foreign key (decision_id, case_id, post_id, cycle_id)
    references public.community_moderation_decisions (id, case_id, post_id, cycle_id),
  constraint community_user_strikes_level_check check (level between 1 and 3),
  constraint community_user_strikes_reason_check check (
    char_length(reason) between 1 and 1000
    and reason = btrim(reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    and reason !~ '^[[:space:]]*$'),
  constraint community_user_strikes_created_check check (created_at = sanction_starts_at),
  -- Structural sanction coherence per level (UTC calendar arithmetic, independent of session TimeZone).
  constraint community_user_strikes_sanction_check check (
    (level = 1 and not permanent and sanction_ends_at =
      ((sanction_starts_at at time zone 'UTC') + interval '14 days') at time zone 'UTC')
    or (level = 2 and not permanent and sanction_ends_at =
      ((sanction_starts_at at time zone 'UTC') + interval '1 month') at time zone 'UTC')
    or (level = 3 and permanent and sanction_ends_at is null)),
  constraint community_user_strikes_revocation_check check (
    (revoked_at is null and revoked_by is null and revocation_reason is null)
    or (revoked_at is not null and revoked_by is not null and revocation_reason is not null
      and revoked_at >= created_at
      and revoked_by <> applied_by
      and char_length(revocation_reason) between 1 and 1000
      and revocation_reason = btrim(revocation_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      and revocation_reason !~ '^[[:space:]]*$'))
);
comment on table public.community_user_strikes is
  'R5-B: durable human strikes. Issuance is immutable; the ONLY allowed update is the one-time revocation. No FK to community_posts (purge-safe) nor auth.users.';

create index community_user_strikes_active_user_idx
  on public.community_user_strikes (user_id) where revoked_at is null;
create index community_user_strikes_case_idx on public.community_user_strikes (case_id);

alter table public.community_user_strikes enable row level security;
alter table public.community_user_strikes force row level security;
revoke all on table public.community_user_strikes from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Immutability: no DELETE, no TRUNCATE, and the only UPDATE is the single revocation transition.
-- ---------------------------------------------------------------------------------------------
create function public.community_user_strikes_immutable()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE'
    and old.revoked_at is null
    and new.revoked_at is not null and new.revoked_by is not null and new.revocation_reason is not null
    and (new.id, new.user_id, new.case_id, new.cycle_id, new.decision_id, new.post_id, new.level,
         new.reason, new.applied_by, new.sanction_starts_at, new.sanction_ends_at, new.permanent,
         new.created_at)
      is not distinct from
        (old.id, old.user_id, old.case_id, old.cycle_id, old.decision_id, old.post_id, old.level,
         old.reason, old.applied_by, old.sanction_starts_at, old.sanction_ends_at, old.permanent,
         old.created_at) then
    return new;
  end if;
  raise exception 'community_user_strikes_immutable' using errcode = '23001';
end;
$$;
revoke all on function public.community_user_strikes_immutable() from public, anon, authenticated, service_role;
create trigger community_user_strikes_history before update or delete on public.community_user_strikes
  for each row execute function public.community_user_strikes_immutable();
create trigger community_user_strikes_no_truncate before truncate on public.community_user_strikes
  for each statement execute function public.community_user_strikes_immutable();

-- Defence in depth: whatever path inserts a strike, it must describe a real Procede decision of a
-- closed case whose recorded target author is the struck user.
create function public.community_user_strikes_context_check()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (
    select 1
    from public.community_moderation_decisions d
    join public.community_moderation_cases c on c.id = d.case_id
    where d.id = new.decision_id and d.decision = 'content_actioned'
      and c.author_identity = 'known' and c.target_author_user_id = new.user_id
  ) then
    raise exception 'community_user_strikes_context' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.community_user_strikes_context_check() from public, anon, authenticated, service_role;
create trigger community_user_strikes_context before insert on public.community_user_strikes
  for each row execute function public.community_user_strikes_context_check();

-- ---------------------------------------------------------------------------------------------
-- 4. Apply
-- ---------------------------------------------------------------------------------------------
create function public.community_strike_apply(
  p_actor_user_id uuid, p_decision_id uuid, p_reason text, p_expected_level integer default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_reason text := nullif(btrim(p_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '');
  v_role text;
  v_decision public.community_moderation_decisions%rowtype;
  v_case public.community_moderation_cases%rowtype;
  v_cycle_status text;
  v_author uuid;
  v_active integer;
  v_level integer;
  v_now timestamptz;
  v_ends timestamptz;
  v_id uuid := gen_random_uuid();
begin
  if p_actor_user_id is null or p_decision_id is null
    or (p_expected_level is not null and p_expected_level not between 1 and 3) then
    raise exception 'invalid_argument';
  end if;
  if v_reason is null then raise exception 'reason_required'; end if;
  if char_length(v_reason) > 1000 then raise exception 'invalid_argument'; end if;

  -- 1. authority (current role, revalidated here)
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then
    raise exception 'actor_not_moderator';
  end if;

  -- Immutable history, read without locks (a decision / closed cycle never changes).
  select * into v_decision from public.community_moderation_decisions where id = p_decision_id;
  if not found then raise exception 'decision_not_found'; end if;
  if v_decision.decision <> 'content_actioned' then raise exception 'decision_not_content_actioned'; end if;
  select target_author_user_id into v_author from public.community_moderation_cases
    where id = v_decision.case_id and author_identity = 'known';
  if v_author is null then raise exception 'author_unavailable'; end if;
  if v_author = p_actor_user_id then raise exception 'self_strike_forbidden'; end if;

  -- 2. profile of the struck user (serializes with every future create/edit of that author)
  perform 1 from public.profiles where user_id = v_author for no key update;
  if not found then raise exception 'author_unavailable'; end if;

  -- 3. case, then cycle (shared: closed history only). NO post lock: see the lock-order note.
  select * into v_case from public.community_moderation_cases where id = v_decision.case_id for share;
  if not found or v_case.status <> 'closed' then raise exception 'case_not_closed'; end if;
  select status into v_cycle_status from public.community_moderation_cycles
    where id = v_decision.cycle_id for share;
  if v_cycle_status is distinct from 'closed' then raise exception 'case_not_closed'; end if;

  -- 4. one strike per decision, forever
  if exists (select 1 from public.community_user_strikes where decision_id = p_decision_id) then
    raise exception 'strike_already_issued';
  end if;

  -- 5. level from NON-REVOKED strikes only (expired-but-not-revoked still counts)
  select count(*) into v_active from public.community_user_strikes
    where user_id = v_author and revoked_at is null;
  v_level := least(v_active + 1, 3);
  if p_expected_level is not null and p_expected_level <> v_level then
    raise exception 'level_changed';
  end if;

  v_now := clock_timestamp(); -- captured after every wait; never caller-controlled
  v_ends := case v_level
    when 1 then ((v_now at time zone 'UTC') + interval '14 days') at time zone 'UTC'
    when 2 then ((v_now at time zone 'UTC') + interval '1 month') at time zone 'UTC'
    else null end;

  begin
    insert into public.community_user_strikes
      (id, user_id, case_id, cycle_id, decision_id, post_id, level, reason, applied_by,
       sanction_starts_at, sanction_ends_at, permanent, created_at)
    values (v_id, v_author, v_decision.case_id, v_decision.cycle_id, v_decision.id, v_decision.post_id,
      v_level, v_reason, p_actor_user_id, v_now, v_ends, v_level = 3, v_now);
  exception when unique_violation then
    raise exception 'strike_already_issued';
  end;

  -- Minimal metadata: no reason text, no reporter identity, no keys.
  insert into public.moderation_audit_log
    (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
  values ('human', p_actor_user_id, 'community_user_strike', v_id, 'strike_applied',
    jsonb_build_object('case_id', v_decision.case_id, 'decision_id', v_decision.id, 'level', v_level), v_now);

  return jsonb_build_object('strikeId', v_id, 'decisionId', v_decision.id, 'caseId', v_decision.case_id,
    'level', v_level, 'permanent', v_level = 3, 'startsAt', v_now, 'endsAt', v_ends);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Revoke
-- ---------------------------------------------------------------------------------------------
create function public.community_strike_revoke(
  p_actor_user_id uuid, p_strike_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_reason text := nullif(btrim(p_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '');
  v_role text;
  v_user uuid;
  v_strike public.community_user_strikes%rowtype;
  v_now timestamptz;
begin
  if p_actor_user_id is null or p_strike_id is null then raise exception 'invalid_argument'; end if;
  if v_reason is null then raise exception 'reason_required'; end if;
  if char_length(v_reason) > 1000 then raise exception 'invalid_argument'; end if;

  -- 1. authority: developer / admin only (a plain moderator may apply, never revoke)
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then
    raise exception 'actor_not_moderator';
  end if;
  if v_role not in ('developer', 'admin') then raise exception 'revoker_role_insufficient'; end if;

  select user_id into v_user from public.community_user_strikes where id = p_strike_id;
  if not found then raise exception 'strike_not_found'; end if;

  -- 2. profile first (same order as apply / future writers); a deleted account has nothing to serialize
  perform 1 from public.profiles where user_id = v_user for no key update;

  -- 3. the strike row, re-read under its lock
  select * into v_strike from public.community_user_strikes where id = p_strike_id for update;
  if not found then raise exception 'strike_not_found'; end if;
  if v_strike.revoked_at is not null then raise exception 'strike_already_revoked'; end if;
  if v_strike.applied_by = p_actor_user_id then raise exception 'self_revoke_forbidden'; end if;

  v_now := clock_timestamp();
  update public.community_user_strikes
    set revoked_at = v_now, revoked_by = p_actor_user_id, revocation_reason = v_reason
    where id = p_strike_id;

  insert into public.moderation_audit_log
    (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
  values ('human', p_actor_user_id, 'community_user_strike', p_strike_id, 'strike_revoked',
    jsonb_build_object('case_id', v_strike.case_id, 'decision_id', v_strike.decision_id, 'level', v_strike.level), v_now);

  return jsonb_build_object('strikeId', p_strike_id, 'level', v_strike.level, 'revokedAt', v_now);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Current restriction (authoritative read; the future writers and the author read use it).
--    A strike restricts when it is NOT revoked and (permanent OR its deadline is still in the
--    future). An expired strike does not block, but still counts for escalation (apply above).
--    Several active strikes: permanent wins, otherwise the furthest deadline, then the higher level.
-- ---------------------------------------------------------------------------------------------
create function public.community_author_restriction(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_s public.community_user_strikes%rowtype;
begin
  if p_user_id is null then raise exception 'invalid_argument'; end if;
  select * into v_s from public.community_user_strikes
    where user_id = p_user_id and revoked_at is null and (permanent or sanction_ends_at > v_now)
    order by permanent desc, sanction_ends_at desc nulls last, level desc, created_at desc, id
    limit 1;
  if not found then
    return jsonb_build_object('restricted', false, 'serverNow', v_now);
  end if;
  -- Product fields only: no moderator identity, no case/decision/post linkage.
  return jsonb_build_object('restricted', true, 'level', v_s.level, 'permanent', v_s.permanent,
    'endsAt', v_s.sanction_ends_at, 'reason', v_s.reason, 'serverNow', v_now);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Strike state for the moderation case detail. NOT an authority for apply: apply re-derives
--    everything under locks. The predicted level is informational.
-- ---------------------------------------------------------------------------------------------
create function public.community_strike_state_read(p_actor_user_id uuid, p_case_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_role text;
  v_case public.community_moderation_cases%rowtype;
  v_decision public.community_moderation_decisions%rowtype;
  v_cycle_status text;
  v_strike public.community_user_strikes%rowtype;
  v_has_strike boolean := false;
  v_reason text := null;
  v_next integer := null;
  v_profile boolean;
  v_can_revoke boolean := false;
begin
  if p_actor_user_id is null or p_case_id is null then raise exception 'invalid_argument'; end if;
  select role into v_role from public.admin_roles where user_id = p_actor_user_id;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then
    raise exception 'actor_not_moderator';
  end if;
  select * into v_case from public.community_moderation_cases where id = p_case_id;
  if not found then raise exception 'case_not_found'; end if;

  select * into v_decision from public.community_moderation_decisions
    where case_id = p_case_id and decision = 'content_actioned'
    order by created_at desc, id desc limit 1;
  if not found then
    return jsonb_build_object('hasDecision', false, 'eligible', false,
      'ineligibleReason', 'decision_not_content_actioned', 'nextLevel', null, 'strike', null,
      'canRevoke', false, 'serverNow', v_now);
  end if;

  select * into v_strike from public.community_user_strikes where decision_id = v_decision.id;
  v_has_strike := found;
  select status into v_cycle_status from public.community_moderation_cycles where id = v_decision.cycle_id;
  select exists (select 1 from public.profiles where user_id = v_case.target_author_user_id) into v_profile;

  if v_has_strike then v_reason := 'strike_already_issued';
  elsif v_case.status <> 'closed' or v_cycle_status is distinct from 'closed' then v_reason := 'case_not_closed';
  elsif v_case.author_identity <> 'known' or v_case.target_author_user_id is null or not v_profile then
    v_reason := 'author_unavailable';
  elsif v_case.target_author_user_id = p_actor_user_id then v_reason := 'self_strike_forbidden';
  end if;
  if v_reason is null then
    select least(count(*) + 1, 3) into v_next from public.community_user_strikes
      where user_id = v_case.target_author_user_id and revoked_at is null;
  end if;
  if v_has_strike then
    v_can_revoke := v_strike.revoked_at is null and v_role in ('developer', 'admin')
      and v_strike.applied_by <> p_actor_user_id;
  end if;

  return jsonb_build_object('hasDecision', true, 'decisionId', v_decision.id,
    'eligible', v_reason is null, 'ineligibleReason', v_reason, 'nextLevel', v_next,
    'strike', case when not v_has_strike then null else jsonb_build_object(
      'strikeId', v_strike.id, 'level', v_strike.level, 'reason', v_strike.reason,
      'permanent', v_strike.permanent, 'startsAt', v_strike.sanction_starts_at,
      'endsAt', v_strike.sanction_ends_at, 'createdAt', v_strike.created_at,
      'status', case when v_strike.revoked_at is not null then 'revoked' else 'active' end,
      'sanctionInEffect', v_strike.revoked_at is null and (v_strike.permanent or v_strike.sanction_ends_at > v_now),
      'revokedAt', v_strike.revoked_at, 'revocationReason', v_strike.revocation_reason) end,
    'canRevoke', v_can_revoke, 'serverNow', v_now);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. ACL: owner postgres, definer, EXECUTE for the backend (service_role) only.
-- ---------------------------------------------------------------------------------------------
alter function public.community_strike_apply(uuid, uuid, text, integer) owner to postgres;
alter function public.community_strike_revoke(uuid, uuid, text) owner to postgres;
alter function public.community_author_restriction(uuid) owner to postgres;
alter function public.community_strike_state_read(uuid, uuid) owner to postgres;
revoke all on function public.community_strike_apply(uuid, uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.community_strike_revoke(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.community_author_restriction(uuid) from public, anon, authenticated, service_role;
revoke all on function public.community_strike_state_read(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.community_strike_apply(uuid, uuid, text, integer) to service_role;
grant execute on function public.community_strike_revoke(uuid, uuid, text) to service_role;
grant execute on function public.community_author_restriction(uuid) to service_role;
grant execute on function public.community_strike_state_read(uuid, uuid) to service_role;
