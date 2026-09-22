-- admin_invitations: mecanismo de concesión de roles privilegiados (ADMIN/MODERATOR)
-- para Upmina Web, incluido el bootstrap del PRIMER admin. admin_roles (ver
-- supabase/migrations/20260922120000_admin_roles.sql) sigue siendo la única fuente de
-- verdad de autorización; esta tabla solo resuelve "quién puede insertar una fila en
-- admin_roles, y en qué condiciones", sin depender de que ya exista un admin previo.
--
-- El token de invitación nunca se guarda en claro: solo su hash SHA-256 (token_hash,
-- calculado por el backend antes de insertar/consultar). Cada invitación es de un solo
-- uso. bootstrap_admin (la invitación especial que crea el PRIMER admin) solo puede
-- prosperar mientras admin_roles no contenga ya ningún 'admin' — garantizado DENTRO de
-- la misma transacción que la consume (ver consume_admin_invitation más abajo), nunca
-- mediante un SELECT previo hecho desde el backend Vercel.

create table if not exists public.admin_invitations (
  token_hash      text primary key,
  role            text not null check (role in ('admin', 'moderator')),
  invitation_type text not null check (invitation_type in ('bootstrap_admin', 'standard')),
  created_by      uuid references auth.users(id) on delete set null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  consumed_at     timestamptz,
  consumed_by     uuid references auth.users(id) on delete set null,

  -- bootstrap_admin: SIEMPRE concede 'admin' y SIEMPRE created_by NULL (la genera un
  -- script local antes de que exista ningún admin humano que pueda figurar como
  -- creador). standard: SIEMPRE tiene un creador (un ADMIN ya autenticado); su role
  -- puede ser 'admin' o 'moderator'. Ninguna otra combinación es representable en DB.
  constraint admin_invitations_bootstrap_shape check (
    (invitation_type = 'bootstrap_admin' and role = 'admin' and created_by is null)
    or
    (invitation_type = 'standard' and created_by is not null)
  )
);

comment on table public.admin_invitations is
  'Invitaciones de un solo uso para conceder admin_roles (bootstrap del primer ADMIN e invitaciones futuras). Solo se guarda el hash del token. Acceso exclusivamente server-side (service_role) vía consume_admin_invitation.';
comment on column public.admin_invitations.token_hash is
  'SHA-256 (hex) del token de invitación. El token en claro nunca se persiste.';
comment on column public.admin_invitations.invitation_type is
  'bootstrap_admin: crea el PRIMER admin, sin creador humano, solo válida mientras no exista ya ningún admin. standard: emitida por un ADMIN ya autenticado (created_by obligatorio).';
comment on column public.admin_invitations.consumed_by is
  'user_id (ya verificado por JWT, aal2) que consumió la invitación. NULL hasta que se consume.';

-- Protección contra acceso desde cliente: ni siquiera lectura de invitaciones propias.
alter table public.admin_invitations enable row level security;
alter table public.admin_invitations force row level security;

revoke all on table public.admin_invitations from public;
revoke all on table public.admin_invitations from anon;
revoke all on table public.admin_invitations from authenticated;
-- Sin DELETE: el historial de invitaciones consumidas/expiradas se conserva a propósito
-- (auditoría de quién y cuándo se concedió cada rol). Sin SELECT/UPDATE/INSERT para
-- nadie salvo service_role.
grant select, insert, update on table public.admin_invitations to service_role;

-- Concesión atómica de un rol privilegiado a partir de una invitación válida. SOLO
-- invocable por service_role (ver GRANT/REVOKE al final); el backend Vercel es
-- responsable de verificar JWT + aal2 ANTES de llamar a esta función y de derivar
-- p_user_id EXCLUSIVAMENTE de las claims ya verificadas (nunca del cuerpo del request).
-- Esta función no conoce MFA ni sesiones: solo sabe "un user_id ya autenticado consume
-- este token".
--
-- SECURITY DEFINER: se ejecuta con los privilegios de quien la creó (el rol que aplica
-- las migraciones, típicamente `postgres` en Supabase), NO con los de quien la invoca
-- (service_role, que solo tiene EXECUTE). `admin_invitations` tiene FORCE ROW LEVEL
-- SECURITY sin ninguna policy: esto bloquea incluso al OWNER de la tabla salvo que ese
-- rol tenga el atributo BYPASSRLS (o sea superusuario). En los proyectos Supabase el
-- rol `postgres` que ejecuta las migraciones tiene BYPASSRLS, por lo que esta función
-- puede leer/escribir admin_invitations pese al FORCE RLS. Esto DEBE verificarse tras
-- aplicar esta migración (`select rolname, rolbypassrls from pg_roles where rolname =
-- (select rolname from pg_roles r join pg_proc p on p.proowner = r.oid where p.proname
-- = 'consume_admin_invitation')`), no asumirse en silencio.
--
-- Orden exacto (no reordenar sin volver a razonar la concurrencia):
--   1. Bloquea la fila de la invitación (FOR UPDATE) — serializa dos consumos del mismo
--      token.
--   2. Valida existencia / no consumida / no expirada.
--   3. SOLO si es bootstrap_admin, adquiere el advisory lock dedicado
--      ('admin_bootstrap'): una invitación 'standard' nunca compite por este lock ni
--      paga su coste de serialización.
--   4. TRAS adquirir el lock, vuelve a comprobar si ya existe un admin. Comprobarlo
--      ANTES del lock no basta: dos transacciones concurrentes verían ambas 0 admins si
--      la comprobación no está serializada por el advisory lock.
--   5. Marca la invitación como consumida e inserta admin_roles en la MISMA
--      transacción: si el INSERT falla (p. ej. el usuario ya tiene un rol), toda la
--      función aborta y el UPDATE de consumo también se revierte — nunca queda una
--      invitación consumida sin rol concedido.
--
-- Nota deliberada: NO existe ningún índice/constraint que limite globalmente
-- admin_roles a una sola fila con role='admin'. La única invariante que este diseño
-- protege es "bootstrap_admin solo prospera mientras existen 0 admins" (pasos 3-4
-- arriba); un ADMIN futuro podrá invitar a otros ADMIN vía invitation_type='standard'
-- sin que ninguna restricción de esquema lo bloquee.
create or replace function public.consume_admin_invitation(
  p_token_hash text,
  p_user_id uuid
)
returns table(granted_role text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.admin_invitations%rowtype;
begin
  select * into v_row
    from public.admin_invitations
    where token_hash = p_token_hash
    for update;

  if not found then
    raise exception 'invitation_not_found';
  end if;

  if v_row.consumed_at is not null then
    raise exception 'invitation_already_consumed';
  end if;

  if v_row.expires_at < now() then
    raise exception 'invitation_expired';
  end if;

  if v_row.invitation_type = 'bootstrap_admin' then
    -- Serializa exclusivamente el caso bootstrap: una invitación 'standard' (emitida
    -- por un admin ya existente) nunca necesita ni adquiere este lock.
    perform pg_advisory_xact_lock(hashtext('admin_bootstrap'));

    if exists (
      select 1 from public.admin_roles ar where ar.role = 'admin'
    ) then
      raise exception 'admin_already_exists';
    end if;
  end if;

  update public.admin_invitations
    set consumed_at = now(), consumed_by = p_user_id
    where token_hash = p_token_hash;

  insert into public.admin_roles (user_id, role, granted_by)
    values (p_user_id, v_row.role, v_row.created_by);

  return query select v_row.role;
end;
$$;

comment on function public.consume_admin_invitation(text, uuid) is
  'Consume una admin_invitations de forma atómica y concede el rol en admin_roles. SOLO service_role. p_user_id debe venir de un JWT ya verificado con aal2 (responsabilidad del backend, no de esta función).';

revoke all on function public.consume_admin_invitation(text, uuid) from public;
revoke execute on function public.consume_admin_invitation(text, uuid) from anon;
revoke execute on function public.consume_admin_invitation(text, uuid) from authenticated;
grant execute on function public.consume_admin_invitation(text, uuid) to service_role;
