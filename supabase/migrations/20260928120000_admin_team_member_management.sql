-- Bloque 9F: gestión de miembros del equipo (listar, cambiar rol, quitar acceso) con auditoría.
-- Migración NUEVA: no modifica ninguna migración anterior (9B y 9D quedan intactas).
--
-- Por qué RPC: tras 9B, service_role solo puede LEER admin_roles y no tiene UPDATE/DELETE. Toda
-- mutación de roles va por funciones SECURITY DEFINER (owner postgres) que solo service_role puede
-- ejecutar. El backend verifica JWT + aal2 + capacidad team_admin y pasa el actor derivado del JWT;
-- cada función además exige que ese actor SIGA siendo ADMIN bajo el lock.
--
-- Reglas de 9B que se cumplen aquí:
--   * upmina_lock_admin_roles() se toma PRIMERO (antes de cualquier consulta o FOR UPDATE). La
--     única validación previa al lock es pura (parámetros nulos / rol fuera de la lista).
--   * No se captura ninguna excepción (ni last_admin_protected / SQLSTATE 23001): los triggers de
--     admin_roles siguen siendo la autoridad. Aquí la prohibición actor = target es una defensa
--     ADICIONAL; el guard del último ADMIN no se sustituye ni se neutraliza.
--
-- Orden de las mutaciones: (1) validación pura, (2) lock, (3) actor ADMIN, (4) actor <> target,
-- (5) target FOR UPDATE, (6) validar operación, (7) mutar admin_roles, (8) si el target ERA ADMIN y
-- deja de serlo: revocar sus invitaciones STANDARD pendientes, (9) auditoría, (10) resultado. Todo
-- en UNA transacción (la de la llamada RPC).
--
-- Errores (RAISE EXCEPTION sin SQLSTATE propio => P0001; los literales son un contrato con
-- src/lib/admin-team-members.ts, que los reconoce como lista cerrada):
--   actor_not_admin, self_change_not_allowed, member_not_found, role_unchanged, invalid_role,
--   invalid_argument. Además pueden propagarse los de 9B (last_admin_protected, 23001).

-- 1. Auditoría de membresía --------------------------------------------------------------------
-- SIN FK a auth.users a propósito: los UUID permanecen como historial aunque la cuenta desaparezca
-- y ninguna acción referencial (SET NULL) modifica jamás una fila de auditoría. No guarda email ni
-- username. No es un audit log general del producto: solo cambios de membresía/rol de 9F.
create table public.admin_team_audit (
  id             uuid primary key default gen_random_uuid(),
  action         text not null,
  actor_user_id  uuid not null,
  target_user_id uuid not null,
  old_role       text not null,
  new_role       text,
  created_at     timestamptz not null default now(),

  constraint admin_team_audit_action_check
    check (action in ('role_changed', 'access_removed')),
  constraint admin_team_audit_old_role_check
    check (old_role in ('admin', 'moderator', 'developer')),
  constraint admin_team_audit_new_role_check
    check (new_role is null or new_role in ('admin', 'moderator', 'developer')),
  constraint admin_team_audit_actor_not_target_check
    check (actor_user_id <> target_user_id),
  constraint admin_team_audit_shape_check
    check (
      (action = 'role_changed' and new_role is not null and new_role <> old_role)
      or (action = 'access_removed' and new_role is null)
    )
);

comment on table public.admin_team_audit is
  'Historial append-only de cambios de membresía/rol del equipo (Bloque 9F). Sin FK a auth.users: los UUID se conservan aunque la cuenta desaparezca. Solo escriben las RPC SECURITY DEFINER change_admin_member_role y remove_admin_member. Sin acceso directo para ningún rol de API.';
comment on column public.admin_team_audit.action is
  'role_changed (old_role -> new_role) o access_removed (old_role -> sin rol privilegiado, new_role NULL).';
comment on column public.admin_team_audit.actor_user_id is
  'ADMIN que realizó la operación (verificado por JWT + aal2 y reconfirmado ADMIN bajo el lock). Sin FK.';
comment on column public.admin_team_audit.target_user_id is
  'Miembro afectado. Sin FK.';

alter table public.admin_team_audit enable row level security;
alter table public.admin_team_audit force row level security;

-- Inmutabilidad: UPDATE, DELETE y TRUNCATE siempre fallan (además de no tener privilegios).
create or replace function public.admin_team_audit_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'admin_team_audit_immutable' using errcode = '23001';
end;
$$;

create trigger admin_team_audit_no_update_delete
  before update or delete on public.admin_team_audit
  for each row execute function public.admin_team_audit_immutable();

create trigger admin_team_audit_no_truncate
  before truncate on public.admin_team_audit
  for each statement execute function public.admin_team_audit_immutable();

-- Privilegios: ningún rol de API (ni service_role) toca la tabla; solo el owner, a través de las
-- RPC definer. REVOKE ALL PRIVILEGES cubre también los default privileges de Supabase.
revoke all privileges on table public.admin_team_audit from public;
revoke all privileges on table public.admin_team_audit from anon;
revoke all privileges on table public.admin_team_audit from authenticated;
revoke all privileges on table public.admin_team_audit from service_role;

revoke all on function public.admin_team_audit_immutable()
  from public, anon, authenticated, service_role;

-- 2. Listado de miembros -----------------------------------------------------------------------
-- Solo miembros privilegiados. Columnas EXPLÍCITAS: nunca metadata, identities, teléfono, tokens,
-- last_sign_in, granted_by ni avatar_path. El email sale de auth.users solo aquí, server-side.
create or replace function public.list_admin_team_members(p_actor_user_id uuid)
returns table(
  out_user_id uuid,
  out_role text,
  out_granted_at timestamptz,
  out_username text,
  out_display_name text,
  out_email text,
  out_is_self boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_actor_user_id is null
     or not exists (
       select 1 from public.admin_roles ar
        where ar.user_id = p_actor_user_id and ar.role = 'admin'
     ) then
    raise exception 'actor_not_admin';
  end if;

  return query
    select ar.user_id,
           ar.role,
           ar.granted_at,
           p.username,
           p.display_name,
           u.email::text,
           (ar.user_id = p_actor_user_id)
      from public.admin_roles ar
      left join public.profiles p on p.user_id = ar.user_id
      left join auth.users u on u.id = ar.user_id
     order by case ar.role when 'admin' then 0 when 'moderator' then 1 else 2 end,
              ar.granted_at,
              ar.user_id;
end;
$$;

comment on function public.list_admin_team_members(uuid) is
  'Lista los miembros privilegiados (user_id, role, granted_at, username, display_name, email, is_self). SOLO service_role (EXECUTE). p_actor_user_id debe venir de un JWT verificado con aal2 y team_admin (responsabilidad del backend); la función además exige que siga siendo ADMIN.';

-- 3. Cambio de rol -----------------------------------------------------------------------------
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

comment on function public.change_admin_member_role(uuid, uuid, text) is
  'Cambia el rol privilegiado de OTRO miembro (admin|moderator|developer) bajo el lock compartido, audita y, si el target dejó de ser ADMIN, revoca sus invitaciones standard pendientes. SOLO service_role (EXECUTE). Rechaza: actor no ADMIN, actor = target, target sin rol, mismo rol, rol inválido. Las protecciones de 9B (last_admin_protected) no se capturan.';

-- 4. Quitar acceso privilegiado ------------------------------------------------------------------
-- No borra la cuenta de auth ni el perfil: solo la fila de admin_roles (el usuario vuelve a USER).
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

comment on function public.remove_admin_member(uuid, uuid) is
  'Quita el acceso privilegiado de OTRO miembro (borra su fila de admin_roles; no toca auth.users ni profiles) bajo el lock compartido, audita y, si era ADMIN, revoca sus invitaciones standard pendientes. SOLO service_role (EXECUTE). Rechaza: actor no ADMIN, actor = target, target sin rol. El guard del último ADMIN de 9B no se captura.';

-- 5. EXECUTE: solo service_role ----------------------------------------------------------------
revoke all on function public.list_admin_team_members(uuid) from public;
revoke execute on function public.list_admin_team_members(uuid) from anon;
revoke execute on function public.list_admin_team_members(uuid) from authenticated;
grant execute on function public.list_admin_team_members(uuid) to service_role;

revoke all on function public.change_admin_member_role(uuid, uuid, text) from public;
revoke execute on function public.change_admin_member_role(uuid, uuid, text) from anon;
revoke execute on function public.change_admin_member_role(uuid, uuid, text) from authenticated;
grant execute on function public.change_admin_member_role(uuid, uuid, text) to service_role;

revoke all on function public.remove_admin_member(uuid, uuid) from public;
revoke execute on function public.remove_admin_member(uuid, uuid) from anon;
revoke execute on function public.remove_admin_member(uuid, uuid) from authenticated;
grant execute on function public.remove_admin_member(uuid, uuid) to service_role;
