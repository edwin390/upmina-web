-- Rollback LOCAL/OPERADOR de 20261102120000_developer_transition.sql. NO ejecutar automáticamente.
-- Se niega a ejecutarse si ya hay transiciones registradas (autotransferencias o restauraciones) o
-- configuración de la espera: ese historial es auditoría y no se destruye. Restaura las funciones anteriores
-- (incluida operator_grant_developer) y la forma anterior de admin_developer_audit.
do $$
begin
  if exists (select 1 from public.admin_developer_audit where action in ('self_transferred', 'restored')) then
    raise exception 'rollback_refused_developer_transitions_exist';
  end if;
  if exists (select 1 from public.admin_developer_settings) or exists (select 1 from public.admin_developer_settings_audit) then
    raise exception 'rollback_refused_developer_settings_exist';
  end if;
end;
$$;

drop function if exists public.operator_set_developer_cooldown(integer, text);
drop function if exists public.admin_restore_developer(uuid, uuid, text);
drop function if exists public.admin_transfer_self_to_developer(uuid);
drop function if exists public.admin_transfer_status(uuid);
drop function if exists public.admin_developer_cooldown(uuid);

-- Versiones anteriores de las funciones modificadas
create or replace function public.admin_mfa_recovery_approve_exceptional(
  p_recovery_id uuid, p_actor_user_id uuid, p_cancel_hash text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_role text;
begin
  if p_recovery_id is null or p_actor_user_id is null or p_cancel_hash is null or p_cancel_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_argument';
  end if;
  -- El lock compartido de roles va PRIMERO (regla de 9B): un cambio de roles concurrente espera.
  perform public.upmina_lock_admin_roles();
  if not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'developer') then
    raise exception 'actor_not_developer';
  end if;
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.user_id = p_actor_user_id then return jsonb_build_object('ok', false, 'reason', 'self_approval'); end if;
  if r.status <> 'pending_approval' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', r.status);
  end if;
  if r.expires_at <= now() then
    perform public.admin_mfa_recovery_close(r.id, 'expired', 'request_expired', null);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if public.admin_mfa_recovery_email_hash(r.user_id) is distinct from r.email_hash then
    perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'email_changed', null);
    return jsonb_build_object('ok', false, 'reason', 'email_changed');
  end if;
  select ar.role into v_role from public.admin_roles ar where ar.user_id = r.user_id;
  if v_role is distinct from r.role_at_request then
    perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'role_changed', null);
    return jsonb_build_object('ok', false, 'reason', 'role_changed');
  end if;
  -- Solo para un ADMIN solicitante y solo si NO hay otro admin elegible (en este instante).
  if r.role_at_request <> 'admin' then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
  end if;
  if public.admin_mfa_recovery_peer_available(r.user_id) then
    return jsonb_build_object('ok', false, 'reason', 'peer_available');
  end if;
  update public.admin_mfa_recoveries
     set status = 'approved', approved_by = p_actor_user_id, approved_at = now(),
         cancel_hash = p_cancel_hash, cancel_rotations = 1,
         approval_kind = 'exceptional', approver_role = 'developer'
   where id = r.id;
  perform public.admin_mfa_recovery_log(r.id, r.user_id, 'approved', p_actor_user_id, 'exceptional:developer');
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'userId', r.user_id, 'cancelRotation', 1,
    'email', (select u.email::text from auth.users u where u.id = r.user_id));
end;
$$;

create or replace function public.admin_mfa_recovery_approve(p_recovery_id uuid, p_actor_user_id uuid, p_cancel_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_role text;
begin
  if p_recovery_id is null or p_actor_user_id is null or p_cancel_hash is null or p_cancel_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_argument';
  end if;
  if not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.user_id = p_actor_user_id then return jsonb_build_object('ok', false, 'reason', 'self_approval'); end if;
  if r.status <> 'pending_approval' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', r.status);
  end if;
  if r.expires_at <= now() then
    perform public.admin_mfa_recovery_close(r.id, 'expired', 'request_expired', null);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if public.admin_mfa_recovery_email_hash(r.user_id) is distinct from r.email_hash then
    perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'email_changed', null);
    return jsonb_build_object('ok', false, 'reason', 'email_changed');
  end if;
  select ar.role into v_role from public.admin_roles ar where ar.user_id = r.user_id;
  if v_role is distinct from r.role_at_request then
    perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'role_changed', null);
    return jsonb_build_object('ok', false, 'reason', 'role_changed');
  end if;
  update public.admin_mfa_recoveries
     set status = 'approved', approved_by = p_actor_user_id, approved_at = now(),
         cancel_hash = p_cancel_hash, cancel_rotations = 1 where id = r.id;
  perform public.admin_mfa_recovery_log(r.id, r.user_id, 'approved', p_actor_user_id, null);
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'userId', r.user_id, 'cancelRotation', 1,
    'email', (select u.email::text from auth.users u where u.id = r.user_id));
end;
$$;

create or replace function public.admin_mfa_recovery_deny(p_recovery_id uuid, p_actor_user_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_recovery_id is null or p_actor_user_id is null then raise exception 'invalid_argument'; end if;
  if not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  if char_length(v_reason) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.user_id = p_actor_user_id then return jsonb_build_object('ok', false, 'reason', 'self_approval'); end if;
  if r.status not in ('pending_approval', 'approved') then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', r.status);
  end if;
  perform public.admin_mfa_recovery_close(r.id, 'denied', 'denied_by_admin', p_actor_user_id, v_reason);
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'userId', r.user_id,
    'email', (select u.email::text from auth.users u where u.id = r.user_id));
end;
$$;

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

  -- Debe existir quien pueda aprobar: OTRO admin (aprobación normal) o, si el solicitante es el único
  -- admin, un DEVELOPER (aprobación excepcional). Sin ninguno de los dos no hay camino de recuperación.
  if not exists (select 1 from public.admin_roles ar where ar.role = 'admin' and ar.user_id <> p_user_id)
     and not exists (select 1 from public.admin_roles ar where ar.role = 'developer') then
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

drop function if exists public.admin_developer_cooldown_ready_at(uuid);
drop function if exists public.admin_developer_cooldown_minutes();
drop table if exists public.admin_developer_settings_audit;
drop table if exists public.admin_developer_settings;

create function public.operator_grant_developer(p_target_user_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_old text; v_note text := btrim(coalesce(p_note, ''));
begin
  if p_target_user_id is null or char_length(v_note) not between 1 and 80 then
    raise exception 'invalid_argument';
  end if;
  perform public.upmina_lock_admin_roles();
  select ar.role into v_old from public.admin_roles ar where ar.user_id = p_target_user_id for update;
  if not found then raise exception 'member_not_found'; end if;
  if v_old <> 'moderator' then raise exception 'grant_requires_moderator'; end if;
  if not exists (
    select 1 from auth.mfa_factors f
     where f.user_id = p_target_user_id and f.factor_type::text = 'totp' and f.status::text = 'verified') then
    raise exception 'mfa_not_enrolled';
  end if;
  update public.admin_roles set role = 'developer' where user_id = p_target_user_id;
  insert into public.admin_developer_audit (action, target_user_id, previous_role, new_role, operator_note)
    values ('granted', p_target_user_id, 'moderator', 'developer', v_note);
  return jsonb_build_object('ok', true, 'previous_role', 'moderator', 'new_role', 'developer');
end;
$$;
alter function public.operator_grant_developer(uuid, text) owner to postgres;
revoke execute on function public.operator_grant_developer(uuid, text) from public, anon, authenticated, service_role;

drop index if exists public.admin_developer_audit_target_idx;
alter table public.admin_developer_audit drop constraint admin_developer_audit_shape_check;
alter table public.admin_developer_audit add constraint admin_developer_audit_shape_check check (
    (action = 'granted' and previous_role = 'moderator' and new_role = 'developer')
    or (action = 'revoked' and previous_role = 'developer' and new_role = 'moderator'));
alter table public.admin_developer_audit alter column operator_note set not null;
alter table public.admin_developer_audit drop column actor_user_id;
