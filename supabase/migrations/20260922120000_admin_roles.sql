-- admin_roles: fuente de verdad de autorización privilegiada (ADMIN/MODERATOR) para
-- Upmina Web. La ausencia de fila para un user_id significa USER (sin privilegios): no
-- se inserta ninguna fila para usuarios normales, ni existe ningún valor "user" en la
-- columna `role`.
--
-- SEGURIDAD: RLS activado y FORZADO, sin ninguna policy — anon y authenticated no
-- pueden leer ni escribir esta tabla bajo ninguna circunstancia. El rol se resuelve
-- EXCLUSIVAMENTE server-side (ver src/lib/admin-auth.ts); nunca mediante una policy que
-- permita a un usuario consultar su propio rol. Se revocan además todos los privilegios
-- a anon/authenticated/PUBLIC (defensa en profundidad frente a los grants por defecto
-- de Supabase en `public`), mismo patrón que ya usa social_connections. Solo
-- service_role puede leer/escribir.

create table if not exists public.admin_roles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('admin', 'moderator')),
  granted_by  uuid references auth.users(id) on delete set null,
  granted_at  timestamptz not null default now()
);

comment on table public.admin_roles is
  'Roles privilegiados (admin/moderator) de Upmina Web. Ausencia de fila = USER. Solo acceso server-side (service_role).';
comment on column public.admin_roles.role is
  'admin o moderator. No existe el valor "user": la ausencia de fila ya significa USER.';
comment on column public.admin_roles.granted_by is
  'user_id de quien concedió el rol. ON DELETE SET NULL: si esa cuenta se elimina después, la fila y su historial de concesión permanecen (solo se pierde la referencia a quién lo concedió), en vez de borrar en cascada un rol ya vigente. NULL también para el bootstrap del primer admin, que no tiene un concedente.';

-- Protección contra acceso desde cliente: ni siquiera lectura del propio rol.
alter table public.admin_roles enable row level security;
alter table public.admin_roles force row level security;

revoke all on table public.admin_roles from public;
revoke all on table public.admin_roles from anon;
revoke all on table public.admin_roles from authenticated;
grant select, insert, update, delete on table public.admin_roles to service_role;
