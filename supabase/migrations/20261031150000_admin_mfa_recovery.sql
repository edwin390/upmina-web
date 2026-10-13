-- 9K / MFA FASE 2 — recuperación de un autenticador PERDIDO sin perder el rol. PROPUESTA LOCAL: NO
-- aplicada en ningún entorno. Forward-only; independiente de la fase 1 (20261031140000), de la que
-- solo reutiliza el patrón (instantánea de ids de factores, borrado exacto, reintento idempotente).
--
-- Modelo (una frase cada decisión):
--   * Una solicitud por cuenta (índice único parcial) recorre: pending_email → pending_approval →
--     approved → executing → factors_deleted → completed. Cierres: denied, cancelled, expired.
--   * El titular solicita desde su sesión (aal1 basta); el SERVIDOR comprueba rol e identidad y
--     fija el user_id: la base nunca recibe un usuario elegido por el cliente.
--   * Desafío de correo PROPIO: 256 bits aleatorios generados por el backend; aquí solo se guarda su
--     SHA-256. Ligado a la solicitud, al usuario y al correo registrado (hash del correo en la
--     solicitud; si cambia, la solicitud se cancela). Un solo uso (se borra al acertar), 15 min de
--     validez, 5 intentos y 3 envíos como máximo, con enfriamiento entre envíos.
--   * Aprobación: solo otro ADMIN (nunca el titular), solicitud vigente y correo verificado.
--   * La ejecución exige: aprobada, correo y rol sin cambios, y el aviso de aprobación CONFIRMADO
--     como entregado por el proveedor (estado 'delivered', no basta 'accepted'). La espera de 15 min
--     cuenta desde la aprobación Y desde esa entrega. La espera NO prueba identidad.
--   * La ejecución toma una instantánea de los ids TOTP y borra EXACTAMENTE esos ids (como en la
--     fase 1): un reintento tardío nunca toca un factor nuevo. 'factors_deleted' ≠ 'completed':
--     completed solo cuando la sesión acredita (auth.sessions) un TOTP verificado NUEVO.
--   * Enlace de cancelación en el correo de aprobación: token de 256 bits (solo su hash), un solo uso, sin
--     sesión ni TOTP, solo CANCELA (GET muestra confirmación; la cancelación es un POST explícito).
--   * El rol NO se toca en ningún paso. No se consume ninguna invitación.
-- Rollback (solo local/operador): supabase/rollbacks/20261031150000_admin_mfa_recovery.rollback.sql

-- ---------------------------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------------------------
create table public.admin_mfa_recoveries (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  role_at_request     text not null,
  status              text not null,
  email_hash          text not null,
  requested_at        timestamptz not null default now(),
  expires_at          timestamptz not null,
  challenge_hash      text,
  challenge_expires_at timestamptz,
  cancel_hash         text,
  cancel_rotations    integer not null default 0,
  challenge_attempts  integer not null default 0,
  challenge_sends     integer not null default 0,
  last_sent_at        timestamptz,
  email_verified_at   timestamptz,
  approved_by         uuid,
  approved_at         timestamptz,
  denied_reason       text,
  closed_by           uuid,
  closed_at           timestamptz,
  closed_reason       text,
  factor_ids          uuid[] not null default '{}',
  execution_attempts  integer not null default 0,
  last_error_class    text,
  executed_at         timestamptz,
  factors_deleted     integer,
  completed_at        timestamptz,

  constraint admin_mfa_recoveries_role_check check (role_at_request in ('admin', 'moderator', 'developer')),
  constraint admin_mfa_recoveries_status_check check (status in (
    'pending_email', 'pending_approval', 'approved', 'executing', 'factors_deleted',
    'completed', 'denied', 'cancelled', 'expired')),
  constraint admin_mfa_recoveries_hash_check check (
    (challenge_hash is null or challenge_hash ~ '^[0-9a-f]{64}$')
    and (cancel_hash is null or cancel_hash ~ '^[0-9a-f]{64}$') and email_hash ~ '^[0-9a-f]{64}$'),
  constraint admin_mfa_recoveries_reason_check check (
    (denied_reason is null or char_length(denied_reason) between 1 and 200)
    and (closed_reason is null or char_length(closed_reason) <= 60)),
  constraint admin_mfa_recoveries_snapshot_size check (cardinality(factor_ids) <= 20),
  constraint admin_mfa_recoveries_counters check (
    challenge_attempts >= 0 and challenge_sends >= 0 and execution_attempts >= 0)
);
-- UNA recuperación activa por cuenta.
create unique index admin_mfa_recoveries_one_active
  on public.admin_mfa_recoveries (user_id)
  where status in ('pending_email', 'pending_approval', 'approved', 'executing', 'factors_deleted');
-- El token de cancelacion identifica UNA solicitud.
create unique index admin_mfa_recoveries_cancel_hash on public.admin_mfa_recoveries (cancel_hash)
  where cancel_hash is not null;
create index admin_mfa_recoveries_user_requested on public.admin_mfa_recoveries (user_id, requested_at desc);

create table public.admin_mfa_recovery_events (
  id           bigint generated always as identity primary key,
  recovery_id  uuid not null references public.admin_mfa_recoveries (id),
  user_id      uuid not null,
  event        text not null,
  actor_user_id uuid,
  detail       text,
  created_at   timestamptz not null default now(),
  constraint admin_mfa_recovery_events_event_check check (event in (
    'requested', 'challenge_resent', 'email_verified', 'challenge_failed', 'approved', 'denied',
    'cancelled', 'expired', 'execution_started', 'execution_failed', 'factors_deleted',
    'completed', 'mail_state')),
  constraint admin_mfa_recovery_events_detail_check check (detail is null or char_length(detail) <= 80)
);

create table public.admin_mfa_recovery_mail (
  id                  uuid primary key default gen_random_uuid(),
  recovery_id         uuid not null references public.admin_mfa_recoveries (id),
  kind                text not null,
  idempotency_key     text not null unique,
  attempts            integer not null default 1,
  state               text not null default 'pending',
  provider_message_id text,
  error_class         text,
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default now(),
  delivered_at        timestamptz,
  constraint admin_mfa_recovery_mail_kind_check check (kind in ('challenge', 'approved', 'closed', 'completed')),
  constraint admin_mfa_recovery_mail_state_check check (state in ('pending', 'accepted', 'delivered', 'failed')),
  constraint admin_mfa_recovery_mail_key_check check (char_length(idempotency_key) between 10 and 120),
  constraint admin_mfa_recovery_mail_class_check check (error_class is null or char_length(error_class) <= 60),
  constraint admin_mfa_recovery_mail_provider_check check (provider_message_id is null or char_length(provider_message_id) <= 120)
);
create index admin_mfa_recovery_mail_provider on public.admin_mfa_recovery_mail (provider_message_id);
create index admin_mfa_recovery_mail_recovery on public.admin_mfa_recovery_mail (recovery_id, kind);

alter table public.admin_mfa_recoveries enable row level security;
alter table public.admin_mfa_recoveries force row level security;
alter table public.admin_mfa_recovery_events enable row level security;
alter table public.admin_mfa_recovery_events force row level security;
alter table public.admin_mfa_recovery_mail enable row level security;
alter table public.admin_mfa_recovery_mail force row level security;
revoke all on public.admin_mfa_recoveries from public, anon, authenticated, service_role;
revoke all on public.admin_mfa_recovery_events from public, anon, authenticated, service_role;
revoke all on public.admin_mfa_recovery_mail from public, anon, authenticated, service_role;

-- Guards: historial inmutable y cierres terminales.
create function public.admin_mfa_recoveries_guard() returns trigger
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
create trigger admin_mfa_recoveries_guard before update or delete on public.admin_mfa_recoveries
  for each row execute function public.admin_mfa_recoveries_guard();

create function public.admin_mfa_recovery_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'mfa_recovery_log_append_only';
end;
$$;
alter function public.admin_mfa_recovery_append_only() owner to postgres;
create trigger admin_mfa_recovery_events_append_only before update or delete
  on public.admin_mfa_recovery_events for each row execute function public.admin_mfa_recovery_append_only();

-- ---------------------------------------------------------------------------------------------
-- 2. Auxiliares internos (solo ejecutables por el propietario, desde las funciones de abajo)
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_recovery_log(
  p_recovery uuid, p_user uuid, p_event text, p_actor uuid, p_detail text
) returns void language sql security definer set search_path = pg_catalog, public as $$
  insert into public.admin_mfa_recovery_events (recovery_id, user_id, event, actor_user_id, detail)
  values (p_recovery, p_user, p_event, p_actor, left(p_detail, 80));
$$;
alter function public.admin_mfa_recovery_log(uuid, uuid, text, uuid, text) owner to postgres;

-- Hash del correo REGISTRADO ahora en Auth: detecta cambios de correo a mitad del proceso.
create function public.admin_mfa_recovery_email_hash(p_user uuid) returns text
language sql security definer stable set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(lower(u.email::text), 'UTF8')), 'hex')
    from auth.users u where u.id = p_user and u.email is not null;
$$;
alter function public.admin_mfa_recovery_email_hash(uuid) owner to postgres;

create function public.admin_mfa_recovery_close(
  p_id uuid, p_status text, p_reason text, p_actor uuid, p_denied_reason text default null
) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid;
begin
  update public.admin_mfa_recoveries
     set status = p_status, closed_by = p_actor, closed_at = now(), closed_reason = left(p_reason, 60),
         denied_reason = p_denied_reason, challenge_hash = null, cancel_hash = null
   where id = p_id returning user_id into v_user;
  perform public.admin_mfa_recovery_log(p_id, v_user,
    case p_status when 'denied' then 'denied' when 'expired' then 'expired' else 'cancelled' end,
    p_actor, p_reason);
end;
$$;
alter function public.admin_mfa_recovery_close(uuid, text, text, uuid, text) owner to postgres;

-- Instante a partir del cual se puede ejecutar: 15 min desde la aprobación Y desde la ENTREGA
-- confirmada del aviso de aprobación. null mientras el aviso no esté entregado.
create function public.admin_mfa_recovery_ready_at(p_id uuid) returns timestamptz
language sql security definer stable set search_path = pg_catalog, public as $$
  select greatest(r.approved_at, m.delivered_at) + interval '15 minutes'
    from public.admin_mfa_recoveries r
    join lateral (
      select x.state, x.delivered_at from public.admin_mfa_recovery_mail x
       where x.recovery_id = r.id and x.kind = 'approved' order by x.created_at desc, x.id limit 1
    ) m on true
   where r.id = p_id and m.state = 'delivered' and r.approved_at is not null;
$$;
alter function public.admin_mfa_recovery_ready_at(uuid) owner to postgres;

-- Motivo por el que NO se puede ejecutar todavía, o 'ready'.
create function public.admin_mfa_recovery_readiness(p_id uuid) returns text
language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare
  r public.admin_mfa_recoveries;
  v_role text;
  v_notice text;
  v_ready timestamptz;
begin
  select * into r from public.admin_mfa_recoveries where id = p_id;
  if not found then return 'not_found'; end if;
  if r.status <> 'approved' then return 'not_approved'; end if;
  if r.expires_at <= now() then return 'expired'; end if;
  if public.admin_mfa_recovery_email_hash(r.user_id) is distinct from r.email_hash then
    return 'email_changed';
  end if;
  select ar.role into v_role from public.admin_roles ar where ar.user_id = r.user_id;
  if v_role is distinct from r.role_at_request then return 'role_changed'; end if;
  -- Solo cuenta el ULTIMO aviso de aprobacion (el que lleva el enlace de cancelacion vigente).
  select m.state into v_notice from public.admin_mfa_recovery_mail m
   where m.recovery_id = p_id and m.kind = 'approved' order by m.created_at desc, m.id limit 1;
  if v_notice = 'failed' then return 'notice_failed'; end if;
  if v_notice is distinct from 'delivered' then return 'notice_pending'; end if;
  v_ready := public.admin_mfa_recovery_ready_at(p_id);
  if v_ready is null or v_ready > now() then return 'waiting'; end if;
  return 'ready';
end;
$$;
alter function public.admin_mfa_recovery_readiness(uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 3. Solicitud y desafío de correo
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_recovery_create(p_user_id uuid, p_challenge_hash text)
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

create function public.admin_mfa_recovery_resend(p_user_id uuid, p_challenge_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_email text;
begin
  if p_user_id is null or p_challenge_hash is null or p_challenge_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_argument';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery:' || p_user_id::text, 0));
  select * into r from public.admin_mfa_recoveries
   where user_id = p_user_id and status = 'pending_email' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_request'); end if;
  if r.expires_at <= now() then
    perform public.admin_mfa_recovery_close(r.id, 'expired', 'request_expired', null);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if public.admin_mfa_recovery_email_hash(p_user_id) is distinct from r.email_hash then
    perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'email_changed', null);
    return jsonb_build_object('ok', false, 'reason', 'email_changed');
  end if;
  if r.challenge_sends >= 3 then return jsonb_build_object('ok', false, 'reason', 'send_limit'); end if;
  if r.last_sent_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;
  update public.admin_mfa_recoveries
     set challenge_hash = p_challenge_hash, challenge_expires_at = now() + interval '15 minutes',
         challenge_attempts = 0, challenge_sends = challenge_sends + 1, last_sent_at = now()
   where id = r.id;
  perform public.admin_mfa_recovery_log(r.id, p_user_id, 'challenge_resent', p_user_id, null);
  select u.email::text into v_email from auth.users u where u.id = p_user_id;
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'email', v_email, 'sends', r.challenge_sends + 1);
end;
$$;
alter function public.admin_mfa_recovery_resend(uuid, text) owner to postgres;

-- Verifica el desafío. Los intentos fallidos se contabilizan (la función NO lanza: persiste).
create function public.admin_mfa_recovery_verify(p_user_id uuid, p_challenge_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_role text;
begin
  if p_user_id is null or p_challenge_hash is null or p_challenge_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery:' || p_user_id::text, 0));
  select * into r from public.admin_mfa_recoveries
   where user_id = p_user_id and status = 'pending_email' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_request'); end if;
  if r.expires_at <= now() then
    perform public.admin_mfa_recovery_close(r.id, 'expired', 'request_expired', null);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if public.admin_mfa_recovery_email_hash(p_user_id) is distinct from r.email_hash then
    perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'email_changed', null);
    return jsonb_build_object('ok', false, 'reason', 'email_changed');
  end if;
  select ar.role into v_role from public.admin_roles ar where ar.user_id = p_user_id;
  if v_role is distinct from r.role_at_request then
    perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'role_changed', null);
    return jsonb_build_object('ok', false, 'reason', 'role_changed');
  end if;
  if r.challenge_hash is null or r.challenge_expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'challenge_expired');
  end if;
  if r.challenge_attempts >= 5 then
    perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'too_many_attempts', null);
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;
  if r.challenge_hash <> p_challenge_hash then
    update public.admin_mfa_recoveries set challenge_attempts = challenge_attempts + 1 where id = r.id;
    perform public.admin_mfa_recovery_log(r.id, p_user_id, 'challenge_failed', p_user_id,
      (r.challenge_attempts + 1)::text);
    if r.challenge_attempts + 1 >= 5 then
      perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'too_many_attempts', null);
      return jsonb_build_object('ok', false, 'reason', 'locked');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- Un solo uso: el hash se destruye al acertar.
  update public.admin_mfa_recoveries
     set status = 'pending_approval', email_verified_at = now(), challenge_hash = null,
         challenge_expires_at = null
   where id = r.id;
  perform public.admin_mfa_recovery_log(r.id, p_user_id, 'email_verified', p_user_id, null);
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'status', 'pending_approval');
end;
$$;
alter function public.admin_mfa_recovery_verify(uuid, text) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 4. Cancelación, aprobación y rechazo
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_recovery_cancel(p_recovery_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_actor_admin boolean;
begin
  if p_recovery_id is null or p_actor_user_id is null then raise exception 'invalid_argument'; end if;
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'admin')
    into v_actor_admin;
  if r.user_id <> p_actor_user_id and not v_actor_admin then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if r.status not in ('pending_email', 'pending_approval', 'approved') then
    return jsonb_build_object('ok', false, 'reason', 'not_cancellable', 'status', r.status);
  end if;
  perform public.admin_mfa_recovery_close(r.id, 'cancelled',
    case when r.user_id = p_actor_user_id then 'cancelled_by_owner' else 'cancelled_by_admin' end,
    p_actor_user_id);
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'userId', r.user_id,
    'email', (select u.email::text from auth.users u where u.id = r.user_id));
end;
$$;
alter function public.admin_mfa_recovery_cancel(uuid, uuid) owner to postgres;

create function public.admin_mfa_recovery_approve(p_recovery_id uuid, p_actor_user_id uuid, p_cancel_hash text)
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
alter function public.admin_mfa_recovery_approve(uuid, uuid, text) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 4b. Enlace de cancelacion desde el correo de aprobacion (sin sesion, sin TOTP)
--     Solo puede CANCELAR: no aprueba, no ejecuta, no toca roles. Token de 256 bits generado por el
--     backend; aqui solo su SHA-256, ligado a una solicitud; un solo uso (cancel_hash se borra); vale
--     mientras la solicitud pueda ejecutarse (hasta expires_at). Cancelar cierra la solicitud para
--     siempre y toda ejecucion posterior falla (begin_execute / execution_allowed).
-- ---------------------------------------------------------------------------------------------
-- Rota el token (reenvio del aviso). Solo mientras el ultimo aviso no este ENTREGADO: el enlace de un
-- correo ya entregado no se invalida.
create function public.admin_mfa_recovery_set_cancel(p_recovery_id uuid, p_cancel_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_state text;
begin
  if p_recovery_id is null or p_cancel_hash is null or p_cancel_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_argument';
  end if;
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.status <> 'approved' then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  select m.state into v_state from public.admin_mfa_recovery_mail m
   where m.recovery_id = r.id and m.kind = 'approved' order by m.created_at desc, m.id limit 1;
  if v_state = 'delivered' then return jsonb_build_object('ok', false, 'reason', 'already_delivered'); end if;
  update public.admin_mfa_recoveries
     set cancel_hash = p_cancel_hash, cancel_rotations = cancel_rotations + 1 where id = r.id;
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'cancelRotation', r.cancel_rotations + 1,
    'email', (select u.email::text from auth.users u where u.id = r.user_id));
end;
$$;
alter function public.admin_mfa_recovery_set_cancel(uuid, text) owner to postgres;

-- El enlace es valido? (solo lectura: pantalla de confirmacion). No revela datos.
create function public.admin_mfa_recovery_cancel_check(p_cancel_hash text)
returns boolean language sql security definer stable set search_path = pg_catalog, public as $$
  select coalesce(p_cancel_hash ~ '^[0-9a-f]{64}$' and exists (
    select 1 from public.admin_mfa_recoveries r
     where r.cancel_hash = p_cancel_hash and r.status in ('approved', 'executing') and r.expires_at > now()
  ), false);
$$;
alter function public.admin_mfa_recovery_cancel_check(text) owner to postgres;

create function public.admin_mfa_recovery_cancel_by_token(p_cancel_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_user uuid;
begin
  if p_cancel_hash is null or p_cancel_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select user_id into v_user from public.admin_mfa_recoveries where cancel_hash = p_cancel_hash;
  if v_user is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  -- Mismo orden de bloqueo que begin_execute: primero el candado de la cuenta, luego la fila.
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery:' || v_user::text, 0));
  select * into r from public.admin_mfa_recoveries
   where cancel_hash = p_cancel_hash and user_id = v_user for update;
  if not found or r.status not in ('approved', 'executing') or r.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  perform public.admin_mfa_recovery_close(r.id, 'cancelled', 'cancelled_by_link', null);
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'userId', r.user_id,
    'email', (select u.email::text from auth.users u where u.id = r.user_id));
end;
$$;
alter function public.admin_mfa_recovery_cancel_by_token(text) owner to postgres;

-- Comprobacion previa a CADA borrado de factor: una cancelacion posterior a begin_execute detiene el
-- resto de la ejecucion (la ventana restante es el instante entre esta consulta y la llamada a Auth).
create function public.admin_mfa_recovery_execution_allowed(p_recovery_id uuid)
returns boolean language sql security definer stable set search_path = pg_catalog, public as $$
  select exists (select 1 from public.admin_mfa_recoveries r where r.id = p_recovery_id and r.status = 'executing');
$$;
alter function public.admin_mfa_recovery_execution_allowed(uuid) owner to postgres;

create function public.admin_mfa_recovery_deny(p_recovery_id uuid, p_actor_user_id uuid, p_reason text)
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
alter function public.admin_mfa_recovery_deny(uuid, uuid, text) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 5. Lecturas: lista para ADMIN y estado del titular
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_recoveries_pending(p_actor_user_id uuid)
returns table (
  out_id uuid, out_user_id uuid, out_username text, out_role text, out_status text,
  out_requested_at timestamptz, out_email_verified_at timestamptz, out_expires_at timestamptz,
  out_approved_at timestamptz, out_notice_state text, out_readiness text
) language plpgsql security definer stable set search_path = pg_catalog, public as $$
begin
  if p_actor_user_id is null
     or not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  return query
    select r.id, r.user_id, p.username, r.role_at_request, r.status, r.requested_at,
           r.email_verified_at, r.expires_at, r.approved_at,
           (select m.state from public.admin_mfa_recovery_mail m where m.recovery_id = r.id and m.kind = 'approved'),
           public.admin_mfa_recovery_readiness(r.id)
      from public.admin_mfa_recoveries r
      left join public.profiles p on p.user_id = r.user_id
     where r.status in ('pending_approval', 'approved', 'executing') and r.expires_at > now() - interval '1 day'
     order by r.requested_at;
end;
$$;
alter function public.admin_mfa_recoveries_pending(uuid) owner to postgres;

create function public.admin_mfa_recovery_current(p_user_id uuid)
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

-- ---------------------------------------------------------------------------------------------
-- 6. Ejecución (patrón de la fase 1: instantánea de ids + borrado exacto + registro idempotente)
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_recovery_begin_execute(p_user_id uuid, p_recovery_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_role text; v_reason text; v_ids uuid[];
begin
  if p_user_id is null or p_recovery_id is null then raise exception 'invalid_argument'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery:' || p_user_id::text, 0));
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  if r.status in ('factors_deleted', 'completed') then
    return jsonb_build_object('ok', true, 'already', true, 'status', r.status, 'recoveryId', r.id);
  end if;
  if r.status = 'executing' then
    -- Reintento: se reutiliza la MISMA instantánea (nunca se vuelve a listar). Rol y correo
    -- deben seguir igual.
    if public.admin_mfa_recovery_email_hash(r.user_id) is distinct from r.email_hash then
      return jsonb_build_object('ok', false, 'reason', 'email_changed');
    end if;
    select ar.role into v_role from public.admin_roles ar where ar.user_id = r.user_id;
    if v_role is distinct from r.role_at_request then return jsonb_build_object('ok', false, 'reason', 'role_changed'); end if;
    return jsonb_build_object('ok', true, 'already', false, 'status', 'executing', 'recoveryId', r.id,
      'factorIds', to_jsonb(r.factor_ids));
  end if;

  v_reason := public.admin_mfa_recovery_readiness(r.id);
  if v_reason <> 'ready' then
    if v_reason in ('expired') then
      perform public.admin_mfa_recovery_close(r.id, 'expired', 'request_expired', null);
    elsif v_reason in ('email_changed', 'role_changed') then
      perform public.admin_mfa_recovery_close(r.id, 'cancelled', v_reason, null);
    end if;
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;

  select coalesce(array_agg(f.id order by f.created_at), '{}') into v_ids
    from auth.mfa_factors f where f.user_id = p_user_id and f.factor_type::text = 'totp';
  if cardinality(v_ids) > 20 then return jsonb_build_object('ok', false, 'reason', 'too_many_factors'); end if;
  update public.admin_mfa_recoveries set status = 'executing', factor_ids = v_ids where id = r.id;
  perform public.admin_mfa_recovery_log(r.id, p_user_id, 'execution_started', p_user_id, cardinality(v_ids)::text);
  return jsonb_build_object('ok', true, 'already', false, 'status', 'executing', 'recoveryId', r.id,
    'factorIds', to_jsonb(v_ids));
end;
$$;
alter function public.admin_mfa_recovery_begin_execute(uuid, uuid) owner to postgres;

create function public.admin_mfa_recovery_record_execution(
  p_recovery_id uuid, p_ok boolean, p_factors_deleted integer, p_error_class text
) returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries;
begin
  if p_recovery_id is null or p_ok is null then raise exception 'invalid_argument'; end if;
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id for update;
  if not found then raise exception 'mfa_recovery_not_found'; end if;
  if r.status in ('factors_deleted', 'completed') then return 'already_recorded'; end if;
  if r.status <> 'executing' then raise exception 'mfa_recovery_not_executing'; end if;
  if p_ok then
    update public.admin_mfa_recoveries
       set status = 'factors_deleted', executed_at = now(),
           factors_deleted = greatest(coalesce(p_factors_deleted, 0), 0), last_error_class = null
     where id = r.id;
    perform public.admin_mfa_recovery_log(r.id, r.user_id, 'factors_deleted', r.user_id,
      greatest(coalesce(p_factors_deleted, 0), 0)::text);
    return 'factors_deleted';
  end if;
  update public.admin_mfa_recoveries
     set execution_attempts = execution_attempts + 1, last_error_class = left(coalesce(p_error_class, 'unknown'), 60)
   where id = r.id;
  perform public.admin_mfa_recovery_log(r.id, r.user_id, 'execution_failed', r.user_id, left(coalesce(p_error_class, 'unknown'), 60));
  return 'failed';
end;
$$;
alter function public.admin_mfa_recovery_record_execution(uuid, boolean, integer, text) owner to postgres;

-- Cierra la recuperación SOLO cuando la sesión acredita (BD, no el cliente) un TOTP verificado NUEVO:
-- aal2 con factor_id de un TOTP verificado del usuario, creado después del borrado y que no figure
-- en ninguna instantánea (de recuperación o de la fase 1).
create function public.admin_mfa_recovery_complete(p_user_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.admin_mfa_recoveries; v_factor uuid; v_aal text; v_created timestamptz; v_role text;
begin
  if p_user_id is null then raise exception 'invalid_argument'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery:' || p_user_id::text, 0));
  select * into r from public.admin_mfa_recoveries
   where user_id = p_user_id and status in ('factors_deleted', 'completed')
   order by requested_at desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_request'); end if;
  if r.status = 'completed' then return jsonb_build_object('ok', true, 'already', true); end if;

  select ar.role into v_role from public.admin_roles ar where ar.user_id = p_user_id;
  if v_role is null then return jsonb_build_object('ok', false, 'reason', 'not_privileged'); end if;
  if p_session_id is null then return jsonb_build_object('ok', false, 'reason', 'new_factor_required'); end if;
  select s.factor_id, s.aal::text into v_factor, v_aal
    from auth.sessions s where s.id = p_session_id and s.user_id = p_user_id;
  if not found or v_aal is distinct from 'aal2' or v_factor is null then
    return jsonb_build_object('ok', false, 'reason', 'new_factor_required');
  end if;
  select f.created_at into v_created from auth.mfa_factors f
   where f.id = v_factor and f.user_id = p_user_id and f.factor_type::text = 'totp' and f.status::text = 'verified';
  if not found then return jsonb_build_object('ok', false, 'reason', 'new_factor_required'); end if;
  if v_factor = any (r.factor_ids)
     or exists (select 1 from public.admin_mfa_recoveries x where x.user_id = p_user_id and v_factor = any (x.factor_ids))
     or exists (select 1 from public.admin_mfa_resets x where x.user_id = p_user_id and v_factor = any (x.factor_ids))
     or v_created <= r.executed_at then
    return jsonb_build_object('ok', false, 'reason', 'new_factor_required');
  end if;
  update public.admin_mfa_recoveries set status = 'completed', completed_at = now() where id = r.id;
  perform public.admin_mfa_recovery_log(r.id, p_user_id, 'completed', p_user_id, null);
  return jsonb_build_object('ok', true, 'already', false, 'recoveryId', r.id,
    'email', (select u.email::text from auth.users u where u.id = p_user_id));
end;
$$;
alter function public.admin_mfa_recovery_complete(uuid, uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 7. Avisos por correo: registro de envío / entrega (sin contenido, sin secretos)
-- ---------------------------------------------------------------------------------------------
-- Devuelve si hay que enviar. 'accepted'/'delivered' → no (idempotente). 'failed' → nuevo intento
-- (la clave del proveedor cambia con el nº de intento). 'pending' → se reintenta con la MISMA clave.
create function public.admin_mfa_recovery_mail_start(p_recovery_id uuid, p_kind text, p_base_key text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare m public.admin_mfa_recovery_mail;
begin
  if p_recovery_id is null or p_kind is null or p_base_key is null then raise exception 'invalid_argument'; end if;
  insert into public.admin_mfa_recovery_mail (recovery_id, kind, idempotency_key)
  values (p_recovery_id, p_kind, p_base_key) on conflict (idempotency_key) do nothing;
  select * into m from public.admin_mfa_recovery_mail where idempotency_key = p_base_key for update;
  if m.recovery_id <> p_recovery_id or m.kind <> p_kind then raise exception 'invalid_argument'; end if;
  if m.state in ('accepted', 'delivered') then
    return jsonb_build_object('shouldSend', false, 'state', m.state);
  end if;
  if m.state = 'failed' then
    update public.admin_mfa_recovery_mail
       set state = 'pending', attempts = attempts + 1, error_class = null, updated_at = now()
     where id = m.id returning * into m;
  end if;
  return jsonb_build_object('shouldSend', true, 'state', m.state,
    'providerKey', left(p_base_key, 100) || ':' || m.attempts::text);
end;
$$;
alter function public.admin_mfa_recovery_mail_start(uuid, text, text) owner to postgres;

create function public.admin_mfa_recovery_mail_result(
  p_base_key text, p_accepted boolean, p_provider_message_id text, p_error_class text
) returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare m public.admin_mfa_recovery_mail; v_user uuid;
begin
  select * into m from public.admin_mfa_recovery_mail where idempotency_key = p_base_key for update;
  if not found then return 'unknown'; end if;
  if m.state = 'delivered' then return m.state; end if; -- nunca se degrada una entrega confirmada
  if p_accepted then
    update public.admin_mfa_recovery_mail
       set state = case when m.state = 'delivered' then m.state else 'accepted' end,
           provider_message_id = left(p_provider_message_id, 120), error_class = null, updated_at = now()
     where id = m.id;
  else
    update public.admin_mfa_recovery_mail
       set state = 'failed', error_class = left(coalesce(p_error_class, 'unknown'), 60), updated_at = now()
     where id = m.id;
  end if;
  select r.user_id into v_user from public.admin_mfa_recoveries r where r.id = m.recovery_id;
  perform public.admin_mfa_recovery_log(m.recovery_id, v_user, 'mail_state', null,
    m.kind || ':' || case when p_accepted then 'accepted' else 'failed' end);
  return case when p_accepted then 'accepted' else 'failed' end;
end;
$$;
alter function public.admin_mfa_recovery_mail_result(text, boolean, text, text) owner to postgres;

-- Evento verificado del proveedor (webhook firmado). Solo 'delivered' y fallos cambian el estado;
-- abrir o hacer clic NO se interpreta como lectura ni como nada más.
create function public.admin_mfa_recovery_mail_event(p_provider_message_id text, p_event text)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare m public.admin_mfa_recovery_mail; v_user uuid;
begin
  if p_provider_message_id is null or p_event is null then raise exception 'invalid_argument'; end if;
  select * into m from public.admin_mfa_recovery_mail
   where provider_message_id = p_provider_message_id order by created_at desc limit 1 for update;
  if not found then return 'unknown_message'; end if;
  select r.user_id into v_user from public.admin_mfa_recoveries r where r.id = m.recovery_id;
  if p_event = 'delivered' then
    if m.state = 'delivered' then return 'delivered'; end if;
    update public.admin_mfa_recovery_mail set state = 'delivered', delivered_at = now(), error_class = null,
           updated_at = now() where id = m.id;
    perform public.admin_mfa_recovery_log(m.recovery_id, v_user, 'mail_state', null, m.kind || ':delivered');
    return 'delivered';
  elsif p_event in ('bounced', 'failed', 'suppressed') then
    if m.state = 'delivered' then return 'delivered'; end if;
    update public.admin_mfa_recovery_mail set state = 'failed', error_class = left(p_event, 60), updated_at = now()
     where id = m.id;
    perform public.admin_mfa_recovery_log(m.recovery_id, v_user, 'mail_state', null, m.kind || ':' || p_event);
    return 'failed';
  end if;
  return 'ignored';
end;
$$;
alter function public.admin_mfa_recovery_mail_event(text, text) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 8. Permisos: nada ejecutable por clientes; solo service_role (backend de confianza)
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.admin_mfa_recoveries_guard() from public, anon, authenticated, service_role;
revoke execute on function public.admin_mfa_recovery_append_only() from public, anon, authenticated, service_role;
revoke execute on function public.admin_mfa_recovery_log(uuid, uuid, text, uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.admin_mfa_recovery_email_hash(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.admin_mfa_recovery_close(uuid, text, text, uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.admin_mfa_recovery_ready_at(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.admin_mfa_recovery_readiness(uuid) from public, anon, authenticated, service_role;

revoke execute on function public.admin_mfa_recovery_create(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_resend(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_verify(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_cancel(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_approve(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_set_cancel(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_cancel_check(text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_cancel_by_token(text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_execution_allowed(uuid) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_deny(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recoveries_pending(uuid) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_current(uuid) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_begin_execute(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_record_execution(uuid, boolean, integer, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_complete(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_mail_start(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_mail_result(text, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.admin_mfa_recovery_mail_event(text, text) from public, anon, authenticated;

grant execute on function public.admin_mfa_recovery_create(uuid, text) to service_role;
grant execute on function public.admin_mfa_recovery_resend(uuid, text) to service_role;
grant execute on function public.admin_mfa_recovery_verify(uuid, text) to service_role;
grant execute on function public.admin_mfa_recovery_cancel(uuid, uuid) to service_role;
grant execute on function public.admin_mfa_recovery_approve(uuid, uuid, text) to service_role;
grant execute on function public.admin_mfa_recovery_set_cancel(uuid, text) to service_role;
grant execute on function public.admin_mfa_recovery_cancel_check(text) to service_role;
grant execute on function public.admin_mfa_recovery_cancel_by_token(text) to service_role;
grant execute on function public.admin_mfa_recovery_execution_allowed(uuid) to service_role;
grant execute on function public.admin_mfa_recovery_deny(uuid, uuid, text) to service_role;
grant execute on function public.admin_mfa_recoveries_pending(uuid) to service_role;
grant execute on function public.admin_mfa_recovery_current(uuid) to service_role;
grant execute on function public.admin_mfa_recovery_begin_execute(uuid, uuid) to service_role;
grant execute on function public.admin_mfa_recovery_record_execution(uuid, boolean, integer, text) to service_role;
grant execute on function public.admin_mfa_recovery_complete(uuid, uuid) to service_role;
grant execute on function public.admin_mfa_recovery_mail_start(uuid, text, text) to service_role;
grant execute on function public.admin_mfa_recovery_mail_result(text, boolean, text, text) to service_role;
grant execute on function public.admin_mfa_recovery_mail_event(text, text) to service_role;
