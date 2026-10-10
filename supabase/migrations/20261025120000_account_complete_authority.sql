-- AUTH-2: "complete account" authority for Community. Forward-only; LOCAL, not applied remotely.
--
-- CANONICAL RULE: COMPLETE ACCOUNT = verified email (auth.users.email_confirmed_at) + a username
-- (a public.profiles row). Only a complete account may perform social Community writes. Own-post
-- DELETE stays allowed and is deliberately NOT touched here.
--
-- Single authority, read inside the database so HTTP and DB can never disagree:
--   * community_account_state(uuid)            -> 'complete' | 'email_unverified' | 'username_missing'
--                                                 (fail-closed: unknown user = 'email_unverified')
--   * community_assert_account_complete(uuid)  -> raises account_email_unverified /
--                                                 account_username_missing
-- Supabase Auth stays the source of truth for verification; nothing is copied into profiles.
--
-- Writers:
--   * post save / save_atomic / reorder_media / detach_media: the R5-C guard
--     community_assert_author_may_write is REPLACED (same signature) so all four writers inherit the
--     account check with no body copying. Lock order is preserved: profiles(FOR SHARE) first, then the
--     account check (plain reads), then the strike restriction.
--   * community_post_set_like / community_post_report_submit: renamed to *_core (unreachable by every
--     API role) and re-created as thin SECURITY DEFINER wrappers with the same signature that assert
--     the account first. No lock is taken by the wrapper, so core lock order is untouched.
--   * profiles: BEFORE INSERT / BEFORE UPDATE OF username triggers require a verified email, so a
--     username cannot be created or changed before verification even by a direct write.
--   * Not guarded: community_post_delete (own delete), media complete/abort.

create function public.community_account_state(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_confirmed timestamptz;
  v_found boolean := false;
begin
  if p_user_id is null then
    raise exception 'invalid_argument';
  end if;
  select u.email_confirmed_at, true into v_confirmed, v_found
    from auth.users u where u.id = p_user_id;
  if not coalesce(v_found, false) or v_confirmed is null then
    return 'email_unverified';
  end if;
  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    return 'username_missing';
  end if;
  return 'complete';
end;
$$;
alter function public.community_account_state(uuid) owner to postgres;
revoke all on function public.community_account_state(uuid) from public, anon, authenticated;
grant execute on function public.community_account_state(uuid) to service_role;

create function public.community_assert_account_complete(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_state text;
begin
  v_state := public.community_account_state(p_user_id);
  if v_state = 'email_unverified' then
    raise exception 'account_email_unverified';
  end if;
  if v_state = 'username_missing' then
    raise exception 'account_username_missing';
  end if;
end;
$$;
alter function public.community_assert_account_complete(uuid) owner to postgres;
revoke all on function public.community_assert_account_complete(uuid)
  from public, anon, authenticated, service_role;

-- R5-C guard, same signature: profiles(FOR SHARE) -> account complete -> strike restriction.
create or replace function public.community_assert_author_may_write(p_user_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_user_id is null then raise exception 'invalid_argument'; end if;
  perform 1 from public.profiles where user_id = p_user_id for share;
  -- AUTH-2: an incomplete account is NOT sanctioned; it gets its own error, before any strike read.
  perform public.community_assert_account_complete(p_user_id);
  if coalesce((public.community_author_restriction(p_user_id) ->> 'restricted')::boolean, false) then
    raise exception 'author_restricted';
  end if;
end;
$$;
alter function public.community_assert_author_may_write(uuid) owner to postgres;
revoke all on function public.community_assert_author_may_write(uuid)
  from public, anon, authenticated, service_role;

-- Like / unlike (both directions require a complete account).
alter function public.community_post_set_like(uuid, uuid, boolean)
  rename to community_post_set_like_core;
revoke all on function public.community_post_set_like_core(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

create function public.community_post_set_like(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_liked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_actor_user_id is null then
    raise exception 'invalid_argument';
  end if;
  perform public.community_assert_account_complete(p_actor_user_id);
  return public.community_post_set_like_core(p_actor_user_id, p_post_id, p_liked);
end;
$$;
alter function public.community_post_set_like(uuid, uuid, boolean) owner to postgres;
revoke all on function public.community_post_set_like(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.community_post_set_like(uuid, uuid, boolean) to service_role;

-- Direct table writes cannot bypass the wrapper: the likes table is only ever mutated by the
-- SECURITY DEFINER core (owner postgres), so service_role loses its direct INSERT/DELETE (same
-- precedent as community_post_reports, whose INSERT was already revoked in 20261011). SELECT stays
-- (liked-by-me). FK cascades and the like_count trigger run as the table/function owner.
revoke insert, delete on table public.community_post_likes from service_role;

-- Report submission: an incomplete account can never create a report, so it can never count toward
-- the distinct-reporter threshold.
alter function public.community_post_report_submit(uuid, uuid, text, text)
  rename to community_post_report_submit_core;
revoke all on function public.community_post_report_submit_core(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

create function public.community_post_report_submit(
  p_reporter_user_id uuid,
  p_post_id uuid,
  p_reason text,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_reporter_user_id is null then
    raise exception 'invalid_argument';
  end if;
  perform public.community_assert_account_complete(p_reporter_user_id);
  return public.community_post_report_submit_core(
    p_reporter_user_id, p_post_id, p_reason, p_detail);
end;
$$;
alter function public.community_post_report_submit(uuid, uuid, text, text) owner to postgres;
revoke all on function public.community_post_report_submit(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.community_post_report_submit(uuid, uuid, text, text)
  to service_role;

-- Username cannot be created or changed before the email is verified (direct writes included).
create function public.profiles_require_verified_email()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_confirmed timestamptz;
begin
  if tg_op = 'UPDATE' and new.username is not distinct from old.username then
    return new;
  end if;
  select u.email_confirmed_at into v_confirmed from auth.users u where u.id = new.user_id;
  if v_confirmed is null then
    raise exception 'account_email_unverified';
  end if;
  return new;
end;
$$;
alter function public.profiles_require_verified_email() owner to postgres;
revoke all on function public.profiles_require_verified_email()
  from public, anon, authenticated, service_role;

create trigger profiles_require_verified_email_insert
  before insert on public.profiles
  for each row execute function public.profiles_require_verified_email();
create trigger profiles_require_verified_email_update
  before update of username on public.profiles
  for each row execute function public.profiles_require_verified_email();
