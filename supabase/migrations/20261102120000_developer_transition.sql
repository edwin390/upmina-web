-- DEVELOPER PANEL V1 — TRANSICIÓN Admin → Developer por AUTOTRANSFERENCIA. PROPUESTA LOCAL: NO aplicada.
-- Forward-only, posterior a 20261101120000 (que no se modifica). Sustituye al alta de Developer por el
-- operador: ahora un ADMIN solo puede transferir SU PROPIA cuenta y otro ADMIN puede restaurar a un
-- Developer como Admin o Moderator.
--
-- Decisiones (una frase cada una):
--   * admin_transfer_self_to_developer(actor) NO tiene parámetro de objetivo: solo transfiere al propio
--     actor (que sale del JWT en el backend). No existe ninguna función que asigne Developer a otra cuenta;
--     change_admin_member_role / remove_admin_member siguen rechazando developer (developer_protected).
--   * Requisitos de la transferencia (todo bajo upmina_lock_admin_roles, tomado PRIMERO): el actor es admin;
--     existe OTRO admin elegible (admin_mfa_recovery_peer_available: vigente, no bloqueado/eliminado, TOTP
--     verificado); NO hay ninguna recuperación de MFA activa de ningún admin; el trigger de último admin
--     sigue siendo la red de seguridad. Efecto: el rol pasa a developer, se revocan sus invitaciones pendientes
--     (como al dejar de ser admin) y se registra una fila append-only en admin_developer_audit.
--   * admin_restore_developer(actor, target, rol): un ADMIN distinto devuelve a un Developer a admin o
--     moderator (nunca a developer). No admite recuperación activa del objetivo y, para admin, exige TOTP verificado.
--   * Un Developer no tiene ninguna función para cambiar su rol; quitarse Developer exige a otro Admin.
--   * Espera de seguridad ANTES de aprobar recuperaciones excepcionales tras transferirse:
--     - La fuente de configuración es la tabla admin_developer_settings (SQL no puede leer variables de
--       entorno de forma fiable y el frontend nunca es autoridad). Sin fila, el valor por defecto es CONSERVADOR
--       (1440 min = 24 h): la migración NO fija 60 en ningún entorno; cada entorno lo configura de forma
--       explícita con operator_set_developer_cooldown (solo operador; auditado en admin_developer_settings_audit).
--     - El inicio de la espera es el momento de la autotransferencia registrado en admin_developer_audit
--       (append-only, clock_timestamp): recargar, abrir otra sesión o reintentar no lo reinicia. Siempre cuenta la
--       transferencia (o alta del operador) MÁS RECIENTE: restaurar y volver a transferirse genera un inicio nuevo,
--       nunca uno anterior.
--     - La espera se comprueba dentro de admin_mfa_recovery_approve_exceptional (SQL) y también en el backend.
--       Rechazar o revertir NO están sujetos a la espera: solo restringen.
--   * admin_mfa_recovery_approve / deny / create toman ahora el lock de roles (primera sentencia) para que
--     ninguna aprobación ni solicitud corra contra una transferencia o restauración.
--   * operator_grant_developer se RETIRA; operator_revoke_developer se conserva como mecanismo de emergencia.
-- Rollback (solo local/operador): supabase/rollbacks/20261102120000_developer_transition.rollback.sql

-- ---------------------------------------------------------------------------------------------
-- 1. Auditoría de Developer: actor y nuevas acciones
-- ---------------------------------------------------------------------------------------------
alter table public.admin_developer_audit add column actor_user_id uuid;
alter table public.admin_developer_audit alter column operator_note drop not null;
alter table public.admin_developer_audit drop constraint admin_developer_audit_shape_check;
alter table public.admin_developer_audit add constraint admin_developer_audit_shape_check check (
  (action = 'granted' and previous_role = 'moderator' and new_role = 'developer'
     and actor_user_id is null and operator_note is not null)
  or (action = 'revoked' and previous_role = 'developer' and new_role = 'moderator'
     and actor_user_id is null and operator_note is not null)
  or (action = 'self_transferred' and previous_role = 'admin' and new_role = 'developer'
     and actor_user_id = target_user_id and operator_note is null)
  or (action = 'restored' and previous_role = 'developer' and new_role in ('admin', 'moderator')
     and actor_user_id is not null and actor_user_id <> target_user_id and operator_note is null));
create index admin_developer_audit_target_idx on public.admin_developer_audit (target_user_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- 2. Configuración de la espera (fuente segura y consistente) + su historial
-- ---------------------------------------------------------------------------------------------
create table public.admin_developer_settings (
  key        text primary key,
  int_value  integer not null,
  updated_at timestamptz not null default now(),
  constraint admin_developer_settings_key_check check (key in ('exceptional_approval_cooldown_minutes')),
  constraint admin_developer_settings_value_check check (int_value between 0 and 10080)
);
alter table public.admin_developer_settings enable row level security;
alter table public.admin_developer_settings force row level security;
revoke all on public.admin_developer_settings from public, anon, authenticated, service_role;

create table public.admin_developer_settings_audit (
  id         uuid primary key default gen_random_uuid(),
  key        text not null,
  old_value  integer,
  new_value  integer not null,
  note       text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint admin_developer_settings_audit_note_check check (char_length(note) between 1 and 80)
);
alter table public.admin_developer_settings_audit enable row level security;
alter table public.admin_developer_settings_audit force row level security;
revoke all on public.admin_developer_settings_audit from public, anon, authenticated, service_role;
create trigger admin_developer_settings_audit_append_only before update or delete
  on public.admin_developer_settings_audit for each row execute function public.admin_developer_audit_append_only();

-- Espera efectiva en minutos: la fila configurada o, sin fila, el valor CONSERVADOR de 24 h.
create function public.admin_developer_cooldown_minutes() returns integer
language sql security definer stable set search_path = pg_catalog, public as $$
  select coalesce(
    (select s.int_value from public.admin_developer_settings s where s.key = 'exceptional_approval_cooldown_minutes'),
    1440);
$$;
alter function public.admin_developer_cooldown_minutes() owner to postgres;

-- Instante a partir del cual `p_user` puede aprobar: transferencia (o alta del operador) MÁS RECIENTE + espera.
-- null = nunca se transfirió (sin espera). La espera de hoy se evalúa con el valor vigente de la configuración.
create function public.admin_developer_cooldown_ready_at(p_user uuid) returns timestamptz
language sql security definer stable set search_path = pg_catalog, public as $$
  select max(a.created_at) + make_interval(mins => public.admin_developer_cooldown_minutes())
    from public.admin_developer_audit a
   where a.target_user_id = p_user and a.action in ('self_transferred', 'granted');
$$;
alter function public.admin_developer_cooldown_ready_at(uuid) owner to postgres;

-- Estado de la espera para la interfaz (solo Developer; solo lectura).
create function public.admin_developer_cooldown(p_actor_user_id uuid) returns jsonb
language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_ready timestamptz; v_now timestamptz := clock_timestamp();
begin
  if p_actor_user_id is null
     or not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'developer') then
    raise exception 'actor_not_developer';
  end if;
  v_ready := public.admin_developer_cooldown_ready_at(p_actor_user_id);
  return jsonb_build_object(
    'ready', v_ready is null or v_now >= v_ready,
    'readyAt', v_ready,
    'remainingSeconds', case when v_ready is null or v_now >= v_ready then 0
                             else ceil(extract(epoch from (v_ready - v_now)))::integer end,
    'cooldownMinutes', public.admin_developer_cooldown_minutes());
end;
$$;
alter function public.admin_developer_cooldown(uuid) owner to postgres;

-- Solo operador: fija la espera (0–10080 min). No ejecutable por ningún rol de API.
create function public.operator_set_developer_cooldown(p_minutes integer, p_note text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_old integer; v_note text := btrim(coalesce(p_note, ''));
begin
  if p_minutes is null or p_minutes not between 0 and 10080 or char_length(v_note) not between 1 and 80 then
    raise exception 'invalid_argument';
  end if;
  perform public.upmina_lock_admin_roles();
  select s.int_value into v_old from public.admin_developer_settings s
   where s.key = 'exceptional_approval_cooldown_minutes' for update;
  insert into public.admin_developer_settings (key, int_value, updated_at)
    values ('exceptional_approval_cooldown_minutes', p_minutes, now())
    on conflict (key) do update set int_value = excluded.int_value, updated_at = now();
  insert into public.admin_developer_settings_audit (key, old_value, new_value, note)
    values ('exceptional_approval_cooldown_minutes', v_old, p_minutes, v_note);
  return jsonb_build_object('ok', true, 'previous', v_old, 'minutes', p_minutes);
end;
$$;
alter function public.operator_set_developer_cooldown(integer, text) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 3. Autotransferencia Admin -> Developer (solo el propio actor)
-- ---------------------------------------------------------------------------------------------
create function public.admin_transfer_status(p_actor_user_id uuid) returns jsonb
language plpgsql security definer stable set search_path = pg_catalog, public as $$
begin
  if p_actor_user_id is null
     or not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  if not public.admin_mfa_recovery_peer_available(p_actor_user_id) then
    return jsonb_build_object('eligible', false, 'reason', 'no_eligible_peer');
  end if;
  if exists (select 1 from public.admin_mfa_recoveries r
              where r.role_at_request = 'admin'
                and r.status in ('pending_email', 'pending_approval', 'approved', 'executing', 'factors_deleted')) then
    return jsonb_build_object('eligible', false, 'reason', 'recovery_in_progress');
  end if;
  return jsonb_build_object('eligible', true, 'reason', 'ok');
end;
$$;
alter function public.admin_transfer_status(uuid) owner to postgres;

create function public.admin_transfer_self_to_developer(p_actor_user_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_role text; v_now timestamptz;
begin
  if p_actor_user_id is null then raise exception 'invalid_argument'; end if;
  -- El lock compartido de roles va PRIMERO (regla de 9B).
  perform public.upmina_lock_admin_roles();
  v_now := pg_catalog.clock_timestamp();
  select ar.role into v_role from public.admin_roles ar where ar.user_id = p_actor_user_id for update;
  if v_role is distinct from 'admin' then raise exception 'actor_not_admin'; end if;
  -- Debe quedar OTRO admin elegible (revalidado aquí, en la misma transacción).
  if not public.admin_mfa_recovery_peer_available(p_actor_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_eligible_peer');
  end if;
  -- Ninguna recuperación de MFA activa de ningún admin: cierra las carreras con la fase 2.
  if exists (select 1 from public.admin_mfa_recoveries r
              where r.role_at_request = 'admin'
                and r.status in ('pending_email', 'pending_approval', 'approved', 'executing', 'factors_deleted')) then
    return jsonb_build_object('ok', false, 'reason', 'recovery_in_progress');
  end if;
  -- El trigger admin_roles_last_admin_guard sigue vigilando que no se quede el sistema sin admin.
  update public.admin_roles set role = 'developer' where user_id = p_actor_user_id;
  -- Como al dejar de ser admin: sus invitaciones estándar pendientes se revocan.
  update public.admin_invitations i
     set revoked_at = v_now, revoked_by = p_actor_user_id
   where i.invitation_type = 'standard' and i.created_by = p_actor_user_id
     and i.consumed_at is null and i.revoked_at is null and i.expires_at >= v_now;
  insert into public.admin_developer_audit (action, target_user_id, actor_user_id, previous_role, new_role, created_at)
    values ('self_transferred', p_actor_user_id, p_actor_user_id, 'admin', 'developer', v_now);
  return jsonb_build_object('ok', true, 'transferredAt', v_now,
    'cooldownReadyAt', v_now + make_interval(mins => public.admin_developer_cooldown_minutes()));
end;
$$;
alter function public.admin_transfer_self_to_developer(uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 4. Restauración de un Developer por OTRO admin (a admin o moderator; nunca a developer)
-- ---------------------------------------------------------------------------------------------
create function public.admin_restore_developer(p_actor_user_id uuid, p_target_user_id uuid, p_new_role text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_old text; v_now timestamptz;
begin
  if p_actor_user_id is null or p_target_user_id is null or p_new_role is null then
    raise exception 'invalid_argument';
  end if;
  if p_new_role not in ('admin', 'moderator') then raise exception 'invalid_role'; end if;
  perform public.upmina_lock_admin_roles();
  v_now := pg_catalog.clock_timestamp();
  if not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  if p_actor_user_id = p_target_user_id then raise exception 'self_change_not_allowed'; end if;
  select ar.role into v_old from public.admin_roles ar where ar.user_id = p_target_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_old <> 'developer' then return jsonb_build_object('ok', false, 'reason', 'not_developer'); end if;
  if exists (select 1 from public.admin_mfa_recoveries r
              where r.user_id = p_target_user_id
                and r.status in ('pending_email', 'pending_approval', 'approved', 'executing', 'factors_deleted')) then
    return jsonb_build_object('ok', false, 'reason', 'recovery_in_progress');
  end if;
  if p_new_role = 'admin' and not exists (
    select 1 from auth.mfa_factors f
     where f.user_id = p_target_user_id and f.factor_type::text = 'totp' and f.status::text = 'verified') then
    return jsonb_build_object('ok', false, 'reason', 'mfa_not_enrolled');
  end if;
  update public.admin_roles set role = p_new_role where user_id = p_target_user_id;
  insert into public.admin_developer_audit (action, target_user_id, actor_user_id, previous_role, new_role, created_at)
    values ('restored', p_target_user_id, p_actor_user_id, 'developer', p_new_role, v_now);
  return jsonb_build_object('ok', true, 'previousRole', 'developer', 'newRole', p_new_role);
end;
$$;
alter function public.admin_restore_developer(uuid, uuid, text) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 5. Se retira el alta por el operador (se conserva operator_revoke_developer como emergencia)
-- ---------------------------------------------------------------------------------------------
drop function public.operator_grant_developer(uuid, text);

-- ---------------------------------------------------------------------------------------------
-- 6. Recuperaciones: lock de roles en aprobación/rechazo/creación y espera en la aprobación excepcional
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_mfa_recovery_approve(p_recovery_id uuid, p_actor_user_id uuid, p_cancel_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_role text;
begin
  if p_recovery_id is null or p_actor_user_id is null or p_cancel_hash is null or p_cancel_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_argument';
  end if;
  -- El lock compartido de roles va PRIMERO (regla de 9B): ninguna decisión corre contra un cambio de roles.
  perform public.upmina_lock_admin_roles();
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
  -- El lock compartido de roles va PRIMERO (regla de 9B): ninguna decisión corre contra un cambio de roles.
  perform public.upmina_lock_admin_roles();
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
  -- El lock compartido de roles va PRIMERO (regla de 9B): ninguna decisión corre contra un cambio de roles.
  perform public.upmina_lock_admin_roles();
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

create or replace function public.admin_mfa_recovery_approve_exceptional(
  p_recovery_id uuid, p_actor_user_id uuid, p_cancel_hash text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_role text; v_ready timestamptz;
begin
  if p_recovery_id is null or p_actor_user_id is null or p_cancel_hash is null or p_cancel_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_argument';
  end if;
  -- El lock compartido de roles va PRIMERO (regla de 9B): un cambio de roles concurrente espera.
  perform public.upmina_lock_admin_roles();
  if not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'developer') then
    raise exception 'actor_not_developer';
  end if;
  -- Espera de seguridad tras la autotransferencia (la fuente es admin_developer_settings; ver arriba).
  -- Se compara con clock_timestamp(): nada de lo que envíe el cliente la acorta. Se cumple EXACTAMENTE al llegar.
  v_ready := public.admin_developer_cooldown_ready_at(p_actor_user_id);
  if v_ready is not null and pg_catalog.clock_timestamp() < v_ready then
    return jsonb_build_object('ok', false, 'reason', 'cooldown_active', 'readyAt', v_ready);
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

-- ---------------------------------------------------------------------------------------------
-- 7. Permisos: solo service_role (las de operador y las internas, NINGUNO)
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.admin_developer_cooldown_minutes() from public, anon, authenticated, service_role;
revoke execute on function public.admin_developer_cooldown_ready_at(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.operator_set_developer_cooldown(integer, text) from public, anon, authenticated, service_role;

revoke execute on function public.admin_developer_cooldown(uuid) from public, anon, authenticated;
revoke execute on function public.admin_transfer_status(uuid) from public, anon, authenticated;
revoke execute on function public.admin_transfer_self_to_developer(uuid) from public, anon, authenticated;
revoke execute on function public.admin_restore_developer(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_developer_cooldown(uuid) to service_role;
grant execute on function public.admin_transfer_status(uuid) to service_role;
grant execute on function public.admin_transfer_self_to_developer(uuid) to service_role;
grant execute on function public.admin_restore_developer(uuid, uuid, text) to service_role;
