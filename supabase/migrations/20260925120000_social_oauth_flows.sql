-- social_oauth_flows: la autorización OAuth VIGENTE de cada proveedor social (Bloque 8B).
--
-- Es infraestructura EFÍMERA de capability, NO un audit log. Una sola fila por proveedor
-- (provider es la PK): iniciar un flujo nuevo del mismo proveedor SOBRESCRIBE la fila, y con
-- ello invalida el flujo anterior ("la autorización más reciente gana"). Por eso no hay
-- limpieza, cron ni índices adicionales: la tabla tiene como máximo 2 filas.
--
-- Ciclo de vida (lo ejecuta el servidor con service_role; ver src/lib/social-oauth-flow.ts):
--   * crear/reemplazar: un único upsert por provider que fija nonce_hash, admin_user_id,
--     created_at, expires_at y pone consumed_at = NULL.
--   * reclamar: un único UPDATE condicional (provider, nonce_hash, consumed_at IS NULL,
--     expires_at > ahora) que fija consumed_at y devuelve admin_user_id. Una sola sentencia
--     sobre una sola fila: es atómica sin transacción ni RPC.
--
-- Solo se guarda el hash SHA-256 (hex) del nonce: nunca el nonce, el `state`, el code ni
-- tokens. admin_user_id es el ADMIN (AAL2) verificado server-side que autorizó el inicio; el
-- `state` que viaja por la URL no contiene ninguna identidad.
--
-- admin_user_id -> auth.users ON DELETE CASCADE: la fila es efímera; si se borra la cuenta,
-- desaparece su flujo pendiente (y su callback queda inválido) sin bloquear el borrado.
--
-- SEGURIDAD: mismo patrón que el resto de tablas privilegiadas -- RLS activado y FORZADO, sin
-- ninguna policy, sin acceso para PUBLIC/anon/authenticated. Solo service_role, con los
-- privilegios mínimos que usa el módulo (SELECT, INSERT, UPDATE; el upsert exige los tres).

create table public.social_oauth_flows (
  provider       text primary key,
  nonce_hash     text        not null,
  admin_user_id  uuid        not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,

  constraint social_oauth_flows_provider_check
    check (provider in ('instagram', 'tiktok')),
  -- SHA-256 en hexadecimal minúsculas (64 caracteres).
  constraint social_oauth_flows_nonce_hash_format
    check (nonce_hash ~ '^[0-9a-f]{64}$'),
  constraint social_oauth_flows_expiry_after_creation
    check (expires_at > created_at),
  constraint social_oauth_flows_consumed_after_creation
    check (consumed_at is null or consumed_at >= created_at)
);

comment on table public.social_oauth_flows is
  'Autorización OAuth vigente por proveedor social (una fila por provider). Capability efímera, no un audit log. Solo hash del nonce; nunca tokens. Acceso exclusivo server-side (service_role).';
comment on column public.social_oauth_flows.nonce_hash is
  'SHA-256 hex minúsculas del nonce del state (no el nonce en claro).';
comment on column public.social_oauth_flows.admin_user_id is
  'ADMIN (AAL2 verificado server-side) que autorizó el inicio. ON DELETE CASCADE: el flujo es efímero.';
comment on column public.social_oauth_flows.consumed_at is
  'NULL mientras el flujo no se ha reclamado. Un nuevo inicio del mismo proveedor lo vuelve a poner a NULL.';

alter table public.social_oauth_flows enable row level security;
alter table public.social_oauth_flows force row level security;

revoke all on table public.social_oauth_flows from public;
revoke all on table public.social_oauth_flows from anon;
revoke all on table public.social_oauth_flows from authenticated;
-- Supabase concede por defecto TODOS los privilegios a service_role sobre las tablas nuevas
-- de `public` (incluidos TRUNCATE, REFERENCES y TRIGGER; ya ocurrió con public.profiles).
-- Se revoca todo y se concede solo lo necesario.
revoke all on table public.social_oauth_flows from service_role;
grant select, insert, update on table public.social_oauth_flows to service_role;
