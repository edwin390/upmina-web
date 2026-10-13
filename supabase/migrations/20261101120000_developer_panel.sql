-- DEVELOPER PANEL V1 — rol Developer independiente de Admin + aprobación EXCEPCIONAL de la recuperación
-- de MFA (fase 2) cuando el solicitante es el único administrador elegible + supervisión de solo
-- lectura de las limpiezas de MFA (fase 1). PROPUESTA LOCAL: NO aplicada en ningún entorno.
-- Forward-only, posterior a 20261031150000. Nada anterior se edita salvo `create or replace` de cuatro
-- funciones (create de la fase 2, guard de la fase 2, change_admin_member_role y remove_admin_member),
-- cada una con UN añadido documentado abajo; firmas, propietario y grants no cambian.
--
-- Decisiones (una frase cada una):
--   * Developer y Admin son roles INDEPENDIENTES: ningún privilegio se hereda. Developer no puede usar
--     las RPC de Admin (todas exigen role = 'admin') ni Admin las de Developer (exigen 'developer').
--   * Admin NO concede, retira ni modifica Developer: change_admin_member_role y remove_admin_member
--     lanzan 'developer_protected' si el rol nuevo o el anterior es developer (y remove_admin_member_with_
--     mfa_reset hereda la protección porque llama a remove_admin_member). Las invitaciones y el
--     bootstrap tampoco lo admiten (CHECK de admin_invitations.role, sin cambios).
--   * El rol Developer solo lo asigna el OPERADOR (SQL como propietario): operator_grant_developer y
--     operator_revoke_developer NO son ejecutables por service_role ni por ningún rol de API, de modo
--     que ni el backend puede asignarlo. Exige una cuenta que ya es moderator con un TOTP verificado y
--     deja una fila append-only en admin_developer_audit (con nota del operador).
--   * "Otro administrador elegible" = distinto del solicitante, con rol admin vigente, cuenta no
--     eliminada ni bloqueada y con TOTP verificado (admin_mfa_recovery_peer_available). La ausencia
--     temporal o la pérdida declarada del dispositivo NO cuenta como inelegibilidad.
--   * Si hay otro admin elegible, SOLO otro admin aprueba (flujo normal, sin cambios). Si el solicitante es
--     el único admin elegible, un DEVELOPER distinto puede aprobar o rechazar (EXCEPCIONAL). La
--     elegibilidad se recalcula DENTRO de la transacción de aprobación, tras tomar el lock compartido de
--     admin_roles (upmina_lock_admin_roles) ANTES de cualquier FOR UPDATE.
--   * La aprobación excepcional deja approval_kind = 'exceptional' y approver_role = 'developer' (la
--     fila normal queda 'peer'); el evento 'approved' lleva detalle 'exceptional:developer'. Todo lo
--     demás (aviso entregado, espera de 15 min, instantánea, borrado exacto, TOTP nuevo, cierre
--     automático) es el MISMO mecanismo de la fase 2.
--   * Las solicitudes anteriores quedan 'peer' con approver_role nulo (= admin, histórico): no se tocan.
--   * Las lecturas de Developer no devuelven correos completos, ids de factores, hashes ni tokens.
-- Rollback (solo local/operador): supabase/rollbacks/20261101120000_developer_panel.rollback.sql

-- ---------------------------------------------------------------------------------------------
-- 1. admin_mfa_recoveries: tipo de aprobación y rol de quien aprobó (aditivo y compatible)
-- ---------------------------------------------------------------------------------------------
alter table public.admin_mfa_recoveries
  add column approval_kind text not null default 'peer',
  add column approver_role text;
alter table public.admin_mfa_recoveries
  add constraint admin_mfa_recoveries_approval_check check (
    (approval_kind = 'peer' and (approver_role is null or approver_role = 'admin'))
    or (approval_kind = 'exceptional' and approver_role = 'developer'));

-- Guard: igual que antes y, además, el tipo de aprobación solo se fija al aprobar (desde pending_approval).
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
  -- El tipo de aprobación solo se fija al aprobar (desde pending_approval); después es inmutable.
  if (new.approval_kind is distinct from old.approval_kind or new.approver_role is distinct from old.approver_role)
     and old.status <> 'pending_approval' then
    raise exception 'mfa_recovery_approval_immutable';
  end if;
  return new;
end;
$$;
alter function public.admin_mfa_recoveries_guard() owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 2. Elegibilidad de otro administrador (interna: solo la usan las funciones de abajo)
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_recovery_peer_available(p_user uuid) returns boolean
language sql security definer stable set search_path = pg_catalog, public as $$
  select exists (
    select 1
      from public.admin_roles ar
      join auth.users u on u.id = ar.user_id
     where ar.role = 'admin'
       and ar.user_id <> p_user
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
       and exists (
         select 1 from auth.mfa_factors f
          where f.user_id = ar.user_id and f.factor_type::text = 'totp' and f.status::text = 'verified')
  );
$$;
alter function public.admin_mfa_recovery_peer_available(uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 3. La solicitud puede crearse si hay quien la apruebe: otro admin, o (si el solicitante es el único
--    admin) un Developer. Es la única diferencia con la versión de la fase 2.
-- ---------------------------------------------------------------------------------------------
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
alter function public.admin_mfa_recovery_create(uuid, text) owner to postgres;

-- El titular ve "hay quien apruebe" con los mismos criterios que la creación (otro admin o un Developer).
create or replace function public.admin_mfa_recovery_current(p_user_id uuid)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_notice text; v_has_approver boolean;
begin
  if p_user_id is null then raise exception 'invalid_argument'; end if;
  -- Quien aprueba: otro admin (flujo normal) o, si no lo hay, un Developer (aprobación excepcional).
  select exists (select 1 from public.admin_roles ar where ar.role = 'admin' and ar.user_id <> p_user_id)
      or exists (select 1 from public.admin_roles ar where ar.role = 'developer')
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

-- ---------------------------------------------------------------------------------------------
-- 4. Aprobación y rechazo EXCEPCIONALES (solo DEVELOPER, solo para el único admin elegible)
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_recovery_approve_exceptional(
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
alter function public.admin_mfa_recovery_approve_exceptional(uuid, uuid, text) owner to postgres;

-- Rechazo: solicitudes elegibles en pending_approval, o su propia aprobación excepcional antes de ejecutar.
create function public.admin_mfa_recovery_deny_exceptional(p_recovery_id uuid, p_actor_user_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_recovery_id is null or p_actor_user_id is null then raise exception 'invalid_argument'; end if;
  perform public.upmina_lock_admin_roles();
  if not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'developer') then
    raise exception 'actor_not_developer';
  end if;
  if char_length(v_reason) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.user_id = p_actor_user_id then return jsonb_build_object('ok', false, 'reason', 'self_approval'); end if;
  if r.status = 'approved' and r.approval_kind = 'exceptional' then
    null; -- puede revertir SU aprobación excepcional mientras no se ejecute
  elsif r.status = 'pending_approval' then
    if r.role_at_request <> 'admin' then return jsonb_build_object('ok', false, 'reason', 'not_eligible'); end if;
    if public.admin_mfa_recovery_peer_available(r.user_id) then
      return jsonb_build_object('ok', false, 'reason', 'peer_available');
    end if;
  else
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', r.status);
  end if;
  perform public.admin_mfa_recovery_close(r.id, 'denied', 'denied_by_developer', p_actor_user_id, v_reason);
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'userId', r.user_id,
    'email', (select u.email::text from auth.users u where u.id = r.user_id));
end;
$$;
alter function public.admin_mfa_recovery_deny_exceptional(uuid, uuid, text) owner to postgres;

-- Lista para Developer: SOLO las solicitudes elegibles (más el historial de las excepcionales de los
-- últimos 30 días). Sin correo ni ids de factores.
create function public.admin_mfa_recoveries_exceptional(p_actor_user_id uuid)
returns table (
  out_id uuid, out_username text, out_role text, out_status text,
  out_requested_at timestamptz, out_email_verified_at timestamptz, out_expires_at timestamptz,
  out_approved_at timestamptz, out_approval_kind text, out_approver_role text, out_approver_username text,
  out_notice_state text, out_readiness text, out_eligible boolean, out_closed_reason text
) language plpgsql security definer stable set search_path = pg_catalog, public as $$
begin
  if p_actor_user_id is null
     or not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'developer') then
    raise exception 'actor_not_developer';
  end if;
  return query
    select r.id, p.username, r.role_at_request, r.status, r.requested_at, r.email_verified_at, r.expires_at,
           r.approved_at, r.approval_kind, r.approver_role, ap.username,
           (select m.state from public.admin_mfa_recovery_mail m
             where m.recovery_id = r.id and m.kind = 'approved' order by m.created_at desc, m.id limit 1),
           public.admin_mfa_recovery_readiness(r.id),
           (r.status = 'pending_approval' and r.expires_at > now()),
           r.closed_reason
      from public.admin_mfa_recoveries r
      left join public.profiles p on p.user_id = r.user_id
      left join public.profiles ap on ap.user_id = r.approved_by
     where r.requested_at > now() - interval '30 days'
       and (
         (r.status = 'pending_approval' and r.expires_at > now() and r.role_at_request = 'admin'
            and r.user_id <> p_actor_user_id
            and not public.admin_mfa_recovery_peer_available(r.user_id))
         or r.approval_kind = 'exceptional'
         or r.closed_reason = 'denied_by_developer')
     order by r.requested_at desc
     limit 50;
end;
$$;
alter function public.admin_mfa_recoveries_exceptional(uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 5. Supervisión de limpiezas de MFA para Developer (SOLO LECTURA)
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_cleanups_for_developer(p_actor_user_id uuid)
returns table (
  out_status text, out_old_role text, out_requested_at timestamptz, out_completed_at timestamptz,
  out_attempts integer, out_last_attempt_at timestamptz, out_last_error_class text,
  out_factor_count integer, out_factors_deleted integer, out_username text, out_email_masked text
) language plpgsql security definer stable set search_path = pg_catalog, public as $$
begin
  if p_actor_user_id is null
     or not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'developer') then
    raise exception 'actor_not_developer';
  end if;
  return query
    select r.status, r.old_role, r.requested_at, r.completed_at, r.attempts, r.last_attempt_at,
           r.last_error_class, cardinality(r.factor_ids), r.factors_deleted, p.username,
           case when u.email is null or position('@' in u.email::text) < 2 then null
                else left(split_part(u.email::text, '@', 1), 1) || '***@'
                  || left(split_part(u.email::text, '@', 2), 1) || '***'
                  || coalesce(substring(split_part(u.email::text, '@', 2) from '\.[^.]*$'), '')
           end
      from public.admin_mfa_resets r
      left join public.profiles p on p.user_id = r.user_id
      left join auth.users u on u.id = r.user_id
     order by (r.status = 'pending') desc, r.requested_at desc
     limit 50;
end;
$$;
alter function public.admin_mfa_cleanups_for_developer(uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 6. Asignación del rol Developer: SOLO OPERADOR (no ejecutable por ningún rol de API)
-- ---------------------------------------------------------------------------------------------
create table public.admin_developer_audit (
  id             uuid primary key default gen_random_uuid(),
  action         text not null,
  target_user_id uuid not null,
  previous_role  text not null,
  new_role       text not null,
  operator_note  text not null,
  created_at     timestamptz not null default clock_timestamp(),
  constraint admin_developer_audit_shape_check check (
    (action = 'granted' and previous_role = 'moderator' and new_role = 'developer')
    or (action = 'revoked' and previous_role = 'developer' and new_role = 'moderator')),
  constraint admin_developer_audit_note_check check (char_length(operator_note) between 1 and 80)
);
alter table public.admin_developer_audit enable row level security;
alter table public.admin_developer_audit force row level security;
revoke all on public.admin_developer_audit from public, anon, authenticated, service_role;

create function public.admin_developer_audit_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'developer_audit_append_only';
end;
$$;
alter function public.admin_developer_audit_append_only() owner to postgres;
create trigger admin_developer_audit_append_only before update or delete
  on public.admin_developer_audit for each row execute function public.admin_developer_audit_append_only();

-- moderator con TOTP verificado -> developer. Se ejecuta como propietario desde el editor SQL.
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

-- developer -> moderator (nunca borra el acceso; quitarlo del todo sigue siendo cosa de Admin sobre un moderator).
create function public.operator_revoke_developer(p_target_user_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_old text; v_note text := btrim(coalesce(p_note, ''));
begin
  if p_target_user_id is null or char_length(v_note) not between 1 and 80 then
    raise exception 'invalid_argument';
  end if;
  perform public.upmina_lock_admin_roles();
  select ar.role into v_old from public.admin_roles ar where ar.user_id = p_target_user_id for update;
  if not found then raise exception 'member_not_found'; end if;
  if v_old <> 'developer' then raise exception 'revoke_requires_developer'; end if;
  update public.admin_roles set role = 'moderator' where user_id = p_target_user_id;
  insert into public.admin_developer_audit (action, target_user_id, previous_role, new_role, operator_note)
    values ('revoked', p_target_user_id, 'developer', 'moderator', v_note);
  return jsonb_build_object('ok', true, 'previous_role', 'developer', 'new_role', 'moderator');
end;
$$;
alter function public.operator_revoke_developer(uuid, text) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 7. Admin NO toca Developer: mismas funciones de 9F con UNA comprobación añadida
-- ---------------------------------------------------------------------------------------------
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
  -- Developer es independiente de Admin: ni se concede ni se retira ni se modifica desde aquí.
  if v_old_role = 'developer' or p_new_role = 'developer' then
    raise exception 'developer_protected';
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

  -- Developer es independiente de Admin: Admin no puede retirarle el acceso.
  if v_old_role = 'developer' then
    raise exception 'developer_protected';
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


-- ---------------------------------------------------------------------------------------------
-- 8. Permisos: solo service_role (las de operador, NINGUNO) y nada para clientes
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.admin_mfa_recovery_peer_available(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.admin_developer_audit_append_only() from public, anon, authenticated, service_role;
revoke execute on function public.operator_grant_developer(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.operator_revoke_developer(uuid, text) from public, anon, authenticated, service_role;

revoke execute on function public.admin_mfa_recovery_approve_exceptional(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_deny_exceptional(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recoveries_exceptional(uuid) from public, anon, authenticated;
revoke execute on function public.admin_mfa_cleanups_for_developer(uuid) from public, anon, authenticated;

grant execute on function public.admin_mfa_recovery_approve_exceptional(uuid, uuid, text) to service_role;
grant execute on function public.admin_mfa_recovery_deny_exceptional(uuid, uuid, text) to service_role;
grant execute on function public.admin_mfa_recoveries_exceptional(uuid) to service_role;
grant execute on function public.admin_mfa_cleanups_for_developer(uuid) to service_role;
