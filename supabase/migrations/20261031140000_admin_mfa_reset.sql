-- 9K / MFA FASE 1 — reinicio del MFA al retirar el ÚLTIMO rol privilegiado y enrolamiento NUEVO
-- obligatorio tras una reinvitación. PROPUESTA LOCAL: NO aplicada en ningún entorno.
--
-- Modelo (decisiones de diseño, en una frase cada una):
--   * La autoridad de los privilegios sigue siendo admin_roles. Retirar la fila revoca todo al
--     instante (cada petición privilegiada la consulta); el MFA NO es lo que revoca el acceso.
--   * La retirada y la marca de limpieza MFA se confirman en UNA transacción
--     (admin_remove_member_with_mfa_reset llama a remove_admin_member SIN modificarla): o ocurren
--     las dos cosas o ninguna. remove_admin_member conserva todas sus validaciones y efectos.
--   * La marca guarda una INSTANTÁNEA de los ids de los factores TOTP existentes en ese instante.
--     La limpieza borra EXACTAMENTE esos ids (nunca «todos los factores del usuario»), así que un
--     reintento tardío no puede eliminar un factor configurado después (los ids son únicos).
--   * Al reinvitar (consume_admin_invitation NO se modifica), la activación pasa antes por
--     admin_mfa_activation_check: (1) limpieza pendiente → no se activa; (2) con antecedentes de
--     retirada, la SESIÓN debe estar en aal2 con un factor verificado que NO esté en ninguna
--     instantánea y sea posterior a la última retirada. La identidad del factor sale de
--     auth.sessions.factor_id (la fija Supabase Auth al verificar), no de claims del cliente ni de
--     friendlyName. Una sesión aal2 obtenida con el factor antiguo no acredita el nuevo.
--   * Cambiar de rol (change_admin_member_role) no pasa por aquí: no reinicia MFA.
--
-- Auditoría: la retirada ya queda en admin_team_audit ('access_removed'); la finalización de la
-- limpieza añade 'mfa_reset_completed' (actor = admin que retiró el acceso). El detalle de intentos
-- y fallos vive en admin_mfa_resets (sin secretos, solo clases de error).
-- Forward-only: nada anterior se edita salvo ampliar dos CHECK de admin_team_audit (aditivo).
-- Rollback (solo local/operador): supabase/rollbacks/20261031140000_admin_mfa_reset.rollback.sql

-- ---------------------------------------------------------------------------------------------
-- 1. admin_team_audit: nueva acción 'mfa_reset_completed' (aditivo; actor <> target se conserva)
-- ---------------------------------------------------------------------------------------------
alter table public.admin_team_audit drop constraint admin_team_audit_action_check;
alter table public.admin_team_audit add constraint admin_team_audit_action_check
  check (action in ('role_changed', 'access_removed', 'mfa_reset_completed'));
alter table public.admin_team_audit drop constraint admin_team_audit_shape_check;
alter table public.admin_team_audit add constraint admin_team_audit_shape_check
  check (
    (action = 'role_changed' and new_role is not null and new_role <> old_role)
    or (action in ('access_removed', 'mfa_reset_completed') and new_role is null)
  );

-- ---------------------------------------------------------------------------------------------
-- 2. admin_mfa_resets: limpiezas de MFA (pendientes y completadas). Historial: no se borra.
--    Sin FK a auth.users (igual que admin_team_audit): los uuid se conservan como historial.
-- ---------------------------------------------------------------------------------------------
create table public.admin_mfa_resets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  kind             text not null default 'role_removed',
  status           text not null,
  old_role         text not null,
  requested_by     uuid not null,
  requested_at     timestamptz not null,
  factor_ids       uuid[] not null default '{}',
  completed_at     timestamptz,
  factors_deleted  integer,
  attempts         integer not null default 0,
  last_attempt_at  timestamptz,
  last_error_class text,

  constraint admin_mfa_resets_kind_check check (kind = 'role_removed'),
  constraint admin_mfa_resets_status_check check (status in ('pending', 'completed')),
  constraint admin_mfa_resets_old_role_check check (old_role in ('admin', 'moderator', 'developer')),
  constraint admin_mfa_resets_actor_not_target_check check (requested_by <> user_id),
  constraint admin_mfa_resets_factor_ids_check check (cardinality(factor_ids) <= 20),
  constraint admin_mfa_resets_attempts_check check (attempts >= 0),
  constraint admin_mfa_resets_error_class_check
    check (last_error_class is null or last_error_class ~ '^[a-z0-9_]{1,40}$'),
  constraint admin_mfa_resets_shape_check check (
    (status = 'pending' and completed_at is null and factors_deleted is null
      and cardinality(factor_ids) > 0)
    or (status = 'completed' and completed_at is not null and factors_deleted is not null
      and factors_deleted >= 0 and factors_deleted <= cardinality(factor_ids))
  )
);

create unique index admin_mfa_resets_one_pending_per_user
  on public.admin_mfa_resets (user_id) where status = 'pending';
create index admin_mfa_resets_user_idx on public.admin_mfa_resets (user_id, requested_at desc);

alter table public.admin_mfa_resets owner to postgres;
alter table public.admin_mfa_resets enable row level security;
alter table public.admin_mfa_resets force row level security;
revoke all on public.admin_mfa_resets from public, anon, authenticated, service_role;

comment on table public.admin_mfa_resets is
  'MFA fase 1: limpieza de factores TOTP al retirar el último rol privilegiado. factor_ids es la instantánea (atómica con la retirada) de los factores a invalidar. Solo escriben las funciones SECURITY DEFINER de esta migración.';

-- Inmutabilidad: solo pending -> completed y contadores de intentos; nunca borrar ni editar el resto.
create function public.admin_mfa_resets_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'admin_mfa_resets_append_only' using errcode = '23000';
  end if;
  if old.status = 'completed' then
    raise exception 'admin_mfa_resets_completed_immutable' using errcode = '23000';
  end if;
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
    or new.kind is distinct from old.kind or new.old_role is distinct from old.old_role
    or new.requested_by is distinct from old.requested_by
    or new.requested_at is distinct from old.requested_at
    or new.factor_ids is distinct from old.factor_ids then
    raise exception 'admin_mfa_resets_immutable_field' using errcode = '23000';
  end if;
  return new;
end;
$$;
alter function public.admin_mfa_resets_guard() owner to postgres;
revoke all on function public.admin_mfa_resets_guard() from public, anon, authenticated, service_role;
create trigger admin_mfa_resets_guard before update or delete on public.admin_mfa_resets
  for each row execute function public.admin_mfa_resets_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. Retirada + marca de limpieza en UNA transacción (remove_admin_member no se modifica)
-- ---------------------------------------------------------------------------------------------
create function public.admin_remove_member_with_mfa_reset(
  p_actor_user_id uuid,
  p_target_user_id uuid
)
returns table(
  out_old_role text,
  out_removed_at timestamptz,
  out_revoked_invitations integer,
  out_mfa_reset_id uuid,
  out_mfa_factor_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old_role text;
  v_removed_at timestamptz;
  v_revoked integer;
  v_ids uuid[];
  v_reset_id uuid;
begin
  -- Todas las validaciones (actor ADMIN bajo el lock, actor <> target, miembro existente, último
  -- ADMIN, revocación de invitaciones, auditoría 'access_removed') son las de remove_admin_member:
  -- cualquier rechazo lanza y revierte TODA esta función.
  select r.out_old_role, r.out_removed_at, r.out_revoked_invitations
    into v_old_role, v_removed_at, v_revoked
    from public.remove_admin_member(p_actor_user_id, p_target_user_id) r
    limit 1;

  -- Instantánea atómica con la retirada: ids de los TOTP existentes AHORA. Un factor creado después
  -- no está en la lista y nunca será borrado por esta operación (ni por sus reintentos).
  v_ids := coalesce(
    array(
      select f.id from auth.mfa_factors f
       where f.user_id = p_target_user_id and f.factor_type::text = 'totp'
       order by f.created_at, f.id
    ),
    '{}'::uuid[]
  );

  insert into public.admin_mfa_resets
    (user_id, status, old_role, requested_by, requested_at, factor_ids, completed_at, factors_deleted)
  values (
    p_target_user_id,
    case when cardinality(v_ids) = 0 then 'completed' else 'pending' end,
    v_old_role, p_actor_user_id, v_removed_at, v_ids,
    case when cardinality(v_ids) = 0 then v_removed_at end,
    case when cardinality(v_ids) = 0 then 0 end
  )
  returning id into v_reset_id;

  return query select v_old_role, v_removed_at, v_revoked, v_reset_id, cardinality(v_ids);
end;
$$;
alter function public.admin_remove_member_with_mfa_reset(uuid, uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 4. Limpieza pendiente de un usuario (solo los ids de su instantánea)
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_pending_reset(p_user_id uuid)
returns table(out_reset_id uuid, out_factor_ids uuid[])
language plpgsql security definer stable
set search_path = pg_catalog, public as $$
begin
  if p_user_id is null then raise exception 'invalid_argument'; end if;
  return query
    select r.id, r.factor_ids from public.admin_mfa_resets r
     where r.user_id = p_user_id and r.status = 'pending';
end;
$$;
alter function public.admin_mfa_pending_reset(uuid) owner to postgres;

-- Resultado de un intento de limpieza. Idempotente: si ya estaba completada no hace nada.
create function public.admin_mfa_reset_record(
  p_reset_id uuid,
  p_ok boolean,
  p_factors_deleted integer,
  p_error_class text
)
returns text
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.admin_mfa_resets%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_reset_id is null or p_ok is null then raise exception 'invalid_argument'; end if;
  select * into v from public.admin_mfa_resets where id = p_reset_id for update;
  if not found then raise exception 'reset_not_found'; end if;
  if v.status = 'completed' then return 'completed'; end if;

  if p_ok then
    if p_factors_deleted is null or p_factors_deleted < 0
      or p_factors_deleted > cardinality(v.factor_ids) then
      raise exception 'invalid_argument';
    end if;
    update public.admin_mfa_resets
       set status = 'completed', completed_at = v_now, factors_deleted = p_factors_deleted,
           attempts = attempts + 1, last_attempt_at = v_now, last_error_class = null
     where id = p_reset_id;
    insert into public.admin_team_audit (action, actor_user_id, target_user_id, old_role, new_role, created_at)
      values ('mfa_reset_completed', v.requested_by, v.user_id, v.old_role, null, v_now);
    return 'completed';
  end if;

  update public.admin_mfa_resets
     set attempts = attempts + 1, last_attempt_at = v_now,
         last_error_class = case
           when p_error_class is not null and p_error_class ~ '^[a-z0-9_]{1,40}$' then p_error_class
           else 'cleanup_failed' end
   where id = p_reset_id;
  return 'pending';
end;
$$;
alter function public.admin_mfa_reset_record(uuid, boolean, integer, text) owner to postgres;

-- Lista para el panel (solo ADMIN): quién tiene el autenticador pendiente de restablecer.
create function public.admin_mfa_cleanups_pending(p_actor_user_id uuid)
returns table(
  out_user_id uuid,
  out_old_role text,
  out_requested_at timestamptz,
  out_attempts integer,
  out_last_error_class text,
  out_factor_count integer,
  out_username text,
  out_email text
)
language plpgsql security definer stable
set search_path = pg_catalog, public as $$
begin
  if p_actor_user_id is null then raise exception 'invalid_argument'; end if;
  if not exists (
    select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'admin'
  ) then
    raise exception 'actor_not_admin';
  end if;
  return query
    select r.user_id, r.old_role, r.requested_at, r.attempts, r.last_error_class,
           cardinality(r.factor_ids), p.username, u.email::text
      from public.admin_mfa_resets r
      left join public.profiles p on p.user_id = r.user_id
      left join auth.users u on u.id = r.user_id
     where r.status = 'pending'
     order by r.requested_at;
end;
$$;
alter function public.admin_mfa_cleanups_pending(uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 5. Comprobación previa a la activación de una invitación (solo LECTURA)
--    allowed:true  → no hay antecedentes (primera invitación, flujo normal) o la sesión acredita un
--                    factor NUEVO verificado en aal2.
--    mfa_cleanup_pending  → hay una limpieza pendiente: no se activa hasta resolverla.
--    mfa_reenroll_required → hay antecedentes y la sesión no acredita un factor nuevo.
-- ---------------------------------------------------------------------------------------------
create function public.admin_mfa_activation_check(p_user_id uuid, p_session_id uuid)
returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, public as $$
declare
  v_pending uuid;
  v_factor uuid;
  v_aal text;
  v_created timestamptz;
begin
  if p_user_id is null then raise exception 'invalid_argument'; end if;

  select r.id into v_pending from public.admin_mfa_resets r
   where r.user_id = p_user_id and r.status = 'pending';
  if found then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_cleanup_pending', 'resetId', v_pending);
  end if;

  if not exists (select 1 from public.admin_mfa_resets r where r.user_id = p_user_id) then
    return jsonb_build_object('allowed', true, 'reason', 'no_reset_history');
  end if;

  if p_session_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_reenroll_required');
  end if;

  -- Factor con el que la SESIÓN alcanzó aal2 (lo registra Supabase Auth, no el cliente).
  select s.factor_id, s.aal::text into v_factor, v_aal
    from auth.sessions s where s.id = p_session_id and s.user_id = p_user_id;
  if not found or v_aal is distinct from 'aal2' or v_factor is null then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_reenroll_required');
  end if;

  select f.created_at into v_created from auth.mfa_factors f
   where f.id = v_factor and f.user_id = p_user_id
     and f.factor_type::text = 'totp' and f.status::text = 'verified';
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_reenroll_required');
  end if;

  -- (a) El factor no puede estar en ninguna instantánea (identidad, no reloj).
  if exists (
    select 1 from public.admin_mfa_resets r
     where r.user_id = p_user_id and v_factor = any (r.factor_ids)
  ) then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_reenroll_required');
  end if;

  -- (b) Defensa en profundidad, en dirección SEGURA: un factor anterior a la última retirada se
  --     rechaza aunque no estuviera en la instantánea (carrera en el mismo instante de la retirada).
  if exists (
    select 1 from public.admin_mfa_resets r
     where r.user_id = p_user_id and v_created <= r.requested_at
  ) then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_reenroll_required');
  end if;

  return jsonb_build_object('allowed', true, 'reason', 'new_factor_verified');
end;
$$;
alter function public.admin_mfa_activation_check(uuid, uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 6. EXECUTE: solo service_role
-- ---------------------------------------------------------------------------------------------
revoke all on function public.admin_remove_member_with_mfa_reset(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_mfa_pending_reset(uuid) from public, anon, authenticated;
revoke all on function public.admin_mfa_reset_record(uuid, boolean, integer, text) from public, anon, authenticated;
revoke all on function public.admin_mfa_cleanups_pending(uuid) from public, anon, authenticated;
revoke all on function public.admin_mfa_activation_check(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_remove_member_with_mfa_reset(uuid, uuid) to service_role;
grant execute on function public.admin_mfa_pending_reset(uuid) to service_role;
grant execute on function public.admin_mfa_reset_record(uuid, boolean, integer, text) to service_role;
grant execute on function public.admin_mfa_cleanups_pending(uuid) to service_role;
grant execute on function public.admin_mfa_activation_check(uuid, uuid) to service_role;

-- remove_admin_member deja de ser invocable directamente: el único camino de retirada es la función
-- de arriba, de modo que NINGUNA retirada puede omitir la marca de limpieza MFA. La función de
-- retirada la sigue llamando (SECURITY DEFINER, propietario postgres).
revoke execute on function public.remove_admin_member(uuid, uuid) from service_role;
