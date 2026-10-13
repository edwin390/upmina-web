-- Rollback LOCAL/OPERADOR de 20261101120000_developer_panel.sql. NO ejecutar automáticamente.
-- Se niega a ejecutarse si ya hay aprobaciones excepcionales o auditoría de asignación de Developer:
-- ese historial es auditoría y no se destruye. Restaura las cuatro funciones a su versión anterior.
do $$
begin
  if exists (select 1 from public.admin_mfa_recoveries where approval_kind = 'exceptional') then
    raise exception 'rollback_refused_exceptional_approvals_exist';
  end if;
  if exists (select 1 from public.admin_developer_audit) then
    raise exception 'rollback_refused_developer_audit_exists';
  end if;
  if exists (select 1 from public.admin_roles where role = 'developer') then
    raise exception 'rollback_refused_developer_role_exists';
  end if;
end;
$$;

drop function if exists public.operator_revoke_developer(uuid, text);
drop function if exists public.operator_grant_developer(uuid, text);
drop table if exists public.admin_developer_audit;
drop function if exists public.admin_developer_audit_append_only();
drop function if exists public.admin_mfa_cleanups_for_developer(uuid);
drop function if exists public.admin_mfa_recoveries_exceptional(uuid);
drop function if exists public.admin_mfa_recovery_deny_exceptional(uuid, uuid, text);
drop function if exists public.admin_mfa_recovery_approve_exceptional(uuid, uuid, text);

-- Versiones anteriores de las funciones modificadas
create or replace function public.admin_mfa_recoveries_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then raise exception 'mfa_recovery_immutable'; end if;
  if old.status in ('completed', 'denied', 'cancelled', 'expired') then
    raise exception 'mfa_recovery_closed';
  end if;
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.role_at_request is distinct from old.role_at_request
     or new.email_hash is distinct from old.email_hash
     or new.requested_at is distinct from old.requested_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'mfa_recovery_identity_immutable';
  end if;
  return new;
end;
$$;
alter function public.admin_mfa_recoveries_guard() owner to postgres;

create or replace function public.admin_mfa_recovery_create(p_user_id uuid, p_challenge_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text;
  v_email text;
  v_confirmed timestamptz;
  v_active public.admin_mfa_recoveries;
  v_id uuid;
begin
  if p_user_id is null or p_challenge_hash is null or p_challenge_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_argument';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery:' || p_user_id::text, 0));

  select ar.role into v_role from public.admin_roles ar where ar.user_id = p_user_id;
  if v_role is null then return jsonb_build_object('ok', false, 'reason', 'not_privileged'); end if;

  select u.email::text, u.email_confirmed_at into v_email, v_confirmed
    from auth.users u where u.id = p_user_id;
  if v_email is null or v_confirmed is null then
    return jsonb_build_object('ok', false, 'reason', 'email_unverified');
  end if;

  -- Caducidad perezosa de las solicitudes que no llegaron a ejecutarse.
  perform public.admin_mfa_recovery_close(x.id, 'expired', 'request_expired', null)
    from (select r2.id from public.admin_mfa_recoveries r2
           where r2.user_id = p_user_id and r2.status in ('pending_email', 'pending_approval', 'approved')
             and r2.expires_at <= now() for update) x;

  select * into v_active from public.admin_mfa_recoveries
   where user_id = p_user_id
     and status in ('pending_email', 'pending_approval', 'approved', 'executing', 'factors_deleted')
   for update;
  if found then
    if v_active.status = 'factors_deleted' then
      -- Ya se invalidó el factor y la persona nunca terminó: se permite empezar de nuevo.
      perform public.admin_mfa_recovery_close(v_active.id, 'cancelled', 'superseded', p_user_id);
    else
      return jsonb_build_object('ok', false, 'reason', 'active_request', 'status', v_active.status);
    end if;
  end if;

  if (select count(*) from public.admin_mfa_recoveries
       where user_id = p_user_id and requested_at > now() - interval '24 hours') >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  -- Debe existir OTRO admin que pueda aprobar (el único admin no tiene recuperación automática).
  if not exists (select 1 from public.admin_roles ar where ar.role = 'admin' and ar.user_id <> p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_approver');
  end if;

  insert into public.admin_mfa_recoveries (
    user_id, role_at_request, status, email_hash, expires_at,
    challenge_hash, challenge_expires_at, challenge_sends, last_sent_at)
  values (
    p_user_id, v_role, 'pending_email', public.admin_mfa_recovery_email_hash(p_user_id),
    now() + interval '24 hours', p_challenge_hash, now() + interval '15 minutes', 1, now())
  returning id into v_id;
  perform public.admin_mfa_recovery_log(v_id, p_user_id, 'requested', p_user_id, v_role);
  return jsonb_build_object('ok', true, 'recoveryId', v_id, 'email', v_email, 'role', v_role, 'sends', 1);
end;
$$;
alter function public.admin_mfa_recovery_create(uuid, text) owner to postgres;

create or replace function public.admin_mfa_recovery_current(p_user_id uuid)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_notice text; v_has_approver boolean;
begin
  if p_user_id is null then raise exception 'invalid_argument'; end if;
  select exists (select 1 from public.admin_roles ar where ar.role = 'admin' and ar.user_id <> p_user_id)
    into v_has_approver;
  select * into r from public.admin_mfa_recoveries where user_id = p_user_id
   order by requested_at desc limit 1;
  if not found then return jsonb_build_object('status', 'none', 'hasApprover', v_has_approver); end if;
  select m.state into v_notice from public.admin_mfa_recovery_mail m where m.recovery_id = r.id and m.kind = 'approved';
  return jsonb_build_object(
    'recoveryId', r.id, 'status', r.status, 'hasApprover', v_has_approver,
    'requestedAt', r.requested_at, 'expiresAt', r.expires_at,
    'challengeExpiresAt', r.challenge_expires_at, 'challengeSends', r.challenge_sends,
    'approvedAt', r.approved_at, 'noticeState', v_notice,
    'readyAt', public.admin_mfa_recovery_ready_at(r.id),
    'readiness', public.admin_mfa_recovery_readiness(r.id),
    'closedReason', r.closed_reason, 'deniedReason', r.denied_reason,
    'lastErrorClass', r.last_error_class);
end;
$$;
alter function public.admin_mfa_recovery_current(uuid) owner to postgres;

create or replace function public.change_admin_member_role(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_new_role text
)
returns table(
  out_old_role text,
  out_new_role text,
  out_changed_at timestamptz,
  out_revoked_invitations integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old_role text;
  v_now timestamptz;
  v_revoked integer := 0;
begin
  if p_actor_user_id is null or p_target_user_id is null or p_new_role is null then
    raise exception 'invalid_argument';
  end if;
  if p_new_role not in ('admin', 'moderator', 'developer') then
    raise exception 'invalid_role';
  end if;

  perform public.upmina_lock_admin_roles();

  -- Instante DESPUÉS de obtener el lock (no el inicio de la transacción): las operaciones quedan
  -- serializadas por el lock y así el orden cronológico de la auditoría (y de revoked_at frente a
  -- created_at de una invitación creada justo antes) coincide con el orden real de aplicación.
  v_now := pg_catalog.clock_timestamp();

  if not exists (
    select 1 from public.admin_roles ar
     where ar.user_id = p_actor_user_id and ar.role = 'admin'
  ) then
    raise exception 'actor_not_admin';
  end if;

  if p_actor_user_id = p_target_user_id then
    raise exception 'self_change_not_allowed';
  end if;

  select ar.role into v_old_role
    from public.admin_roles ar
    where ar.user_id = p_target_user_id
    for update;

  if not found then
    raise exception 'member_not_found';
  end if;
  if v_old_role = p_new_role then
    raise exception 'role_unchanged';
  end if;

  update public.admin_roles
     set role = p_new_role
   where user_id = p_target_user_id;

  -- El target ERA ADMIN y ya no lo es: sus invitaciones standard aún pendientes (ni consumidas,
  -- ni revocadas, ni expiradas) se revocan con la MISMA transición PENDING -> REVOKED de 9D
  -- (revoked_at + revoked_by = quien degrada). Las consumidas, revocadas y expiradas y las
  -- bootstrap no se tocan. Recuperar ADMIN después NO las revive (la revocación es de una vía).
  if v_old_role = 'admin' and p_new_role <> 'admin' then
    update public.admin_invitations i
       set revoked_at = v_now,
           revoked_by = p_actor_user_id
     where i.invitation_type = 'standard'
       and i.created_by = p_target_user_id
       and i.consumed_at is null
       and i.revoked_at is null
       and i.expires_at >= v_now;
    get diagnostics v_revoked = row_count;
  end if;

  insert into public.admin_team_audit (action, actor_user_id, target_user_id, old_role, new_role, created_at)
    values ('role_changed', p_actor_user_id, p_target_user_id, v_old_role, p_new_role, v_now);

  return query select v_old_role, p_new_role, v_now, v_revoked;
end;
$$;

create or replace function public.remove_admin_member(
  p_actor_user_id uuid,
  p_target_user_id uuid
)
returns table(
  out_old_role text,
  out_removed_at timestamptz,
  out_revoked_invitations integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old_role text;
  v_now timestamptz;
  v_revoked integer := 0;
begin
  if p_actor_user_id is null or p_target_user_id is null then
    raise exception 'invalid_argument';
  end if;

  perform public.upmina_lock_admin_roles();

  -- Instante DESPUÉS de obtener el lock (no el inicio de la transacción): las operaciones quedan
  -- serializadas por el lock y así el orden cronológico de la auditoría (y de revoked_at frente a
  -- created_at de una invitación creada justo antes) coincide con el orden real de aplicación.
  v_now := pg_catalog.clock_timestamp();

  if not exists (
    select 1 from public.admin_roles ar
     where ar.user_id = p_actor_user_id and ar.role = 'admin'
  ) then
    raise exception 'actor_not_admin';
  end if;

  if p_actor_user_id = p_target_user_id then
    raise exception 'self_change_not_allowed';
  end if;

  select ar.role into v_old_role
    from public.admin_roles ar
    where ar.user_id = p_target_user_id
    for update;

  if not found then
    raise exception 'member_not_found';
  end if;

  delete from public.admin_roles
   where user_id = p_target_user_id;

  if v_old_role = 'admin' then
    update public.admin_invitations i
       set revoked_at = v_now,
           revoked_by = p_actor_user_id
     where i.invitation_type = 'standard'
       and i.created_by = p_target_user_id
       and i.consumed_at is null
       and i.revoked_at is null
       and i.expires_at >= v_now;
    get diagnostics v_revoked = row_count;
  end if;

  insert into public.admin_team_audit (action, actor_user_id, target_user_id, old_role, new_role, created_at)
    values ('access_removed', p_actor_user_id, p_target_user_id, v_old_role, null, v_now);

  return query select v_old_role, v_now, v_revoked;
end;
$$;

drop function if exists public.admin_mfa_recovery_peer_available(uuid);
alter table public.admin_mfa_recoveries drop constraint if exists admin_mfa_recoveries_approval_check;
alter table public.admin_mfa_recoveries drop column if exists approver_role;
alter table public.admin_mfa_recoveries drop column if exists approval_kind;
